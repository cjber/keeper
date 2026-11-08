import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Paths } from "./system";

/** What an agent declared itself, which outranks anything a scanner can infer. */
export interface Hold {
  path: string;
  until: string;
  reason: string;
  actor: string;
  /** When it was made. Holds written before this field existed find it in the audit log. */
  at?: string;
}

/** A hold protects a path for one working day at most, so a hold left by a finished session lapses on its own. */
export const holdLimitMs = 86_400_000;

export interface Claim {
  path: string;
  actor: string;
  at: string;
}

export interface Ledger {
  holds: Hold[];
  claims: Claim[];
}

export class BusyError extends Error {}

export function actor(): string {
  return process.env.KEEPER_ACTOR ?? `pid:${process.ppid}`;
}

function ledgerPath(paths: Paths): string {
  return join(paths.state, "ledger.json");
}

export function readLedger(paths: Paths): Ledger {
  try {
    return JSON.parse(readFileSync(ledgerPath(paths), "utf8")) as Ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { holds: [], claims: [] };
    throw error;
  }
}

export function writeLedger(paths: Paths, ledger: Ledger): void {
  mkdirSync(paths.state, { recursive: true });
  const temporary = `${ledgerPath(paths)}.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, ledgerPath(paths));
}

export function audit(paths: Paths, event: string, detail: object): void {
  mkdirSync(paths.state, { recursive: true });
  const entry = { at: new Date().toISOString(), actor: actor(), event, ...detail };
  appendFileSync(join(paths.state, "audit.jsonl"), `${JSON.stringify(entry)}\n`);
}

/**
 * The holds still in force at `now`, each ending at its `until` or a day after it was made, whichever comes first.
 * A hold whose start cannot be found keeps its `until`, with a warning, rather than being dropped.
 */
export function liveHolds(paths: Paths, now: number): Hold[] {
  const holds = readLedger(paths).holds;
  const made = holds.some((hold) => !hold.at) ? holdEvents(paths) : new Map<string, string>();
  return holds.flatMap((hold) => {
    const at = hold.at ?? made.get(`${hold.path}\0${hold.until}`);
    if (!at)
      console.warn(`keeper: no record of when the hold on ${hold.path} was made, so it lasts until ${hold.until}`);
    const end = at ? Math.min(Date.parse(hold.until), Date.parse(at) + holdLimitMs) : Date.parse(hold.until);
    return end > now ? [{ ...hold, until: new Date(end).toISOString() }] : [];
  });
}

function holdEvents(paths: Paths): Map<string, string> {
  const events = readAudit(paths, Number.MAX_SAFE_INTEGER) as {
    event?: string;
    path?: string;
    until?: string;
    at?: string;
  }[];
  return new Map(
    events
      .filter((entry) => entry.event === "hold" && entry.at)
      .map((entry) => [`${entry.path}\0${entry.until}`, entry.at as string]),
  );
}

export function readAudit(paths: Paths, limit: number): unknown[] {
  try {
    const lines = readFileSync(join(paths.state, "audit.jsonl"), "utf8").trim().split("\n");
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Whether a process exists. EPERM means it does but another user owns it, and 0 or less names a process group. */
export function alive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One mutation at a time across every agent. A lock left by a dead process is taken over. */
export async function withLock<T>(paths: Paths, work: () => Promise<T>): Promise<T> {
  mkdirSync(paths.state, { recursive: true });
  const lock = join(paths.state, "lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    const owner = Number(readFileSync(lock, "utf8"));
    if (alive(owner)) throw new BusyError(`another keeper run holds the lock (pid ${owner})`);
    rmSync(lock, { force: true });
    fd = openSync(lock, "wx");
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Changes the ledger under the lock, so a hold cannot land between an apply's check and its move.
 * Returns the ledger as it was before the change.
 */
export function updateLedger(paths: Paths, change: (ledger: Ledger) => Ledger): Promise<Ledger> {
  return withLock(paths, async () => {
    const before = readLedger(paths);
    writeLedger(paths, change(before));
    return before;
  });
}
