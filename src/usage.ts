import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Paths, run } from "./system";

/**
 * When keeper first recorded usage, the last time a process from each package was seen, and the hours it actually
 * sampled. Coverage is counted from `samples`, never from `since`: a timer that stopped or a machine that was off
 * leaves a gap, and that gap extends the window rather than counting as watched.
 */
export interface UsageLedger {
  since: string;
  sampledAt: string;
  /** ISO time of the last sample in each UTC hour bucket, `YYYY-MM-DDTHH`. Absent in ledgers from older versions. */
  samples?: Record<string, string>;
  /** Package name to the last time one of its executables was running. */
  packages: Record<string, string>;
}

const usagePath = (paths: Paths) => join(paths.state, "last-seen.json");
const day = 86_400_000;

/** Complete days of coverage ending at `now`, counting only days that hold a sample. */
export function coveredDays(ledger: UsageLedger, now: number): number {
  if (!ledger.samples) return 0; // An older ledger has no evidence of gaps, so its coverage restarts.
  const sampled = new Set(Object.keys(ledger.samples).map((bucket) => bucket.slice(0, 10)));
  const today = new Date(now).toISOString().slice(0, 10);
  let cursor = Date.parse(`${today}T00:00:00Z`);
  // The sample due today may not have run yet, so an empty today does not by itself mean the watch stopped.
  if (!sampled.has(today)) cursor -= day;
  let days = 0;
  while (sampled.has(new Date(cursor).toISOString().slice(0, 10))) {
    days++;
    cursor -= day;
  }
  return days;
}

export function readUsage(paths: Paths): UsageLedger | undefined {
  try {
    return JSON.parse(readFileSync(usagePath(paths), "utf8")) as UsageLedger;
  } catch {
    return undefined;
  }
}

/** Atomic, so a scan never reads a half-written ledger. */
export function writeUsage(paths: Paths, ledger: UsageLedger): void {
  mkdirSync(paths.state, { recursive: true });
  const temporary = `${usagePath(paths)}.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, usagePath(paths));
}

/**
 * Executables of this user's running processes. `/proc/<pid>/exe` is the real path, which pacman can own even when
 * the command was started through a symlink. A process whose exe cannot be read falls back to its comm, as a script
 * or a deleted binary might. Only this user's processes are read, and nothing needs root.
 */
export function runningExecutables(uid = process.getuid?.() ?? -1): string[] {
  const executables = new Set<string>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = `/proc/${name}`;
    try {
      if (uid >= 0 && statSync(pid).uid !== uid) continue;
    } catch {
      continue;
    }
    try {
      const exe = readlinkSync(`${pid}/exe`).replace(/ \(deleted\)$/, "");
      if (exe.startsWith("/")) executables.add(exe);
    } catch {
      try {
        const comm = readFileSync(`${pid}/comm`, "utf8").trim();
        const candidate = `/usr/bin/${comm}`;
        if (comm && existsSync(candidate)) executables.add(candidate);
      } catch {}
    }
  }
  return [...executables];
}

/** Pacman's owner for each executable path, in batches so a sample starts a handful of processes rather than dozens. */
async function packageOwners(paths: readonly string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let start = 0; start < paths.length; start += 200) {
    const batch = paths.slice(start, start + 200);
    // pacman exits non-zero when any path is unowned, but still prints the ones it does own.
    const result = await run(["pacman", "-Qo", "--", ...batch]);
    for (const line of result.stdout.split("\n")) {
      const match = /^(.+) is owned by (\S+) /.exec(line);
      if (match) owners.set(match[1] as string, match[2] as string);
    }
  }
  return owners;
}

export interface UsageOptions {
  /** Replaces the /proc walk, so a test can describe a machine. */
  executables?: readonly string[];
  /** Replaces the pacman lookup, so a test never touches the package database. */
  ownerOf?: (path: string) => Promise<string | undefined>;
  uid?: number;
  now?: number;
}

/**
 * Records what is running now into the last-seen ledger. A scanner reads this rather than atime, which is not evidence
 * of use. Called by sample, which the hourly timer already runs.
 */
export async function recordUsage(paths: Paths, options: UsageOptions = {}): Promise<UsageLedger> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const previous = readUsage(paths);
  const executables = [...new Set(options.executables ?? runningExecutables(options.uid))];
  let owned: Map<string, string>;
  if (options.ownerOf) {
    const entries = await Promise.all(executables.map(async (path) => [path, await options.ownerOf?.(path)] as const));
    owned = new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
  } else {
    owned = await packageOwners(executables);
  }
  const packages = { ...(previous?.packages ?? {}) };
  for (const packageName of new Set(owned.values())) packages[packageName] = at;
  const hour = at.slice(0, 13);
  const samples = { ...(previous?.samples ?? {}), [hour]: at };
  const ledger: UsageLedger = { since: previous?.since ?? at, sampledAt: at, samples, packages };
  writeUsage(paths, ledger);
  return ledger;
}
