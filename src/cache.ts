import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLedger } from "./ledger";
import { type Context, findingId, scan, targetIds, withHolds } from "./scanners";
import { type Paths, writeAtomically } from "./system";
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
  /**
   * The scan warned, so a missing proof may be a failed lookup, or it measured only the ids a plan named. Kept for its
   * ids, never reused.
   */
  incomplete?: true;
  /** Blocked findings were sized too, so the entry can serve a caller that sets `sizeBlocked`. */
  sizedBlocked?: true;
}

interface Cache {
  /** What the findings depend on besides time. Entries from another config or window are never reused. */
  fingerprint: string;
  /** What decides a path's category, so a plan can find its owners under any idle window. */
  owners: string;
  entries: Partial<Record<Category, Entry>>;
}

const cachePath = (paths: Paths) => join(paths.state, "scan-cache.json");

/** What decides which category holds a path. The idle windows only decide a blocker, never the owner. */
function ownerFingerprint(context: Context): string {
  const inputs = { schemaVersion, home: context.paths.home, config: context.config };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

function fingerprint(context: Context): string {
  const inputs = {
    owners: ownerFingerprint(context),
    staleDays: context.staleDays,
    appStaleDays: context.appStaleDays,
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

/**
 * Atomic, so a reader never sees half a file. Two writers can each lose the other's categories, which only costs a
 * rescan, so a lost write is never worth failing the command that triggered it, such as a claim.
 */
function write(paths: Paths, cache: Cache): void {
  try {
    writeAtomically(cachePath(paths), JSON.stringify(cache));
  } catch {}
}

/** Drops categories whose findings an action just changed, so the next read scans them. */
export function forget(paths: Paths, changed: readonly Category[] = categories): void {
  const cache = read(paths);
  if (!cache) return;
  for (const category of changed) delete cache.entries[category];
  write(paths, cache);
}

/**
 * Drops stored findings that sit inside paths an apply just deleted, whatever their category: a deleted worktree takes
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

/**
 * Everything stored, however old, for the wizard to show while it scans. Never a basis for acting. Load and memory
 * describe a past moment, so they are left out.
 */
export function lastKnown(context: Context): Scan | undefined {
  const stored = read(context.paths);
  if (!stored || stored.fingerprint !== fingerprint(context)) return undefined;
  const entries = (Object.entries(stored.entries) as [Category, Entry][]).filter(([category]) => maxAge[category] > 0);
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
  /** Categories reuse was asked for but that describe this moment, so they were scanned now anyway. */
  live: Category[];
}

/**
 * Scans the categories past their max age and reuses the rest. With reuse off it scans everything, and either way it
 * stores what it scanned. A category that failed is never stored, and one that warned is never reused, so a failure
 * cannot pass for a clean result.
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
    return (
      reuse &&
      entry &&
      !entry.incomplete &&
      (!context.sizeBlocked || entry.sizedBlocked) &&
      context.now - Date.parse(entry.scannedAt) < maxAge[category] * minute
    );
  };
  const cached = only.filter(fresh);
  for (const category of cached) done?.(category, usable[category]?.findings.length, true);
  const scanned: Partial<Record<Category, Entry>> = {};
  const at = new Date(context.now).toISOString();
  const report = await scan(
    context,
    only.filter((category) => !cached.includes(category)),
    (category, findings, warned) => {
      // Load and memory are stored too, never to be reused, so planning their ids rescans only their category.
      if (findings)
        scanned[category] = {
          scannedAt: at,
          findings,
          incomplete: warned || context.sizeOnly !== undefined || undefined,
          sizedBlocked: context.sizeBlocked || undefined,
        };
      done?.(category, findings?.length, false);
    },
  );
  // Re-read before merging, so a category another run stored meanwhile survives.
  const latest = read(context.paths);
  const base = latest?.fingerprint === print ? latest.entries : {};
  write(context.paths, { fingerprint: print, owners: ownerFingerprint(context), entries: { ...base, ...scanned } });
  const reused = cached.flatMap((category) => usable[category]?.findings ?? []);
  return {
    ...report,
    categoryScannedAt: {
      ...report.categoryScannedAt,
      ...Object.fromEntries(cached.map((category) => [category, usable[category]?.scannedAt])),
    },
    findings: [...report.findings, ...withHolds(context, reused)].sort((a, b) => b.bytes - a.bytes),
    cached,
    live: reuse ? only.filter((category) => maxAge[category] === 0) : [],
  };
}

/**
 * The categories that hold these finding ids or paths, so planning by them rescans only those: the last stored scan
 * names them whatever its idle windows were, and a claimed path is an agent finding by definition, scanned or not.
 * Undefined when any target is unknown, which leaves the caller to rescan everything.
 */
export function categoriesOf(context: Context, targets: readonly string[]): Category[] | undefined {
  const stored = read(context.paths);
  const owner = new Map<string, Category>();
  for (const claim of readLedger(context.paths).claims) owner.set(findingId("agent", claim.path, "").id, "agent");
  if (stored && stored.owners === ownerFingerprint(context)) {
    for (const [category, entry] of Object.entries(stored.entries) as [Category, Entry][]) {
      for (const finding of entry.findings) owner.set(finding.id, category);
    }
  }
  const found = targets.map((target) =>
    targetIds(target)
      .map((id) => owner.get(id))
      .find(Boolean),
  );
  if (found.some((category) => !category)) return undefined;
  return [...new Set(found as Category[])];
}
