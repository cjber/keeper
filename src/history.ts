import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAudit } from "./ledger";
import { type Paths, run } from "./system";

/** Free and total bytes on the filesystem that holds the home directory, at one moment. */
export interface Sample {
  at: string;
  free: number;
  size: number;
}

/** Something keeper did that changed free space, or the nightly run, for marking on the chart. */
export interface Event {
  at: string;
  event: "apply" | "purge" | "undo" | "auto";
  /** Uncompressed bytes moved by an apply, or bytes a purge measured as freed. */
  bytes?: number;
  summary?: string;
}

const day = 86_400_000;
/** Closer readings add nothing a chart of days can show, and keep every command from writing. */
const spacingMs = 10 * 60_000;
const keepDays = 90;

const historyPath = (paths: Paths) => join(paths.state, "history.jsonl");

export function readSamples(paths: Paths, days = keepDays, now = Date.now()): Sample[] {
  let text: string;
  try {
    text = readFileSync(historyPath(paths), "utf8");
  } catch {
    return [];
  }
  const since = now - days * day;
  return text.split("\n").flatMap((line) => {
    try {
      const sample = JSON.parse(line) as Sample;
      return Date.parse(sample.at) >= since && Number.isFinite(sample.free) ? [sample] : [];
    } catch {
      return []; // A torn or hand-edited line costs one reading, not the history.
    }
  });
}

/**
 * Records free space unless a reading is under ten minutes old. One line per append, so concurrent runs cannot
 * interleave within a line, and the worst a race does is record two readings close together.
 */
export async function sample(paths: Paths, now = Date.now(), force = false): Promise<Sample | undefined> {
  const samples = readSamples(paths, Number.POSITIVE_INFINITY, now);
  const last = samples.at(-1);
  if (!force && last && now - Date.parse(last.at) < spacingMs) return undefined;
  const df = await run(["df", "-B1", "--output=avail,size", paths.home]);
  const [free, size] = (df.stdout.split("\n").at(-1) ?? "").trim().split(/\s+/).map(Number);
  if (!free || !size) return undefined;
  const reading: Sample = { at: new Date(now).toISOString(), free, size };
  mkdirSync(paths.state, { recursive: true });
  const old = samples.filter((entry) => Date.parse(entry.at) < now - keepDays * day);
  if (old.length) {
    // Rewritten through a rename, so an interrupted prune leaves the old file whole.
    const kept = [...samples.filter((entry) => !old.includes(entry)), reading];
    const temporary = `${historyPath(paths)}.${process.pid}`;
    writeFileSync(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    renameSync(temporary, historyPath(paths));
  } else appendFileSync(historyPath(paths), `${JSON.stringify(reading)}\n`);
  return reading;
}

export function readEvents(paths: Paths, days = keepDays, now = Date.now()): Event[] {
  const since = now - days * day;
  return (readAudit(paths, 5000) as Record<string, unknown>[]).flatMap((entry): Event[] => {
    const at = String(entry.at);
    if (Date.parse(at) < since) return [];
    if (entry.event === "apply" && Number(entry.bytes) > 0) return [{ at, event: "apply", bytes: Number(entry.bytes) }];
    if (entry.event === "purge") return [{ at, event: "purge", bytes: Number(entry.freed) || 0 }];
    if (entry.event === "undo") return [{ at, event: "undo" }];
    if (entry.event === "auto") return [{ at, event: "auto", summary: String(entry.summary ?? "") }];
    return [];
  });
}
