import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { forget, forgetUnder } from "./cache";
import { audit, withLock } from "./ledger";
import type { Config, Context } from "./scanners";
import {
  defaultAppStaleDays,
  defaultConfig,
  defaultStaleDays,
  defaultTheme,
  dockerCacheHours,
  logKeepBytes,
  lowestPriority,
  scan,
} from "./scanners";
import { defaultPaths, expandHome, liveFiles, niceness, type Paths, run, waitFor } from "./system";
import {
  bulkEligible,
  count,
  eligible,
  type Finding,
  outermost,
  type Plan,
  type Reniced,
  type Risk,
  risks,
  schemaVersion,
  type Transaction,
  type TrashEntry,
} from "./types";

export function loadConfig(paths: Paths): Config {
  let parsed: Partial<Config>;
  try {
    parsed = Bun.TOML.parse(readFileSync(paths.config, "utf8")) as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig;
    throw new Error(`cannot read ${paths.config}: ${error}`);
  }
  // A misspelt key must not leave a path unprotected or a root unscanned without anyone noticing.
  const unknown = [
    ...Object.keys(parsed).filter((key) => !(key in defaultConfig)),
    ...Object.keys(parsed.theme ?? {})
      .filter((key) => !(key in defaultTheme))
      .map((key) => `theme.${key}`),
  ];
  if (unknown.length) throw new Error(`unknown keys in ${paths.config}: ${unknown.join(", ")}`);
  return { ...defaultConfig, ...parsed, theme: { ...defaultTheme, ...parsed.theme } };
}

function configuredPaths(paths: Paths, config: Config): Paths {
  const expand = expandHome(paths.home);
  return {
    ...paths,
    worktrees: config.worktreeRoots.length ? config.worktreeRoots.map(expand) : paths.worktrees,
    aurClones: config.aurClones.length ? config.aurClones.map(expand) : paths.aurClones,
  };
}

