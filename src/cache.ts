import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Context, scan, withHolds } from "./scanners";
import type { Paths } from "./system";
import { type Category, categories, type Finding, type Scan, schemaVersion } from "./types";

const minute = 60_000;

/**
 * How long a category's findings stay worth showing without a rescan, in minutes. Zero is never cached: load and
 * memory describe this moment. The rest follow how fast each changes and how long it takes to look. Applying always
 * rescans first, so a cached row can never be what decides a removal.
 */
export const maxAge: Record<Category, number> = {
  load: 0,
  memory: 0,
  worktree: 15,
  build: 60,
  agent: 60,
  transcripts: 60,
  tmp: 60,
  logs: 60,
  docker: 60,
  downloads: 60,
  screenshots: 60,
  aur: 360,
  "pacman-cache": 360,
  orphans: 360,
  "package-cache": 360,
  snapshots: 360,
  apps: 360,
  large: 360,
  duplicates: 360,
};

interface Entry {
  scannedAt: string;
  /** Before holds, which are applied on every read. */
  findings: Finding[];
}

interface Cache {
  /** What the findings depend on besides time. Entries from another config or window are never reused. */
  fingerprint: string;
  entries: Partial<Record<Category, Entry>>;
}

const cachePath = (paths: Paths) => join(paths.state, "scan-cache.json");

function fingerprint(context: Context): string {
  const inputs = {
    schemaVersion,
    staleDays: context.staleDays,
    appStaleDays: context.appStaleDays,
    home: context.paths.home,
    config: context.config,
  };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

function read(paths: Paths): Cache | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(paths), "utf8")) as Cache;
  } catch {
    return undefined;
  }
}

/** Atomic, so a reader never sees half a file. Two writers can each lose the other's categories, which only costs a rescan. */
function write(paths: Paths, cache: Cache): void {
  mkdirSync(paths.state, { recursive: true });
  const temporary = `${cachePath(paths)}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(cache));
  renameSync(temporary, cachePath(paths));
}

/** Drops categories whose findings an action just changed, so the next read scans them. */
export function forget(paths: Paths, changed: readonly Category[] = categories): void {
  const cache = read(paths);
  if (!cache) return;
  for (const category of changed) delete cache.entries[category];
  write(paths, cache);
}

/**
 * Drops stored findings that sit inside paths an apply just moved, whatever their category: a trashed worktree takes
 * its build output with it, and that build category may still be fresh enough to be reused.
 */
export function forgetUnder(paths: Paths, moved: readonly string[]): void {
  const cache = read(paths);
  if (!cache || !moved.length) return;
  // A set and a walk up each path, because a temp dir sweep moves tens of thousands of roots.
  const roots = new Set(moved);
  const gone = (path: string) => {
    for (let at = path; at !== dirname(at); at = dirname(at)) if (roots.has(at)) return true;
    return false;
  };
  for (const entry of Object.values(cache.entries)) {
    if (entry) entry.findings = entry.findings.filter((finding) => !finding.paths.length || !finding.paths.every(gone));
  }
  write(paths, cache);
}

/** Everything stored, however old, for the wizard to show while it scans. Never a basis for acting. */
export function lastKnown(context: Context): Scan | undefined {
  const stored = read(context.paths);
  if (!stored || stored.fingerprint !== fingerprint(context)) return undefined;
  const entries = Object.entries(stored.entries) as [Category, Entry][];
  if (!entries.length) return undefined;
  const oldest = entries.map(([, entry]) => entry.scannedAt).sort()[0] as string;
  return {
    schemaVersion,
    scannedAt: oldest,
    categoryScannedAt: Object.fromEntries(entries.map(([category, entry]) => [category, entry.scannedAt])),
    findings: withHolds(
      context,
      entries.flatMap(([, entry]) => entry.findings),
    ).sort((a, b) => b.bytes - a.bytes),
    warnings: [],
  };
}

export interface CachedScan extends Scan {
  /** Categories served from the cache rather than scanned now. */
  cached: Category[];
}

/**
 * Scans the categories past their max age and reuses the rest. With reuse off it scans everything, and either way it
 * stores what it scanned. A category that failed is never stored, so a failure cannot pass for an empty result.
 */
export async function cachedScan(
  context: Context,
  options: {
    reuse?: boolean;
    only?: readonly Category[];
    done?: (category: Category, findings: number | undefined, cached: boolean) => void;
  } = {},
): Promise<CachedScan> {
  const { reuse = true, only = categories, done } = options;
  const print = fingerprint(context);
  const stored = read(context.paths);
  const usable = stored?.fingerprint === print ? stored.entries : {};
  const fresh = (category: Category) => {
    const entry = usable[category];
    return reuse && entry && context.now - Date.parse(entry.scannedAt) < maxAge[category] * minute;
  };
  const cached = only.filter(fresh);
  for (const category of cached) done?.(category, usable[category]?.findings.length, true);
  const scanned: Partial<Record<Category, Entry>> = {};
  const at = new Date(context.now).toISOString();
  const report = await scan(
    context,
    only.filter((category) => !cached.includes(category)),
    (category, findings) => {
      if (findings && maxAge[category] > 0) scanned[category] = { scannedAt: at, findings };
      done?.(category, findings?.length, false);
    },
  );
  // Re-read before merging, so a category another run stored meanwhile survives.
  const latest = read(context.paths);
  const base = latest?.fingerprint === print ? latest.entries : {};
  write(context.paths, { fingerprint: print, entries: { ...base, ...scanned } });
  const reused = cached.flatMap((category) => usable[category]?.findings ?? []);
  return {
    ...report,
    categoryScannedAt: {
      ...report.categoryScannedAt,
      ...Object.fromEntries(cached.map((category) => [category, usable[category]?.scannedAt])),
    },
    findings: [...report.findings, ...withHolds(context, reused)].sort((a, b) => b.bytes - a.bytes),
    cached,
  };
}
