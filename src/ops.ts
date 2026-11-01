import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit, withLock } from "./ledger";
import type { Config, Context } from "./scanners";
import { defaultStaleDays, lowestPriority, scan } from "./scanners";
import { defaultPaths, liveFiles, niceness, type Paths, run } from "./system";
import {
  eligible,
  type Finding,
  type Plan,
  type Reniced,
  type Risk,
  risks,
  schemaVersion,
  type Transaction,
  type TrashEntry,
} from "./types";

export function loadConfig(paths: Paths): Config {
  const defaults: Config = { agentRoots: [], agentCachePatterns: [], repoRoots: [] };
  try {
    return { ...defaults, ...(Bun.TOML.parse(readFileSync(paths.config, "utf8")) as Partial<Config>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw new Error(`cannot read ${paths.config}: ${error}`);
  }
}

export function context(staleDays = defaultStaleDays, paths: Paths = defaultPaths()): Context {
  return { paths, config: loadConfig(paths), live: liveFiles(), now: Date.now(), staleDays };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const newId = () => randomBytes(4).toString("hex");

export function createPlan(paths: Paths, findings: readonly Finding[], staleDays: number, now = Date.now()): Plan {
  const plan: Plan = {
    schemaVersion,
    id: newId(),
    createdAt: new Date(now).toISOString(),
    findingIds: findings.map((finding) => finding.id),
    bytes: findings.reduce((sum, finding) => sum + finding.bytes, 0),
    staleDays,
  };
  writeJson(join(paths.state, "plans", `${plan.id}.json`), plan);
  return plan;
}

export function readPlan(paths: Paths, id: string): Plan {
  return JSON.parse(readFileSync(join(paths.state, "plans", `${id}.json`), "utf8")) as Plan;
}

export interface Outcome {
  applied: string[];
  /** Plan items that changed or gained a blocker since planning. Nothing was done to them. */
  stale: string[];
  failed: { id: string; error: string }[];
  bytes: number;
  /** Processes whose priority was lowered, which frees no space but is the point of a quiet machine again. */
  reniced: number;
  transaction?: string;
}

async function execute(finding: Finding, _paths: Paths, tx: Transaction, base: string): Promise<void> {
  if (finding.action === "renice") {
    let changed = 0;
    for (const pid of finding.pids ?? []) {
      const nice = niceness(pid);
      if (nice === undefined || nice >= lowestPriority) continue; // gone, or already at the bottom
      if ((await run(["renice", "-n", String(lowestPriority), "-p", String(pid)])).code !== 0) continue;
      tx.reniced.push({ pid, nice });
      changed++;
    }
    if (changed === 0) throw new Error("no process in this group could be reniced");
    return;
  }
  if (finding.action === "trash") {
    for (const original of finding.paths) {
      const trashed = join(base, String(tx.entries.length));
      try {
        renameSync(original, trashed);
      } catch (error) {
        // A worktree and its own build output can share a plan, so the parent's move may have taken this path.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const entry: TrashEntry = { original, trashed, bytes: finding.paths.length === 1 ? finding.bytes : 0 };
      if (finding.gitDir) entry.gitDir = finding.gitDir;
      tx.entries.push(entry);
    }
    return;
  }
  const command: Record<string, string[]> = {
    paccache: ["sudo", "-n", "paccache", "-rk1"],
    "remove-packages": ["sudo", "-n", "pacman", "-Rns", "--noconfirm", ...finding.packages],
    "uv-prune": ["uv", "cache", "prune"],
  };
  const argv = command[finding.action];
  if (!argv) throw new Error(`action ${finding.action} cannot be applied`);
  const result = await run(argv);
  if (result.code !== 0) throw new Error(result.stderr || `${argv[0]} exited ${result.code}`);
  if (finding.action === "remove-packages") tx.removedPackages.push(...finding.packages);
}

/** Rescans and re-matches ids first: a plan is approval for the state it saw, not for whatever is there now. */
export function applyPlan(plan: Plan, ctx: Context): Promise<Outcome> {
  return withLock(ctx.paths, async () => {
    const outcome = await applyUnlocked(plan, ctx);
    audit(ctx.paths, "apply", { plan: plan.id, ...outcome });
    return outcome;
  });
}

async function applyUnlocked(plan: Plan, ctx: Context): Promise<Outcome> {
  const current = new Map(
    (await scan({ ...ctx, staleDays: plan.staleDays })).findings.map((finding) => [finding.id, finding]),
  );
  const outcome: Outcome = { applied: [], stale: [], failed: [], bytes: 0, reniced: 0 };
  const id = newId();
  const base = join(ctx.paths.trash, id);
  mkdirSync(base, { recursive: true });
  const tx: Transaction = {
    schemaVersion,
    id,
    appliedAt: new Date(ctx.now).toISOString(),
    entries: [],
    removedPackages: [],
    reniced: [],
  };
  for (const findingId of plan.findingIds) {
    const finding = current.get(findingId);
    if (!finding || !eligible(finding)) {
      outcome.stale.push(findingId);
      continue;
    }
    const reniced = tx.reniced.length;
    try {
      await execute(finding, ctx.paths, tx, base);
      outcome.applied.push(findingId);
      outcome.bytes += finding.bytes;
      outcome.reniced += tx.reniced.length - reniced;
    } catch (error) {
      outcome.failed.push({ id: findingId, error: String(error) });
    }
    writeJson(join(base, "transaction.json"), tx);
  }
  if (outcome.applied.length === 0) rmSync(base, { recursive: true, force: true });
  else outcome.transaction = id;
  return outcome;
}

export function transactions(paths: Paths): Transaction[] {
  let dirs: string[];
  try {
    dirs = readdirSync(paths.trash);
  } catch {
    return [];
  }
  return dirs.flatMap((dir) => {
    try {
      return [JSON.parse(readFileSync(join(paths.trash, dir, "transaction.json"), "utf8")) as Transaction];
    } catch {
      return [];
    }
  });
}

/** Raising a nice value back needs root, so an unprivileged attempt is followed by keeper's usual `sudo -n`. */
async function restorePriority(entry: Reniced): Promise<boolean> {
  const argv = ["renice", "-n", String(entry.nice), "-p", String(entry.pid)];
  return (await run(argv)).code === 0 || (await run(["sudo", "-n", ...argv])).code === 0;
}

export async function undo(
  paths: Paths,
  id: string,
): Promise<{ restored: string[]; removedPackages: string[]; reniced: number; stuck: Reniced[] }> {
  const tx = transactions(paths).find((candidate) => candidate.id === id);
  if (!tx) throw new Error(`no transaction ${id}`);
  const restored: string[] = [];
  for (const entry of tx.entries) {
    mkdirSync(dirname(entry.original), { recursive: true });
    renameSync(entry.trashed, entry.original);
    restored.push(entry.original);
  }
  // A process that has since exited cannot be put back, and one at the bottom cannot be raised without root.
  let reniced = 0;
  const stuck: Reniced[] = [];
  for (const entry of tx.reniced ?? []) {
    if (await restorePriority(entry)) reniced++;
    else stuck.push(entry);
  }
  rmSync(join(paths.trash, id), { recursive: true, force: true });
  audit(paths, "undo", { transaction: id, restored: restored.length, reniced, stuck: stuck.length });
  return { restored, removedPackages: tx.removedPackages, reniced, stuck };
}

/** Deletion is final here, so git metadata for trashed worktrees is pruned only now and undo keeps working until then. */
export function purge(
  paths: Paths,
  olderThanDays: number,
  now = Date.now(),
): Promise<{ purged: string[]; bytes: number }> {
  return withLock(paths, async () => {
    const result = await purgeUnlocked(paths, olderThanDays, now);
    if (result.purged.length) audit(paths, "purge", result);
    return result;
  });
}

async function purgeUnlocked(
  paths: Paths,
  olderThanDays: number,
  now: number,
): Promise<{ purged: string[]; bytes: number }> {
  const purged: string[] = [];
  let bytes = 0;
  for (const tx of transactions(paths)) {
    if (now - statSync(join(paths.trash, tx.id)).mtimeMs < olderThanDays * 86_400_000) continue;
    rmSync(join(paths.trash, tx.id), { recursive: true, force: true });
    for (const gitDir of new Set(tx.entries.flatMap((entry) => (entry.gitDir ? [entry.gitDir] : [])))) {
      await run(["git", "--git-dir", gitDir, "worktree", "prune"]);
    }
    purged.push(tx.id);
    bytes += tx.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
  return { purged, bytes };
}

export function withinRisk(finding: Finding, max: Risk): boolean {
  return risks.indexOf(finding.risk) <= risks.indexOf(max);
}

export async function freeBytes(path: string): Promise<number> {
  const df = await run(["df", "-B1", "--output=avail", path]);
  return Number(df.stdout.split("\n").at(-1)) || 0;
}
