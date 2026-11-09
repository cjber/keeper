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
import { bulkEligible, type Category, categories, count, eligible, type Finding, outermost, type Scan } from "./types";

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
    const ctx = { ...context(), sizeBlocked: true };
    await sample(ctx.paths).catch(() => undefined);
    return cachedScan(ctx, { reuse, done });
  },
  history: () => {
    const paths = defaultPaths();
    return { samples: readSamples(paths, 30), events: readEvents(paths, 30) };
  },
  apply: async (findings) => {
    const ctx = context();
    const outcome = await applyPlan(createPlan(ctx.paths, findings, ctx.staleDays, ctx.appStaleDays), ctx);
    const lowered = outcome.reniced ? `lowered the priority of ${count(outcome.reniced, "process", "processes")}` : "";
    const ended = outcome.stopped ? `stopped ${count(outcome.stopped, "process", "processes")}` : "";
    const done =
      [outcome.bytes ? `moved ${size(outcome.bytes)} to trash` : "", lowered, ended].filter(Boolean).join(" and ") ||
      "applied";
    const stale = findings.filter((finding) => outcome.stale.includes(finding.id)).map((finding) => finding.title);
    return [
      outcome.transaction
        ? `${done.charAt(0).toUpperCase()}${done.slice(1)}. Undo with keeper undo ${outcome.transaction}`
        : "Nothing was changed",
      stale.length ? `Skipped ${stale.join(", ")}: changed since the scan, r rescans` : "",
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
/** Only the keys that work in the view on screen. */
const keys = (view: View, showBlocked: boolean) =>
  view === "list"
    ? [
        "j/k move",
        "pgup/pgdn page",
        "space select",
        "a all low risk",
        "enter apply",
        `b ${showBlocked ? "hide" : "show"} blocked`,
        "h/l fold",
        "g space by category",
        "r rescan",
        "t schedule",
        "q/esc quit",
      ]
    : [view === "space" ? "g free space history" : "g back to the list", "r rescan", "q/esc quit"];
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
/**
 * The latest events in time order, as many as fit on the two lines under the chart. Each stays whole, so an event that
 * does not fit is left out rather than wrapped mid-phrase.
 */
function legend(events: readonly (Event & { event: keyof typeof marks })[], room: number): string {
  const entries = events.map(
    (event) => `${marks[event.event]} ${weekday(event.at)} ${time(event.at)} ${describe(event)}`,
  );
  const lines: string[][] = [[]];
  for (const entry of entries.slice(-4).reverse()) {
    const line = lines.at(-1) ?? [];
    if (!line.length || [...line, entry].join("   ").length <= room) line.unshift(entry);
    else if (lines.length < 2) lines.push([entry]);
    else break;
  }
  return lines
    .reverse()
    .map((line) => line.map((entry) => clip(entry, room)).join("   "))
    .filter(Boolean)
    .join("\n");
}

/** Space under this folds into one line, so the bars show where the disk actually went. */
const smallBar = 100 * 1024 ** 2;
/** A category with more rows than this starts folded, so a long scan opens as a short list of sections. */
const groupFoldAt = 20;
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
  const [folded, setFolded] = useState<Map<Category, boolean>>(new Map());
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

  // Findings gathered under their category, largest section first, so a long scan reads as a few sections rather than
  // one wall of rows. A category with more rows than groupFoldAt starts folded; the rest start open, and h/l folds any.
  const sections = (() => {
    const byCategory = new Map<Category, Finding[]>();
    for (const finding of rows) {
      const items = byCategory.get(finding.category);
      if (items) items.push(finding);
      else byCategory.set(finding.category, [finding]);
    }
    return [...byCategory]
      .map(([category, items]) => ({
        category,
        items,
        bytes: items.reduce((sum, finding) => sum + finding.bytes, 0),
        folded: folded.get(category) ?? items.length > groupFoldAt,
      }))
      .sort((a, b) => b.bytes - a.bytes);
  })();
  type Line = { kind: "group"; group: (typeof sections)[number] } | { kind: "finding"; finding: Finding };
  const lines: Line[] = sections.flatMap((group) => [
    { kind: "group", group } as const,
    ...(group.folded ? [] : group.items.map((finding): Line => ({ kind: "finding", finding }))),
  ]);
  const at = Math.min(cursor, Math.max(lines.length - 1, 0));

  // Every view gets the same panel, so switching never moves the lines around it. The explanation keeps two lines
  // because blockers with their next step often wrap.
  // The list's key line is the longest, so every view reserves its height.
  const keyLines = Math.ceil(keys("list", showBlocked).join(" · ").length / Math.max(width - 2, 1));
  const panel = Math.max(3, height - 1 - 2 - 1 - (report?.warnings.length ? 1 : 0) - keyLines);
  const pageSize = Math.max(1, panel - (report && !lines.length ? 1 : 0));

  const setFold = (category: Category, value: boolean) => {
    setFolded((now) => new Map(now).set(category, value));
    // The header keeps its place when only the rows after it change, so this stays correct after the fold.
    const header = lines.findIndex((line) => line.kind === "group" && line.group.category === category);
    if (header >= 0) setCursor(header);
  };
  const selectGroup = (group: (typeof sections)[number]) => {
    const ids = group.items.filter(eligible).map((finding) => finding.id);
    if (!ids.length) {
      const stopped = group.items.find((finding) => !eligible(finding));
      setMessage(
        stopped
          ? `Blocked: ${stopped.blockers.join("; ") || "report only, nothing to apply"}`
          : "Nothing in this category can be applied",
      );
      return;
    }
    const next = new Set(selected);
    if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
    else for (const id of ids) next.add(id);
    setSelected(next);
  };

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy();
    if (key.name === "g") setView((now) => views[(views.indexOf(now) + 1) % views.length] as View);
    if (key.name === "r" && !busy) perform(Promise.resolve("Rescanned everything"), false);
    if (view !== "list") return;
    const here = lines[at];
    if (key.name === "down" || key.name === "j") setCursor(Math.min(at + 1, Math.max(lines.length - 1, 0)));
    if (key.name === "up" || key.name === "k") setCursor(Math.max(at - 1, 0));
    if (key.name === "pagedown" || (key.ctrl && key.name === "d"))
      setCursor(Math.min(at + pageSize, Math.max(lines.length - 1, 0)));
    if (key.name === "pageup" || (key.ctrl && key.name === "u")) setCursor(Math.max(at - pageSize, 0));
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(Math.max(lines.length - 1, 0));
    if (key.name === "b") {
      setShowBlocked(!showBlocked);
      setCursor(0);
    }
    if (here?.kind === "group") {
      if (key.name === "left" || key.name === "h") return setFold(here.group.category, true);
      if (key.name === "right" || key.name === "l") return setFold(here.group.category, false);
    }
    if (here?.kind === "finding") {
      if (key.name === "left" || key.name === "h") return setFold(here.finding.category, true);
      if (key.name === "right" || key.name === "l") return setFold(here.finding.category, false);
    }
    if (busy) return;
    if (key.name === "space" && here) {
      if (here.kind === "group") return selectGroup(here.group);
      const current = here.finding;
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
      const low = open.filter((f) => f.risk === "low" && bulkEligible(f)).map((f) => f.id);
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

  const start = Math.max(0, Math.min(at - pageSize + 1, lines.length - pageSize));
  const active = lines[at];
  const total = outermost(chosen).reduce((sum, finding) => sum + finding.bytes, 0);
  const groups = chosen.filter((finding) => finding.action === "renice").length;
  const picked = [
    total || groups === 0 ? `${size(total)} selected, uncompressed` : "",
    groups ? `${count(groups, "process group")} to deprioritise` : "",
  ]
    .filter(Boolean)
    .join(", ");
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
    view === "history" ? freeChart(history.samples, history.events, plotWidth, panel - 3, Date.now(), size) : undefined;
  const explanation =
    view === "list"
      ? active
        ? active.kind === "group"
          ? `${count(active.group.items.length, "finding")}, ${size(active.group.bytes)}. ${active.group.folded ? "right/l expands" : "left/h folds"}, space selects all in the group`
          : active.finding.blockers.join("; ") || active.finding.reason
        : ""
      : view === "space"
        ? "█ ready to clean now · ░ waiting on a blocker · b in the list shows each reason"
        : legend(plotted?.events ?? [], width - 2) ||
          "Readings come from every keeper run and, with the timer on, every hour";

  const list = (
    <>
      {report && !rows.length ? (
        <text fg={terminal}>
          {blocked ? `Nothing is eligible. Press b to see ${count(blocked, "blocked finding")}.` : "Nothing to clean."}
        </text>
      ) : null}
      {lines.slice(start, start + pageSize).map((line, index) => {
        const isCursor = index + start === at;
        if (line.kind === "group") {
          const group = line.group;
          const eligibleItems = group.items.filter(eligible);
          const selectedItems = eligibleItems.filter((finding) => selected.has(finding.id)).length;
          const mark = eligibleItems.length && selectedItems === eligibleItems.length ? "[x]" : "[ ]";
          const rowColor = isCursor ? color(theme.cursorText) : color(theme.accent);
          const attributes =
            (isCursor && !theme.cursor ? TextAttributes.INVERSE : 0) | (isCursor ? 0 : TextAttributes.BOLD);
          return (
            <box
              key={`group-${group.category}`}
              flexDirection="row"
              backgroundColor={isCursor && theme.cursor ? theme.cursor : undefined}
            >
              <text wrapMode="none" fg={rowColor} attributes={attributes} flexShrink={0}>
                {mark} {group.folded ? "▸" : "▾"} {group.category.padEnd(14)}
              </text>
              <text wrapMode="none" fg={isCursor ? rowColor : terminal} attributes={attributes} flexShrink={0}>
                {count(group.items.length, "item").padStart(9)}
              </text>
              <text wrapMode="none" fg={isCursor ? rowColor : color(theme.size)} attributes={attributes} flexShrink={0}>
                {size(group.bytes).padStart(8)}
              </text>
            </box>
          );
        }
        const finding = line.finding;
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
          {plotted.ticks.map((tick, index) => (
            <span key={`tick-${tick.column}`} fg={color(markColor[tick.kind])}>
              {"".padStart(tick.column - (plotted.ticks[index - 1]?.column ?? -1) - 1)}
              {marks[tick.kind]}
            </span>
          ))}
        </text>
        <text wrapMode="none" {...dim}>
          {"".padStart(labelWidth + 2)}
          {plotted.axis}
        </text>
      </>
    );
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none" fg={color(theme.accent)} attributes={TextAttributes.BOLD}>
        {clip(
          view === "list"
            ? `keeper · ${open.length} eligible, ${blocked} blocked · ${lines.length > pageSize ? `${start + 1}-${Math.min(start + pageSize, lines.length)}/${lines.length} · ` : ""}${chosen.length ? picked : "nothing selected"}`
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
      <box flexDirection="row" flexWrap="wrap" height={keyLines} flexShrink={0}>
        {keys(view, showBlocked).map((binding, index, all) => (
          <text key={binding} wrapMode="none" fg={terminal} attributes={TextAttributes.DIM}>
            {binding}
            {index < all.length - 1 ? " · " : ""}
          </text>
        ))}
      </box>
    </box>
  );
}
