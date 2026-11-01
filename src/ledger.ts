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
}

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

export function readAudit(paths: Paths, limit: number): unknown[] {
  try {
    const lines = readFileSync(join(paths.state, "audit.jsonl"), "utf8").trim().split("\n");
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
