import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { type CachedScan, cachedScan, lastKnown } from "./cache";
import { freeChart, marks, spaceBars, waits } from "./charts";
import { measure, size } from "./cli";
import { type Event, readEvents, readSamples, type Sample, sample } from "./history";
import { applyPlan, context, createPlan } from "./ops";
import { defaultTheme, type Theme } from "./scanners";
import { defaultPaths } from "./system";
import { installSystemd } from "./timer";
import { type Category, categories, count, eligible, type Finding, outermost, type Scan } from "./types";

export interface Actions {
  /** Every category last stored, however old, shown while the scan runs. Never acted on. */
  cached: () => Scan | undefined;
  /**
   * Scans the categories past their max age, or all of them without reuse, reporting each as it finishes with its
   * finding count (undefined on failure) and whether it came from the cache.
   */
  load: (
    reuse: boolean,
    done?: (category: Category, findings: number | undefined, cached: boolean) => void,
  ) => Promise<CachedScan>;
  history: () => { samples: Sample[]; events: Event[] };
  apply: (findings: Finding[]) => Promise<string>;
  schedule: () => Promise<string>;
}

export const liveActions: Actions = {
  cached: () => lastKnown(context()),
  load: async (reuse, done) => {
    const ctx = context();
    await sample(ctx.paths).catch(() => undefined);
    return cachedScan(ctx, { reuse, done });
  },
  history: () => {
    const paths = defaultPaths();
    return { samples: readSamples(paths, 30), events: readEvents(paths, 30) };
  },
  apply: async (findings) => {
    const ctx = context();
    const outcome = await applyPlan(createPlan(ctx.paths, findings, ctx.staleDays), ctx);
    return [
      outcome.transaction
        ? `Moved ${size(outcome.bytes)} to trash. Undo with keeper undo ${outcome.transaction}`
        : "Nothing was moved",
      outcome.stale.length ? `${count(outcome.stale.length, "finding")} skipped as changed since the scan` : "",
      outcome.failed.length ? `${count(outcome.failed.length, "finding")} failed, see keeper log` : "",
    ]
      .filter(Boolean)
      .join(". ");
  },
  schedule: async () => {
    await installSystemd(defaultPaths());
    return "Daily keeper run and hourly free space readings scheduled with systemd";
  },
};

const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const palette = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
/**
 * A palette name becomes the terminal's own palette entry, so the colours follow its theme rather than fixed RGB.
 * An unset colour is the terminal's foreground, rather than OpenTUI's fixed white.
 */
const color = (value: string) => {
  const name = value.toLowerCase().replace(/^bright/, "");
  const index = palette.indexOf(name);
  if (index >= 0) return RGBA.fromIndex(index + (name === value.toLowerCase() ? 0 : 8));
  return value || RGBA.defaultForeground();
};
const terminal = color("");
/** Ends a title that does not fit in an ellipsis, so a cut reads as a cut. */
const clip = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text);
/** Each category's state while a scan runs: absent is still scanning, a null count failed. */
type Progress = Partial<Record<Category, { found: number | null; cached: boolean }>>;
const views = ["list", "space", "history"] as const;
type View = (typeof views)[number];
const keys = (showBlocked: boolean) => [
  "j/k move",
  "space select",
  "a all low risk",
  "enter apply",
  `b ${showBlocked ? "hide" : "show"} blocked`,
  "g graphs",
  "r rescan",
  "t schedule",
  "q/esc quit",
];
const two = (n: number) => String(n).padStart(2, "0");
const time = (iso: string | number) => {
  const date = new Date(iso);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};