export function context(
  staleDays = defaultStaleDays,
  appStaleDays = defaultAppStaleDays,
  paths: Paths = defaultPaths(),
): Context {
  const config = loadConfig(paths);
  return {
    paths: configuredPaths(paths, config),
    config,
    live: liveFiles(),
    now: Date.now(),
    staleDays,
    appStaleDays,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const newId = () => randomBytes(4).toString("hex");

export function createPlan(
  paths: Paths,
  chosen: readonly Finding[],
  staleDays: number,
  appStaleDays = defaultAppStaleDays,
  now = Date.now(),
): Plan {
  const findings = outermost(chosen);
  const plan: Plan = {
    schemaVersion,
    id: newId(),
    createdAt: new Date(now).toISOString(),
    findingIds: findings.map((finding) => finding.id),
    states: Object.fromEntries(findings.map((finding) => [finding.id, finding.state])),
    categories: [...new Set(findings.map((finding) => finding.category))],
    bytes: findings.reduce((sum, finding) => sum + finding.bytes, 0),
    staleDays,
    appStaleDays,
  };
  writeJson(join(paths.state, "plans", `${plan.id}.json`), plan);
  return plan;
}

/**
 * The findings named by id. An id that vanished or gained a blocker since the scan is skipped with its reason, so one
 * of them never costs the rest of the plan.
 */
export function pickById(
  findings: readonly Finding[],
  ids: readonly string[],
): { chosen: Finding[]; skipped: { id: string; reason: string }[] } {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const chosen: Finding[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const finding = byId.get(id);
    if (!finding) skipped.push({ id, reason: "no such finding now" });
    else if (!eligible(finding))
      skipped.push({ id, reason: `not eligible: ${finding.blockers.join("; ") || finding.action}` });
    else chosen.push(finding);
  }
  return { chosen, skipped };
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
  /** Orphaned processes that were ended. Unlike a renice, undo cannot bring them back. */
  stopped: number;
  transaction?: string;
}

/**
 * Paths per `mv`, and their argv bytes, well under ARG_MAX. A temp dir sweep moves tens of thousands, and one process
 * per path takes minutes.
 */
const moveBatch = 1000;
const moveBatchBytes = 128 * 1024;

type Move = [from: string, to: string];

/**
 * `mv` rather than rename, because a configured root or the temp dir may sit on a different filesystem from the trash.
 * Moves that keep their name and share both parents go in batches. Returns the moves that happened and the first error,
 * so a batch that failed partway still records what it took. `--no-clobber` keeps a path that appeared meanwhile.
 */
async function moveAll(moves: readonly Move[]): Promise<{ moved: Move[]; error?: string }> {
  const batches = new Map<string, Move[]>();
  for (const move of moves) {
    const [from, to] = move;
    const key = basename(from) === basename(to) ? `${dirname(from)}\0${dirname(to)}` : `${from}\0${to}`;
    const batch = batches.get(key);
    if (batch) batch.push(move);
    else batches.set(key, [move]);
  }
  const moved: Move[] = [];
  let error: string | undefined;
  for (const batch of batches.values()) {
    for (let start = 0; start < batch.length; ) {
      let end = start + 1;
      for (let bytes = 0; end < batch.length && end - start < moveBatch; end++) {
        bytes += (batch[end] as Move)[0].length + 1;
        if (bytes > moveBatchBytes) break;
      }
      const chunk = batch.slice(start, end);
      start = end;
      const [from, to] = chunk[0] as Move;
      mkdirSync(dirname(to), { recursive: true });
      const argv =
        basename(from) === basename(to)
          ? ["mv", "--no-clobber", "--target-directory", dirname(to), "--", ...chunk.map(([source]) => source)]
          : ["mv", "--no-clobber", "--no-target-directory", "--", from, to];
      const result = await run(argv);
      const done = chunk.filter(([source, target]) => existsSync(target) && !existsSync(source));
      moved.push(...done);
      if (done.length < chunk.length)
        error ??= result.stderr || `${count(chunk.length - done.length, "path")} did not move`;
    }
  }
  return { moved, error };
}

/** Transcripts leave one directory per session behind. rmdir only ever removes an empty directory. */
function removeEmptyParents(path: string, home: string): void {
  for (let dir = dirname(path); dir.startsWith(`${home}/`); dir = dirname(dir)) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** How long a stopped process gets to exit on SIGTERM before SIGKILL. */
const stopGraceMs = 5000;

function autogroupNice(pid: number): number | undefined {
  try {
    return Number(readFileSync(`/proc/${pid}/autogroup`, "utf8").split(" ")[2]);
  } catch {
    return undefined;
  }
}

/** The kernel lets an unprivileged caller change an autogroup's nice once per 100 ms, machine-wide, and EAGAINs. */
async function setAutogroupNice(pid: number, nice: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      writeFileSync(`/proc/${pid}/autogroup`, String(nice));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return false;
      await Bun.sleep(110);
    }
  }
  return false;
}

/** A zombie has already exited and only waits for its parent, so it counts as gone. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
}

/** SIGTERM, then SIGKILL after the grace period. A process that exits on its own meanwhile is not an error. */
async function stop(pid: number): Promise<boolean> {
  if (!running(pid)) return false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return true; // it exited between the check and the signal
    }
    for (const deadline = Date.now() + stopGraceMs; Date.now() < deadline; await Bun.sleep(100))
      if (!running(pid)) return true;
  }
  return !running(pid);
}

/**
 * `slot` is the finding's own directory in the transaction, so names from different findings never meet. Returns how
 * many processes it stopped.
 */
