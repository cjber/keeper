import type { Event, Sample } from "./history";
import { type Category, eligible, type Finding, outermost } from "./types";

const levels = " ▁▂▃▄▅▆▇█";
const gigabyte = 1024 ** 3;

/** The mark each event leaves under the chart, newest wins a column, and a purge or apply outranks a nightly run. */
export const marks: Record<Event["event"], string> = { purge: "◆", apply: "▲", undo: "↺", auto: "·" };
const rank: Event["event"][] = ["auto", "undo", "apply", "purge"];

export interface FreeChart {
  /** Top row first, each exactly `columns` wide. `level` counts rows up from the axis, which identifies a row. */
  rows: { level: number; text: string }[];
  /** One entry per column: the event kind marked there, if any. */
  markers: (Event["event"] | undefined)[];
  top: number;
  bottom: number;
  start: number;
  end: number;
}

/**
 * A column chart of free space from the first reading (or `days` back, if later) to now. Each column holds the last
 * reading at or before its end, so a gap between readings repeats the value rather than dropping to zero.
 */
export function freeChart(
  samples: readonly Sample[],
  events: readonly Event[],
  columns: number,
  height: number,
  now: number,
  days = 30,
): FreeChart | undefined {
  if (samples.length < 2 || columns < 2 || height < 1) return undefined;
  const times = samples.map((sample) => Date.parse(sample.at));
  const start = Math.max(times[0] as number, now - days * 86_400_000);
  const end = Math.max(now, start + 3_600_000);
  const span = (end - start) / columns;
  const values: (number | undefined)[] = [];
  let next = 0;
  let current: number | undefined;
  for (let column = 0; column < columns; column++) {
    const edge = start + (column + 1) * span;
    while (next < samples.length && (times[next] as number) <= edge) current = samples[next++]?.free;
    values.push(current);
  }
  const known = values.filter((value): value is number => value !== undefined);
  const low = Math.min(...known);
  const high = Math.max(...known);
  // Padding keeps a flat line off the floor and the ceiling, so a small change still shows.
  const pad = Math.max((high - low) * 0.1, gigabyte);
  const bottom = Math.max(0, low - pad);
  const top = high + pad;
  const steps = height * 8;
  const rows = Array.from({ length: height }, (_, row) => {
    const level = height - 1 - row;
    const text = values
      .map((value) => {
        if (value === undefined) return " ";
        const filled = Math.round(((value - bottom) / (top - bottom)) * steps) - level * 8;
        return levels[Math.max(0, Math.min(8, filled))];
      })
      .join("");
    return { level, text };
  });
  const markers: (Event["event"] | undefined)[] = Array.from({ length: columns }, () => undefined);
  for (const event of events) {
    const column = Math.floor((Date.parse(event.at) - start) / span);
    if (column < 0 || column >= columns) continue;
    const there = markers[column];
    if (!there || rank.indexOf(event.event) > rank.indexOf(there)) markers[column] = event.event;
  }
  return { rows, markers, top, bottom, start, end };
}

/** Consecutive columns with the same mark, or none, so each run renders as one span keyed by where it starts. */
export function markerRuns(markers: readonly (Event["event"] | undefined)[]) {
  const runs: { column: number; kind: Event["event"] | undefined; width: number }[] = [];
  markers.forEach((kind, column) => {
    const last = runs.at(-1);
    if (last && last.kind === kind) last.width++;
    else runs.push({ column, kind, width: 1 });
  });
  return runs;
}

export interface Bar {
  category: Category;
  ready: number;
  blocked: number;
}

/** Disk held per category, split into what can go now and what waits on a blocker. Load and memory hold no disk. */
export function spaceBars(findings: readonly Finding[]): Bar[] {
  const bars = new Map<Category, Bar>();
  for (const finding of findings) {
    if (finding.category === "load" || finding.category === "memory" || finding.bytes <= 0) continue;
    const bar = bars.get(finding.category) ?? { category: finding.category, ready: 0, blocked: 0 };
    bars.set(finding.category, bar);
    if (!eligible(finding)) bar.blocked += finding.bytes;
  }
  // Each bar counts its own category: nested paths within it once, as applying would, but a build folder inside a
  // worktree still counts as build, since that is the category that offers it.
  for (const bar of bars.values()) {
    const own = findings.filter((finding) => finding.category === bar.category && eligible(finding));
    bar.ready = outermost(own).reduce((sum, finding) => sum + finding.bytes, 0);
  }
  return [...bars.values()].sort((a, b) => b.ready + b.blocked - (a.ready + a.blocked));
}