const stamp = (iso: string | number) => {
  const date = new Date(iso);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time(iso)}`;
};
const weekday = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short" });
const describe = (event: Event) =>
  event.event === "apply"
    ? `moved ${size(event.bytes ?? 0)} to trash`
    : event.event === "purge"
      ? `purge freed ${size(event.bytes ?? 0)}`
      : "undo restored a transaction";
/** Space under this folds into one line, so the bars show where the disk actually went. */
const smallBar = 100 * 1024 ** 2;
const labelWidth = 7;

/** Holds selection only. Every safety rule stays in the scan and apply calls an agent would make. */
export function Wizard({ actions, theme = defaultTheme }: { actions: Actions; theme?: Theme }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  // Below this the category column goes, so the title keeps room to say what the row is.
  const wide = width >= 80;
  // Padding, mark, size and risk columns, then the category column when it shows.
  const titleWidth = width - 2 - 4 - 9 - 7 - (wide ? 14 : 0);
  const [report, setReport] = useState<Scan | undefined>(actions.cached);
  const [fromCache, setFromCache] = useState<Category[]>([]);
  const [history, setHistory] = useState(actions.history);
  const [view, setView] = useState<View>("list");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBlocked, setShowBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState<Progress | undefined>();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!progress) return;
    const timer = setInterval(() => setFrame((n) => n + 1), 80);
    return () => clearInterval(timer);
  }, [progress]);

  const perform = (work: Promise<string | undefined>, reuse = true) => {
    setBusy(true);
    work
      .then(async (done) => {
        setProgress({});
        const fresh = await actions.load(reuse, (category, found, cached) =>
          setProgress((now) => ({ ...now, [category]: { found: found ?? null, cached } })),
        );
        setReport(fresh);
        setFromCache(fresh.cached);
        setHistory(actions.history());
        setMessage(done ?? "");
      })
      .catch((error) => setMessage(`Failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => {
        setBusy(false);
        setProgress(undefined);
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan once on open; perform is recreated each render.
  useEffect(() => perform(Promise.resolve(undefined)), [actions]);

  const all = report?.findings ?? [];
  const open = all.filter(eligible);
  const blocked = all.length - open.length;
  const rows = showBlocked ? [...open, ...all.filter((f) => !eligible(f))] : open;
  const chosen = rows.filter((finding) => selected.has(finding.id));
  const at = Math.min(cursor, Math.max(rows.length - 1, 0));

  // Every view gets the same panel, so switching never moves the lines around it. The explanation keeps two lines
  // because blockers with their next step often wrap.
  const keyLines = Math.ceil(keys(showBlocked).join(" · ").length / Math.max(width - 2, 1));
  const panel = Math.max(3, height - 1 - 2 - 1 - (report?.warnings.length ? 1 : 0) - keyLines);

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy();
    if (key.name === "g") setView((now) => views[(views.indexOf(now) + 1) % views.length] as View);
    if (key.name === "r" && !busy) perform(Promise.resolve("Rescanned everything"), false);
    if (view !== "list") return;
    const current = rows[at];
    if (key.name === "down" || key.name === "j") setCursor(Math.min(at + 1, rows.length - 1));
    if (key.name === "up" || key.name === "k") setCursor(Math.max(at - 1, 0));
    if (key.name === "b") {
      setShowBlocked(!showBlocked);
      setCursor(0);
    }
    if (busy) return;
    if (key.name === "space" && current) {
      if (!eligible(current)) {
        setMessage(`Blocked: ${current.blockers.join("; ") || "report only, nothing to apply"}`);
        return;
      }
      const next = new Set(selected);
      if (!next.delete(current.id)) next.add(current.id);
      setSelected(next);
    }
    if (key.name === "a") {
      // Adds to the selection, so medium-risk rows picked by hand stay picked.
      const low = open.filter((f) => f.risk === "low").map((f) => f.id);
      setSelected(new Set([...selected, ...low]));
      setMessage(low.length ? `Selected ${low.length} low-risk findings` : "No low-risk finding is eligible");
    }
    if (key.name === "return") {
      if (chosen.length) {
        perform(
          actions.apply(chosen).then((done) => {
            setSelected(new Set());
            return done;
          }),
        );
      } else setMessage("Select findings with space or a first");
    }
    if (key.name === "t") perform(actions.schedule());
  });

  const pageSize = panel - (report && !rows.length ? 1 : 0);
  const start = Math.max(0, Math.min(at - pageSize + 1, rows.length - pageSize));
  const active = rows[at];
  const total = outermost(chosen).reduce((sum, finding) => sum + finding.bytes, 0);
  const shown = report ? ` · showing ${time(report.scannedAt)}` : "";
  const scanning = () => {
    const waiting = categories.filter((category) => !progress?.[category]);
    const failed = categories.filter((category) => progress?.[category]?.found === null);
    const reused = categories.filter((category) => progress?.[category]?.cached).length;
    return [
      `${spinner[frame % spinner.length]} Scanning ${categories.length - waiting.length}/${categories.length}${shown}`,
      reused ? `${reused} cached` : "",
      failed.length ? `failed: ${failed.join(", ")}` : "",
      waiting.length ? `waiting on ${waiting.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const idle =
    message ||
    (fromCache.length
      ? `${count(fromCache.length, "category", "categories")} reused from a recent scan · r rescans all`
      : "");
  // One line at the bottom, so the list never moves when a scan starts or ends.
  const status = clip(progress ? scanning() : busy ? `Working${shown}` : idle, width - 2);
  const riskColor = { low: theme.low, medium: theme.medium, high: theme.high };
  const bars = view === "space" ? spaceBars(all) : [];
  const sum = (rows: typeof bars, key: "ready" | "blocked") => rows.reduce((total, bar) => total + bar[key], 0);
  // The graph views explain themselves, so this line holds the space key, or the events the chart marks.
  const plotWidth = Math.max(width - 2 - labelWidth - 2, 2);
  const plotted =
    view === "history" ? freeChart(history.samples, history.events, plotWidth, panel - 2, Date.now(), size) : undefined;
  const explanation =
    view === "list"
      ? active
        ? active.blockers.join("; ") || active.reason
        : ""
      : view === "space"
        ? "█ ready to clean now · ░ waiting on a blocker · b in the list shows each reason"
        : (plotted?.events ?? [])
            .slice(-4)
            .reverse()
            .map((event) => `${marks[event.event]} ${weekday(event.at)} ${time(event.at)}  ${describe(event)}`)
            .join("    ") || "Readings come from every keeper run and, with the timer on, every hour";

  const list = (
    <>
      {report && !rows.length ? (
        <text fg={terminal}>
          {blocked ? `Nothing is eligible. Press b to see ${count(blocked, "blocked finding")}.` : "Nothing to clean."}
        </text>
      ) : null}
      {rows.slice(start, start + pageSize).map((finding, index) => {
        const isCursor = index + start === at;
        const ok = eligible(finding);
        const isSelected = selected.has(finding.id);
        const mark = !ok ? " - " : isSelected ? "[x]" : "[ ]";
        // The cursor row and blocked rows drop the column colours, so the cursor and the dimming read clearly.
        const plain = isCursor || !ok;
        const rowColor = isCursor ? color(theme.cursorText) : ok ? terminal : color(theme.blocked);
        const attributes =
          (isCursor && !theme.cursor ? TextAttributes.INVERSE : 0) | (!ok && !theme.blocked ? TextAttributes.DIM : 0);
        const cell = (value: string) => (plain ? rowColor : color(value));
        return (
          <box
            key={finding.id}
            flexDirection="row"
            backgroundColor={isCursor && theme.cursor ? theme.cursor : undefined}
          >
            <text
              wrapMode="none"
              fg={plain ? rowColor : color(isSelected ? theme.selected : "")}
              attributes={attributes}
              flexShrink={0}
            >
              {mark}{" "}
            </text>
            <text
              wrapMode="none"
              fg={cell(theme.size)}
              attributes={attributes | (plain ? 0 : TextAttributes.BOLD)}
              flexShrink={0}
            >
              {measure(finding).padStart(8)}{" "}
            </text>
            <text wrapMode="none" fg={cell(riskColor[finding.risk])} attributes={attributes} flexShrink={0}>
              {finding.risk.padEnd(7)}
            </text>
            {wide ? (
              <text wrapMode="none" fg={cell(theme.category)} attributes={attributes} flexShrink={0}>
                {finding.category.padEnd(14)}
              </text>
            ) : null}
            <text wrapMode="none" fg={rowColor} attributes={attributes} flexShrink={1}>
              {clip(finding.title, titleWidth)}
            </text>
          </box>
        );
      })}
    </>
  );

  const space = () => {
    if (!bars.length) return <text fg={terminal}>{report ? "No category holds disk worth showing." : "Scanning"}</text>;
    const big = bars.filter((bar) => bar.ready + bar.blocked >= smallBar);
    const reasons = waits(all);
    // Bars first, then why the rest waits, each trimmed to the rows the panel has.
    // Narrow enough that each count stays next to its reason on a wide terminal.
    const reasonWidth = Math.max(Math.min(width - 2, 64) - 15, 1);
    const reasonRows = Math.min(reasons.length, Math.max(panel - big.length - 4, 0));
    const shownBars = big.slice(0, Math.max(panel - 2 - (reasonRows ? reasonRows + 2 : 0), 1));
    const folded = bars.length - shownBars.length;
    const most = Math.max(...shownBars.map((bar) => bar.ready + bar.blocked));
    const room = Math.max(width - 2 - 14 - 16 - 2, 4);
    const cells = (bytes: number) => (bytes > 0 ? Math.max(1, Math.round((bytes / most) * room)) : 0);
    const dim = color(theme.blocked);
    return (
      <>
        <text wrapMode="none" fg={dim} attributes={theme.blocked ? 0 : TextAttributes.DIM}>
          {"".padEnd(14)}
          {"ready".padStart(7)}
          {"waiting".padStart(9)}
        </text>
        {shownBars.map((bar) => {
          const ready = cells(bar.ready);
          const waiting = Math.min(cells(bar.blocked), room - ready);
          return (
            <text key={bar.category} wrapMode="none" fg={terminal}>
              <span fg={color(theme.category)}>{bar.category.padEnd(14)}</span>
              {size(bar.ready).padStart(7)}
              {size(bar.blocked).padStart(9)}
              {"  "}
              <span fg={color(theme.low)}>{"█".repeat(ready)}</span>
              <span fg={dim}>{"░".repeat(waiting)}</span>
            </text>
          );
        })}
        {folded ? (
          <text wrapMode="none" fg={dim} attributes={theme.blocked ? 0 : TextAttributes.DIM}>
            {count(folded, "more category", "more categories")} under {size(smallBar)}
          </text>
        ) : null}
        {reasonRows ? (
          <>
            <text> </text>
            <text wrapMode="none" fg={color(theme.accent)} attributes={TextAttributes.BOLD}>
              {clip("Why it waits", reasonWidth).padEnd(reasonWidth)}
              {"count".padStart(6)}
              {"size".padStart(9)}
            </text>
            {reasons.slice(0, reasonRows).map((wait) => (
              <text key={wait.reason} wrapMode="none" fg={terminal}>
                {clip(wait.reason, reasonWidth).padEnd(reasonWidth)}
                {String(wait.count).padStart(6)}
                {size(wait.bytes).padStart(9)}
              </text>
            ))}
          </>
        ) : null}
      </>
    );
  };

  const headline = () => {
    const last = history.samples.at(-1);
    if (!last) return "";
    const first = plotted ? history.samples.find((sample) => Date.parse(sample.at) >= plotted.start) : undefined;
    const change = first ? last.free - first.free : 0;
    const span = Date.now() - Date.parse(first?.at ?? "");
    const over =
      span >= 2 * 86_400_000
        ? count(Math.round(span / 86_400_000), "day")
        : count(Math.max(1, Math.round(span / 3_600_000)), "hour");
    const since = first ? `, ${change >= 0 ? "up" : "down"} ${size(Math.abs(change))} in ${over}` : "";
    return ` · ${size(last.free)} of ${size(last.size)}${since}`;
  };

  const chart = () => {
    const last = history.samples.at(-1);
    if (!plotted || !last) {
      return (
        <>
          <text fg={terminal}>
            {last ? `${size(last.free)} free of ${size(last.size)} at ${stamp(last.at)}.` : "No readings yet."}
          </text>
          <text fg={terminal}>The chart starts with the second reading.</text>
        </>
      );
    }
    const dim = { fg: terminal, attributes: TextAttributes.DIM };
    const ink = { line: color(theme.accent), grid: terminal, rule: terminal, blank: terminal };
    const markColor = { apply: theme.low, purge: theme.accent, undo: theme.medium };
    return (
      <>
        {plotted.rows.map((row, index) => (
          <text key={`row-${index === 0 ? "top" : index}`} wrapMode="none" fg={terminal}>
            <span {...dim}>{row.label.padStart(labelWidth)} ┤</span>
            {row.runs.map((run) => (
              <span
                key={`run-${run.column}`}
                fg={ink[run.ink]}
                attributes={run.ink === "line" ? 0 : TextAttributes.DIM}
              >
                {run.text}
              </span>
            ))}
          </text>
        ))}
        <text wrapMode="none" fg={terminal}>
          <span {...dim}>
            {"".padStart(labelWidth)} └{"─".repeat(plotWidth)}
          </span>
        </text>
        <text wrapMode="none" fg={terminal}>
          {"".padStart(labelWidth + 2)}
          {plotted.axis.map((cell) => (
            <span
              key={`axis-${cell.column}`}
              fg={cell.kind ? color(markColor[cell.kind]) : terminal}
              attributes={cell.kind ? 0 : TextAttributes.DIM}
            >
              {cell.text}
            </span>
          ))}
        </text>
      </>
    );
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none" fg={color(theme.accent)} attributes={TextAttributes.BOLD}>
        {clip(
          view === "list"
            ? `keeper · ${open.length} eligible, ${blocked} blocked · ${chosen.length ? `${size(total)} selected, uncompressed` : "nothing selected"}`
            : view === "space"
              ? `keeper · space · ${size(sum(bars, "ready"))} ready now, ${size(sum(bars, "blocked"))} waiting`
              : `keeper · free space${headline()}`,
          width - 2,
        )}
      </text>
      <box flexDirection="column" height={panel} flexShrink={0}>
        {view === "list" ? list : view === "space" ? space() : chart()}
      </box>
      <box height={2} flexShrink={0}>
        <text fg={terminal}>{explanation}</text>
      </box>
      <text wrapMode="none" fg={busy ? color(theme.accent) : terminal}>
        {status}
      </text>
      {report?.warnings.length ? (
        <text wrapMode="none" fg={color(theme.high)}>
          {clip(`Scan warnings: ${report.warnings.join("; ")}`, width - 2)}
        </text>
      ) : null}
      {/* One text per binding, so a narrow terminal wraps between bindings rather than inside one. */}
      <box flexDirection="row" flexWrap="wrap">
        {keys(showBlocked).map((binding, index, all) => (
          <text key={binding} wrapMode="none" fg={terminal} attributes={TextAttributes.DIM}>
            {binding}
            {index < all.length - 1 ? " · " : ""}
          </text>
        ))}
      </box>
    </box>
  );
}