async function execute(finding: Finding, paths: Paths, tx: Transaction, slot: string): Promise<number> {
  if (finding.action === "stop") {
    let stopped = 0;
    for (const pid of finding.pids ?? []) if (await stop(pid)) stopped++;
    if (stopped === 0) throw new Error("the process had already exited");
    return stopped;
  }
  if (finding.action === "renice") {
    let changed = 0;
    for (const pid of [...(finding.pids ?? []), ...(finding.parent ? [finding.parent] : [])]) {
      const nice = niceness(pid);
      if (nice === undefined || nice >= lowestPriority) continue; // gone, or already at the bottom
      if ((await run(["renice", "-n", String(lowestPriority), "-p", String(pid)])).code !== 0) continue;
      tx.reniced.push({ pid, nice });
      changed++;
    }
    // A process's own nice only competes inside its session's autogroup, so the group is lowered too. Raising the
    // nice of an autogroup needs no root, which also makes it the part undo can always put back.
    for (const pid of finding.autogroups ?? []) {
      const nice = autogroupNice(pid);
      if (nice === undefined || nice >= lowestPriority || !(await setAutogroupNice(pid, lowestPriority))) continue;
      tx.reniced.push({ pid, nice, autogroup: true });
      changed++;
    }
    if (changed === 0) throw new Error("no process in this group could be reniced");
    return 0;
  }
  if (finding.action === "trash") {
    // Names repeat across a finding's parents, so each repeat goes in a slot of its own.
    const seen = new Map<string, number>();
    // A worktree and its own build output can share a plan, so the parent's move may have taken a path.
    const pairs = finding.paths
      .filter((path) => existsSync(path))
      .map((original) => {
        const name = basename(original);
        const repeat = seen.get(name) ?? 0;
        seen.set(name, repeat + 1);
        return [original, join(repeat ? `${slot}.${repeat}` : slot, name)] satisfies Move;
      });
    const { moved, error } = await moveAll(pairs);
    const { gitDir, branch, head } = finding;
    const bytes = finding.paths.length === 1 ? finding.bytes : 0;
    for (const [original, trashed] of moved) {
      tx.entries.push({ original, trashed, bytes, gitDir, branch, head });
      if (finding.category === "transcripts") removeEmptyParents(original, paths.home);
    }
    if (error) throw new Error(error);
    return 0;
  }
  if (finding.action === "truncate") {
    for (const path of finding.paths) {
      // Written in place: a rename would leave the running writer appending to a deleted file.
      const start = Math.max(0, statSync(path).size - logKeepBytes);
      const tail = await Bun.file(path).slice(start).arrayBuffer();
      writeFileSync(path, Buffer.from(tail));
    }
    return 0;
  }
  const command: Record<string, string[]> = {
    paccache: ["sudo", "-n", "paccache", "-rk1"],
    "remove-packages": ["sudo", "-n", "pacman", "-Rns", "--noconfirm", ...finding.packages],
    "uv-prune": ["env", "UV_LOCK_TIMEOUT=5", "uv", "cache", "prune"],
    "pnpm-prune": ["pnpm", "store", "prune"],
    "npm-clean": ["npm", "cache", "clean", "--force"],
    "bun-clean": ["bun", "pm", "cache", "rm"],
    "docker-image-prune": ["docker", "image", "prune", "--force"],
    "docker-builder-prune": ["docker", "builder", "prune", "--force", "--filter", `until=${dockerCacheHours}h`],
  };
  const argv = command[finding.action];
  if (!argv) throw new Error(`action ${finding.action} cannot be applied`);
  const result = await run(argv);
  if (result.code !== 0) throw new Error(result.stderr || `${argv[0]} exited ${result.code}`);
  if (finding.action === "remove-packages") tx.removedPackages.push(...finding.packages);
  return 0;
}

/** Rescans and re-matches ids first: a plan is approval for the state it saw, not for whatever is there now. */
export function applyPlan(plan: Plan, ctx: Context): Promise<Outcome> {
  return withLock(ctx.paths, async () => {
    const outcome = await applyUnlocked(plan, ctx);
    forget(ctx.paths, plan.categories);
    audit(ctx.paths, "apply", { plan: plan.id, ...outcome });
    return outcome;
  });
}

async function applyUnlocked(plan: Plan, ctx: Context): Promise<Outcome> {
  const current = new Map(
    (
      await scan(
        {
          ...ctx,
          staleDays: plan.staleDays,
          appStaleDays: plan.appStaleDays ?? ctx.appStaleDays,
          sizeOnly: new Set(plan.findingIds),
        },
        plan.categories,
      )
    ).findings.map((finding) => [finding.id, finding]),
  );
  const outcome: Outcome = { applied: [], stale: [], failed: [], bytes: 0, reniced: 0, stopped: 0 };
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
  for (const [index, findingId] of plan.findingIds.entries()) {
    const finding = current.get(findingId);
    if (!finding || finding.state !== plan.states?.[findingId] || !eligible(finding)) {
      outcome.stale.push(findingId);
      continue;
    }
    const reniced = tx.reniced.length;
    try {
      outcome.stopped += await execute(finding, ctx.paths, tx, join(base, String(index)));
      outcome.applied.push(findingId);
      outcome.bytes += finding.bytes;
      outcome.reniced += tx.reniced.length - reniced;
    } catch (error) {
      outcome.failed.push({ id: findingId, error: String(error) });
    }
    writeJson(join(base, "transaction.json"), tx);
  }
  forgetUnder(
    ctx.paths,
    tx.entries.map((entry) => entry.original),
  );
  // A finding that failed partway still moved paths, and the transaction is the only way back to them.
  if (outcome.applied.length === 0 && tx.entries.length === 0) rmSync(base, { recursive: true, force: true });
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
  if (entry.autogroup) return setAutogroupNice(entry.pid, entry.nice);
  const argv = ["renice", "-n", String(entry.nice), "-p", String(entry.pid)];
  return (await run(argv)).code === 0 || (await run(["sudo", "-n", ...argv])).code === 0;
}

