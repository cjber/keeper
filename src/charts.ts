import type { Event, Sample } from "./history";
import { type Category, eligible, type Finding, outermost } from "./types";

const gigabyte = 1024 ** 3;
const hour = 3_600_000;
const day = 24 * hour;

/** The mark an event leaves on the time axis. Nightly runs leave none: one a day is noise, not news. */
export const marks = { purge: "◆", apply: "▲", undo: "↺" } as const;
type Marked = keyof typeof marks;
const isMarked = (event: Event): event is Event & { event: Marked } => event.event in marks;
/** When two events share a column, the one that changed the most space shows. */
const rank: Marked[] = ["undo", "apply", "purge"];

/** What a cell draws: the line itself, a gridline, an event's rule, or nothing. */
export type Ink = "line" | "grid" | "rule" | "blank";

export interface FreeChart {
  /** Top row first. Each row is runs of one ink, keyed by the column they start at. */
  rows: { label: string; runs: { column: number; ink: Ink; text: string }[] }[];
  /** Event marks, on their own row under the chart so they never hide a label. */
  ticks: { column: number; kind: Marked }[];
  /** Day or hour labels under the marks. */
  axis: string;
  /** The events drawn, oldest first. */
  events: (Event & { event: Marked })[];
  top: number;
  bottom: number;
  start: number;
}

/** 1, 2 or 5 times a power of ten, in bytes, so the gridlines land on round values. */
function niceStep(range: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(range));
  return [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= range) ?? range;
}

/** Braille gives each cell a 2 by 4 grid of dots, so a line reads as a line rather than a filled wall. */
const dots = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/**
 * A line of free space from the first reading (or `days` back, if later) to now. The last reading carries on to now,
 * so the line ends where the axis does. Gridlines sit at the top, middle and bottom, on round values.
 */
export function freeChart(
  samples: readonly Sample[],
  events: readonly Event[],
  columns: number,
  height: number,
  now: number,
  label: (bytes: number) => string,
  days = 30,
): FreeChart | undefined {
  if (samples.length < 2 || columns < 2 || height < 3) return undefined;
  const start = Math.max(Date.parse(samples[0]?.at ?? ""), now - days * day);
  const end = Math.max(now, start + hour);
  const shown = samples.filter((sample, index) => {
    const next = samples[index + 1];
    // The reading before the window still sets where the line starts.
    return Date.parse(sample.at) >= start || (next !== undefined && Date.parse(next.at) > start);
  });
  const values = shown.map((sample) => sample.free / gigabyte);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const step = niceStep(Math.max((high - low) / 4, 0.25)) * gigabyte;
  const bottom = Math.max(0, Math.floor((low * gigabyte) / step) * step);
  const ceiling = Math.max(Math.ceil((high * gigabyte) / step) * step, bottom + step);
  // An even number of steps puts the middle gridline on a round value too.
  const top = Math.round((ceiling - bottom) / step) % 2 ? ceiling + step : ceiling;
  const width = columns * 2;
  const depth = height * 4;
  const x = (at: number) => Math.round(((Math.max(at, start) - start) / (end - start)) * (width - 1));
  const y = (free: number) => Math.round(((top - free) / (top - bottom)) * (depth - 1));
  const pixels = new Set<number>();
  const points = [
    ...shown.map((sample) => [x(Date.parse(sample.at)), y(sample.free)]),
    [width - 1, y(shown.at(-1)?.free ?? 0)],
  ];
  points.reduce((from, to) => {
    const [x0 = 0, y0 = 0] = from;
    const [x1 = 0, y1 = 0] = to;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) {
      pixels.add(Math.round(y0 + ((y1 - y0) * i) / steps) * width + Math.round(x0 + ((x1 - x0) * i) / steps));
    }
    return to;
  });

  const drawn = events.filter(isMarked).filter((event) => Date.parse(event.at) >= start && Date.parse(event.at) <= end);
  const markAt = new Map<number, Marked>();
  for (const event of drawn) {
    const column = Math.floor(x(Date.parse(event.at)) / 2);
    const there = markAt.get(column);
    if (!there || rank.indexOf(event.event) > rank.indexOf(there)) markAt.set(column, event.event);
  }

  const half = (top + bottom) / 2;
  const middle = Math.floor(y(half) / 4);
  const rows = Array.from({ length: height }, (_, row) => {
    const gridline = row === 0 || row === middle || row === height - 1;
    const cells = Array.from({ length: columns }, (_, column): [Ink, string] => {
      let code = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (pixels.has((row * 4 + dy) * width + column * 2 + dx)) code |= dots[dy]?.[dx] ?? 0;
        }
      }
      if (code) return ["line", String.fromCharCode(0x2800 + code)];
      if (markAt.has(column)) return ["rule", "┊"];
      return gridline ? ["grid", "┄"] : ["blank", " "];
    });
    const runs: FreeChart["rows"][number]["runs"] = [];
    cells.forEach(([ink, text], column) => {
      const last = runs.at(-1);
      if (last && last.ink === ink) last.text += text;
      else runs.push({ column, ink, text });
    });
    const tick = row === 0 ? top : row === height - 1 ? bottom : row === middle ? half : undefined;
    return { label: tick === undefined ? "" : label(tick), runs };
  });

  const ticks = [...markAt].map(([column, kind]) => ({ column, kind })).sort((a, b) => a.column - b.column);
  return { rows, ticks, axis: timeAxis(start, end, columns), events: drawn, top, bottom, start };
}

