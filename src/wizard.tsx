import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { gib, measure } from "./cli";
import { applyPlan, context, createPlan } from "./ops";
import { scan } from "./scanners";
import { defaultPaths } from "./system";
import { installSystemd } from "./timer";
import { eligible, type Finding, type Scan } from "./types";

export interface Actions {
  load: () => Promise<Scan>;
  apply: (findings: Finding[]) => Promise<string>;
  schedule: () => Promise<string>;
}

export const liveActions: Actions = {
  load: () => scan(context()),
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

/** Holds selection only. Every safety rule stays in the scan and apply calls an agent would make. */
export function Wizard({ actions }: { actions: Actions }) {
  const renderer = useRenderer();
  const [report, setReport] = useState<Scan>();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("Scanning...");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    actions.load().then((result) => {
      setReport(result);
      setBusy(false);
      setMessage("");
    });
  }, [actions]);

  const rows = report?.findings ?? [];
  const chosen = rows.filter((finding) => selected.has(finding.id));

  const perform = (work: Promise<string>) => {
    setBusy(true);
    work
      .then(async (done) => {
        setSelected(new Set());
        setReport(await actions.load());
        setMessage(done);
      })
      .catch((error) => setMessage(String(error)))
      .finally(() => setBusy(false));
  };

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") renderer.destroy();
    if (busy) return;
    const current = rows[cursor];
    if (key.name === "down" || key.name === "j") setCursor(Math.min(cursor + 1, rows.length - 1));
    if (key.name === "up" || key.name === "k") setCursor(Math.max(cursor - 1, 0));
    if (key.name === "space" && current && eligible(current)) {
      const next = new Set(selected);
      if (!next.delete(current.id)) next.add(current.id);
      setSelected(next);
    }
    if (key.name === "a") setSelected(new Set(rows.filter((f) => eligible(f) && f.risk === "low").map((f) => f.id)));
    if (key.name === "return" && chosen.length) perform(actions.apply(chosen));
    if (key.name === "t") perform(actions.schedule());
  });

  const start = Math.max(0, Math.min(cursor - pageSize + 1, rows.length - pageSize));
  const active = rows[cursor];
  const total = chosen.reduce((sum, finding) => sum + finding.bytes, 0);

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none">keeper · {gib(total)} selected, uncompressed</text>
      <box flexDirection="column" flexGrow={1}>
        {rows.slice(start, start + pageSize).map((finding, index) => {
          const mark = !eligible(finding) ? " - " : selected.has(finding.id) ? "[x]" : "[ ]";
          return (
            <box key={finding.id} backgroundColor={index + start === cursor ? "#333333" : undefined}>
              <text wrapMode="none">
                {mark} {measure(finding).padStart(7)} {finding.risk.padEnd(6)} {finding.title}
              </text>
            </box>
          );
        })}
      </box>
      {active ? <text>{active.blockers.join("; ") || active.reason}</text> : null}
      <text>{message}</text>
      <text wrapMode="none">space select · a all low risk · enter apply · t schedule · q quit</text>
    </box>
  );
}