export interface Undone {
  restored: string[];
  removedPackages: string[];
  reniced: number;
  stuck: Reniced[];
}

export function undo(paths: Paths, id: string): Promise<Undone> {
  return withLock(paths, async () => {
    const undone = await undoUnlocked(paths, id);
    // A transaction does not record categories, and restored paths can be in any of them.
    forget(paths);
    return undone;
  });
}

async function undoUnlocked(paths: Paths, id: string): Promise<Undone> {
  const tx = transactions(paths).find((candidate) => candidate.id === id);
  if (!tx) throw new Error(`no transaction ${id}`);
  // Entries already moved back by an interrupted undo are skipped, so running it again finishes the job.
  const pending = tx.entries.filter((entry) => existsSync(entry.trashed));
  const taken = pending.filter((entry) => existsSync(entry.original)).map((entry) => entry.original);
  if (taken.length) throw new Error(`nothing restored, these paths exist again: ${taken.join(", ")}`);
  const { moved, error } = await moveAll(pending.map((entry): Move => [entry.trashed, entry.original]));
  const restored = moved.map(([, original]) => original);
  if (error) throw new Error(`restored ${restored.length} of ${pending.length}, run undo again to finish: ${error}`);
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
export interface Purged {
  purged: string[];
  /** Uncompressed size of what was purged, which a compressing filesystem such as btrfs stores in far less. */
  bytes: number;
  /** Measured gain in free space. Other writers on the machine can make it lower than what was truly released. */
  freed: number;
  /**
   * Transactions kept because the purge hook failed or their files could not be removed, so the next purge tries them
   * again.
   */
  failed: string[];
  /** Why each failed transaction was kept, by its id. */
  errors: Record<string, string>;
}

export function purge(paths: Paths, olderThanDays: number, now = Date.now()): Promise<Purged> {
  return withLock(paths, async () => {
    const result = await purgeUnlocked(paths, olderThanDays, now);
    if (result.purged.length) audit(paths, "purge", result);
    return result;
  });
}

/** The hook sees the trashed tree, which still holds whatever it needs to read, such as a worktree's .env. */
async function runPurgeHook(hook: string, entries: readonly TrashEntry[]): Promise<boolean> {
  for (const entry of entries.filter((item) => item.gitDir)) {
    if ((await run([hook, entry.trashed, entry.original])).code !== 0) return false;
  }
  return true;
}

/**
 * Deletes a trash directory. `rm` cannot unlink entries inside a directory it may not write to, and a trashed tree
 * keeps its modes, so one read-only directory would hold a whole transaction. The trash is keeper's own, so on a
 * refusal every directory the user owns gets its permissions back and the removal runs once more. The walk happens only
 * then, because a purge is usually many gigabytes that need no repair.
 */
async function removeTrash(dir: string): Promise<void> {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
  }
  // `-exec ... ;` runs on a directory before find descends into it, so a tree find could not read opens up as it goes.
  const locked = ["-type", "d", "-user", String(process.getuid?.()), "!", "-perm", "-u=rwx"];
  await run(["find", dir, "-xdev", ...locked, "-exec", "chmod", "u+rwx", "{}", ";"]);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Mount points strictly below `dir`. A recursive remove does not stop at a mount point, and a directory holding one can
 * be renamed into the trash, so a purge would delete whatever that filesystem holds. The mount point is field 5 of
 * each mountinfo line, with space, tab, newline and backslash escaped as octal.
 */
export function mountsWithin(mountinfo: string, dir: string): string[] {
  const prefix = `${dir}/`;
  return mountinfo
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter((point): point is string => point !== undefined)
    .map((point) =>
      point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
    )
    .filter((point) => point.startsWith(prefix));
}

async function purgeUnlocked(paths: Paths, olderThanDays: number, now: number): Promise<Purged> {
  const { purgeHook } = loadConfig(paths);
  const purged: string[] = [];
  const failed: string[] = [];
  const errors: Record<string, string> = {};
  const freeBefore = await freeBytes(paths.home);
  let bytes = 0;
  const known = new Map(transactions(paths).map((tx) => [tx.id, tx]));
  // An unreadable mount table is a failed lookup, so it keeps every transaction instead of reading as "no mounts".
  let mountinfo: string | undefined;
  let mountError = "";
  try {
    mountinfo = readFileSync(paths.mountinfo, "utf8");
  } catch (error) {
    mountError = `the mount table could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Every directory in the trash is a transaction, but one whose manifest went missing cannot be found by
  // `transactions`. An interrupted purge leaves exactly that, so past the window it is still trash: delete it.
  let ids: string[] = [];
  try {
    ids = readdirSync(paths.trash);
  } catch {}
  for (const id of ids) {
    const dir = join(paths.trash, id);
    // Clamped, because a file timestamp can land a fraction of a millisecond after the clock read and 0 means everything.
    const age = Math.max(0, now - statSync(dir).mtimeMs);
    if (age < olderThanDays * 86_400_000) continue;
    if (mountinfo === undefined) {
      failed.push(id);
      errors[id] = mountError;
      continue;
    }
    const mounts = mountsWithin(mountinfo, realpathSync(dir));
    if (mounts.length) {
      failed.push(id);
      errors[id] = `a filesystem is mounted inside it, unmount it first: ${mounts.join(", ")}`;
      continue;
    }
    const tx = known.get(id);
    if (tx && purgeHook && !(await runPurgeHook(expandHome(paths.home)(purgeHook), tx.entries))) {
      failed.push(id);
      errors[id] = "the purge hook failed";
      continue;
    }
    // One transaction that cannot be removed is reported and kept, and the rest are still purged.
    try {
      await removeTrash(dir);
    } catch (error) {
      failed.push(id);
      errors[id] = error instanceof Error ? error.message : String(error);
      continue;
    }
    // A manifest-less directory names neither a branch nor a worktree, so there is nothing to prune for it.
    if (!tx) {
      purged.push(id);
      continue;
    }
    for (const gitDir of new Set(tx.entries.flatMap((entry) => (entry.gitDir ? [entry.gitDir] : [])))) {
      await run(["git", "--git-dir", gitDir, "worktree", "prune"]);
    }
    for (const { gitDir, branch, head } of tx.entries) {
      // Passing the old value makes this a no-op on a branch that moved after the worktree was trashed.
      if (gitDir && branch && head)
        await run(["git", "--git-dir", gitDir, "update-ref", "-d", `refs/heads/${branch}`, head]);
    }
    purged.push(id);
    bytes += tx.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
  // Flushing a whole filesystem can take seconds, so only a purge that removed something measures.
  if (purged.length === 0) return { purged, bytes, freed: 0, failed, errors };
  // Copy-on-write filesystems release space when the transaction commits, so measuring now needs a sync. A busy
  // disk can take far longer to flush, and the lock is held meanwhile, so past two seconds `freed` may undercount.
  await waitFor(["sync", "--file-system", paths.home], 2000);
  return { purged, bytes, freed: Math.max(0, (await freeBytes(paths.home)) - freeBefore), failed, errors };
}

export function withinRisk(finding: Finding, max: Risk): boolean {
  return risks.indexOf(finding.risk) <= risks.indexOf(max);
}

/**
 * What `keeper plan` takes without ids. Personal files and apps carry `explicit`, so no risk ceiling sweep can
 * reach them: their ids are the only way in.
 */
export function bulkPlan(findings: readonly Finding[], max: Risk): Finding[] {
  return findings.filter((finding) => bulkEligible(finding) && withinRisk(finding, max));
}

export async function freeBytes(path: string): Promise<number> {
  const df = await run(["df", "-B1", "--output=avail", path]);
  return Number(df.stdout.split("\n").at(-1)) || 0;
}