/** Weekday names at midnight over two days or more, otherwise hours, each with a space before the next. */
function timeAxis(start: number, end: number, columns: number): string {
  const column = (at: number) => Math.floor(((at - start) / (end - start)) * columns);
  const cells = Array.from({ length: columns }, () => " ");
  const long = end - start >= 2 * day;
  const every = long ? day : hour * Math.max(1, Math.ceil((end - start) / hour / Math.max(columns / 8, 1)));
  const first = new Date(start);
  if (long) first.setHours(24, 0, 0, 0);
  else first.setMinutes(60, 0, 0);
  let free = 0;
  for (let at = first.getTime(); at < end; at += every) {
    const date = new Date(at);
    const text = long
      ? date.toLocaleDateString("en-GB", { weekday: "short" })
      : `${String(date.getHours()).padStart(2, "0")}:00`;
    const from = column(at);
    if (from < free || from + text.length > columns) continue;
    for (let i = 0; i < text.length; i++) cells[from + i] = text[i] ?? " ";
    free = from + text.length + 1;
  }
  return cells.join("").trimEnd();
}

export interface Bar {
  category: Category;
  ready: number;
  blocked: number;
}

/**
 * Bytes each finding holds on its own: a finding that contains another category's finding, like a worktree holding
 * build output, leaves those bytes to the more specific one, so every byte is counted once.
 */
function ownBytes(findings: readonly Finding[]): Map<Finding, number> {
  const disk = findings.filter((finding) => finding.category !== "load" && finding.category !== "memory");
  const own = new Map(disk.map((finding) => [finding, finding.bytes]));
  for (const inner of disk) {
    for (const outer of disk) {
      if (outer === inner || outer.category === inner.category) continue;
      if (inner.paths.some((path) => outer.paths.some((parent) => path.startsWith(`${parent}/`)))) {
        own.set(outer, Math.max(0, (own.get(outer) ?? 0) - inner.bytes));
      }
    }
  }
  return own;
}

/** Disk held per category, split into what can go now and what waits on a blocker. Load and memory hold no disk. */
export function spaceBars(findings: readonly Finding[]): Bar[] {
  const own = ownBytes(findings);
  const bars = new Map<Category, Bar>();
  for (const [finding, bytes] of own) {
    if (bytes <= 0) continue;
    const bar = bars.get(finding.category) ?? { category: finding.category, ready: 0, blocked: 0 };
    bars.set(finding.category, bar);
    if (!eligible(finding)) bar.blocked += bytes;
  }
  // Ready space within a category counts nested paths once, as applying would.
  for (const bar of bars.values()) {
    const ready = outermost(
      [...own.keys()].filter((finding) => finding.category === bar.category && eligible(finding)),
    );
    bar.ready = ready.reduce((sum, finding) => sum + (own.get(finding) ?? 0), 0);
  }
  return [...bars.values()].sort((a, b) => b.ready + b.blocked - (a.ready + a.blocked));
}

/** Each blocker reworded without its numbers, so findings waiting on the same thing group together. */
const reasons: [RegExp, string][] = [
  [/^PR #\d+ is open/, "PR is open, merge or close it"],
  [/on no remote/, "commits on no remote, push them"],
  [/uncommitted or untracked/, "uncommitted files, commit or stash them"],
  [/^touched/, "touched recently, offered once idle"],
  [/^built/, "built recently, offered once idle"],
  [/^in use|is running|operation is running|build is running/, "in use, offered once it stops"],
  [/^held by/, "held, keeper release PATH ends it"],
  [/is in progress/, "git operation in progress, finish or abort it"],
  [/^includes this keeper run/, "includes this keeper run, judged once it exits"],
  [/desktop session/, "part of your desktop session, never lowered"],
  [/bottom priority/, "already at the bottom priority"],
  [/another user/, "owned by another user"],
];

export interface Wait {
  reason: string;
  count: number;
  bytes: number;
}

/**
 * Why findings wait, by each one's first blocker, largest first. Every blocked finding counts once, so the counts add up
 * to the blocked total and the sizes to the space waiting. Load and memory rows wait too, though they hold no disk.
 */
export function waits(findings: readonly Finding[]): Wait[] {
  const own = ownBytes(findings);
  const groups = new Map<string, Wait>();
  for (const finding of findings) {
    const first = finding.blockers[0];
    if (!first) continue;
    const bytes = own.get(finding) ?? 0;
    const reason = reasons.find(([pattern]) => pattern.test(first))?.[1] ?? first.replace(/\d+/g, "N");
    const group = groups.get(reason) ?? { reason, count: 0, bytes: 0 };
    group.count++;
    group.bytes += bytes;
    groups.set(reason, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);
}
