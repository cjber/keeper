import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { measure, size } from "./cli";
import { applyPlan, context, createPlan } from "./ops";
import { defaultTheme, scan, type Theme } from "./scanners";
import { defaultPaths } from "./system";
import { installSystemd } from "./timer";
import { type Category, categories, eligible, type Finding, type Scan } from "./types";

export interface Actions {
  /** The previous wizard scan, shown while a fresh one runs. Never acted on. */
  cached: () => Scan | undefined;
  /** Scans afresh, reporting each category as it finishes, with its finding count or undefined on failure. */
  load: (done?: (category: Category, findings: number | undefined) => void) => Promise<Scan>;
  apply: (findings: Finding[]) => Promise<string>;
  schedule: () => Promise<string>;
}

const cachePath = () => join(defaultPaths().state, "last-scan.json");

export const liveActions: Actions = {
  cached: () => {
    try {
      return JSON.parse(readFileSync(cachePath(), "utf8")) as Scan;
    } catch {
      return undefined;
    }
  },
  load: async (done) => {
    const result = await scan(context(), categories, done);
    mkdirSync(defaultPaths().state, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(result));
    return result;
  },
  apply: async (findings) => {
    const ctx = context();
    const outcome = await applyPlan(createPlan(ctx.paths, findings, ctx.staleDays), ctx);
    return `Moved ${size(outcome.bytes)} to trash. Undo with keeper undo ${outcome.transaction ?? "(nothing applied)"}. Stale: ${outcome.stale.length}, failed: ${outcome.failed.length}`;
  },
  schedule: async () => {
    await installSystemd(defaultPaths());
    return "Daily keeper run scheduled with systemd";
  },
};

const pageSize = 18;
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
/** Each category's state while a scan runs: undefined is still scanning, null failed, a number is its findings. */
type Progress = Partial<Record<Category, number | null>>;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Holds selection only. Every safety rule stays in the scan and apply calls an agent would make. */
export function Wizard({ actions, theme = defaultTheme }: { actions: Actions; theme?: Theme }) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  // Below this the category column goes, so the title keeps room to say what the row is.
  const wide = width >= 80;
  // Padding, mark, size and risk columns, then the category column when it shows.
  const titleWidth = width - 2 - 4 - 9 - 7 - (wide ? 14 : 0);
  const [report, setReport] = useState<Scan | undefined>(actions.cached);
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

  const perform = (work: Promise<string | undefined>) => {
    setBusy(true);
    work
      .then(async (done) => {
        setProgress({});
        const fresh = await actions.load((category, found) =>
          setProgress((now) => ({ ...now, [category]: found ?? null })),
        );
        setReport(fresh);
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

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy();
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

  const start = Math.max(0, Math.min(at - pageSize + 1, rows.length - pageSize));
  const active = rows[at];
  const total = chosen.reduce((sum, finding) => sum + finding.bytes, 0);
  const status = busy
    ? report
      ? `Showing the scan from ${time(report.scannedAt)} until the new one finishes`
      : "Scanning"
    : message;
  const riskColor = { low: theme.low, medium: theme.medium, high: theme.high };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none" fg={color(theme.accent)} attributes={TextAttributes.BOLD}>
        keeper · {open.length} eligible, {blocked} blocked ·{" "}
        {chosen.length ? `${size(total)} selected, uncompressed` : "nothing selected"}
      </text>
      {progress ? (
        <box flexDirection="row" flexWrap="wrap">
          {categories.map((category) => {
            const state = progress[category];
            const mark = state === undefined ? spinner[frame % spinner.length] : state === null ? "✗" : "✓";
            const fg = color(state === undefined ? theme.accent : state === null ? theme.high : theme.low);
            return (
              <text key={category} fg={fg} marginRight={2}>
                {mark} {category}
                {typeof state === "number" ? ` ${state}` : ""}
              </text>
            );
          })}
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {report && !rows.length ? (
          <text fg={terminal}>
            {blocked ? `Nothing is eligible. Press b to see the ${blocked} blocked findings.` : "Nothing to clean."}
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
      </box>
      {active ? <text fg={terminal}>{active.blockers.join("; ") || active.reason}</text> : null}
      <text fg={busy ? color(theme.accent) : terminal}>{status}</text>
      {report?.warnings.length ? <text fg={color(theme.high)}>Scan warnings: {report.warnings.join("; ")}</text> : null}
      <text fg={terminal} attributes={TextAttributes.DIM}>
        j/k move · space select · a all low risk · enter apply · b {showBlocked ? "hide" : "show"} blocked · t schedule
        · q/esc quit
      </text>
    </box>
  );
}
