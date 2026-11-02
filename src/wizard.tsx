import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { gib, measure } from "./cli";
import { applyPlan, context, createPlan } from "./ops";
import { defaultTheme, scan, type Theme } from "./scanners";
import { defaultPaths } from "./system";
import { installSystemd } from "./timer";
import { eligible, type Finding, type Scan } from "./types";

export interface Actions {
  /** The previous wizard scan, shown while a fresh one runs. Never acted on. */
  cached: () => Scan | undefined;
  load: () => Promise<Scan>;
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
  load: async () => {
    const result = await scan(context());
    mkdirSync(defaultPaths().state, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(result));
    return result;
  },
  apply: async (findings) => {
    const ctx = context();
    const outcome = await applyPlan(createPlan(ctx.paths, findings, ctx.staleDays), ctx);
    return `Moved ${gib(outcome.bytes)} to trash. Undo with keeper undo ${outcome.transaction ?? "(nothing applied)"}. Stale: ${outcome.stale.length}, failed: ${outcome.failed.length}`;
  },
  schedule: async () => {
    await installSystemd(defaultPaths());
    return "Daily keeper run scheduled with systemd";
  },
};

const pageSize = 18;
/** An unset theme colour is the terminal's own, rather than OpenTUI's fixed white. */
const color = (value: string) => value || RGBA.defaultForeground();
const terminal = color("");
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Holds selection only. Every safety rule stays in the scan and apply calls an agent would make. */
export function Wizard({ actions, theme = defaultTheme }: { actions: Actions; theme?: Theme }) {
  const renderer = useRenderer();
  const [report, setReport] = useState<Scan | undefined>(actions.cached);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBlocked, setShowBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);

  const perform = (work: Promise<string | undefined>) => {
    setBusy(true);
    work
      .then(async (done) => {
        setSelected(new Set());
        setReport(await actions.load());
        setMessage(done ?? "");
      })
      .catch((error) => setMessage(`Failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => setBusy(false));
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
      const low = open.filter((f) => f.risk === "low").map((f) => f.id);
      setSelected(new Set(low));
      setMessage(low.length ? `Selected ${low.length} low-risk findings` : "No low-risk finding is eligible");
    }
    if (key.name === "return") {
      if (chosen.length) perform(actions.apply(chosen));
      else setMessage("Select findings with space or a first");
    }
    if (key.name === "t") perform(actions.schedule());
  });

  const start = Math.max(0, Math.min(at - pageSize + 1, rows.length - pageSize));
  const active = rows[at];
  const total = chosen.reduce((sum, finding) => sum + finding.bytes, 0);
  const status = busy
    ? report
      ? `Showing the scan from ${time(report.scannedAt)}. Rescanning...`
      : "Scanning..."
    : message;

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none" fg={color(theme.accent)} attributes={TextAttributes.BOLD}>
        keeper · {open.length} eligible, {blocked} blocked · {gib(total)} selected, uncompressed
      </text>
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
          const attributes =
            (isCursor && !theme.cursor ? TextAttributes.INVERSE : 0) | (!ok && !theme.blocked ? TextAttributes.DIM : 0);
          const fg = isCursor ? color(theme.cursorText) : color(isSelected ? theme.selected : ok ? "" : theme.blocked);
          return (
            <box key={finding.id} backgroundColor={isCursor && theme.cursor ? theme.cursor : undefined}>
              <text wrapMode="none" fg={fg} attributes={attributes}>
                {mark} {measure(finding).padStart(7)} {finding.risk.padEnd(6)} {finding.title}
              </text>
            </box>
          );
        })}
      </box>
      {active ? <text fg={terminal}>{active.blockers.join("; ") || active.reason}</text> : null}
      <text fg={terminal}>{status}</text>
      {report?.warnings.length ? <text fg={terminal}>Scan warnings: {report.warnings.join("; ")}</text> : null}
      <text wrapMode="none" fg={terminal}>
        space select · a all low risk · enter apply · b {showBlocked ? "hide" : "show"} blocked · t schedule · q quit
      </text>
    </box>
  );
}
