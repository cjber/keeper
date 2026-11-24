import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  targetIds,
} from "./scanners";
import { defaultPaths, expandHome, holders, liveFiles, niceness, type Paths, run, sizes } from "./system";
import { bulkEligible, eligible, type Finding, outermost, type Plan, type Risk, risks, schemaVersion } from "./types";

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
    ...Object.keys(parsed).filter((key) => !(key in defaultConfig) && key !== "purgeHook"),
    ...Object.keys(parsed.theme ?? {})
      .filter((key) => !(key in defaultTheme))
      .map((key) => `theme.${key}`),
  ];
  if (unknown.length) throw new Error(`unknown keys in ${paths.config}: ${unknown.join(", ")}`);
  // An older config's purgeHook is the same hook under its old name, so an upgrade does not break the config.
  const { purgeHook, ...rest } = parsed as Partial<Config> & { purgeHook?: string };
  return {
    ...defaultConfig,
    ...rest,
    deleteHook: rest.deleteHook ?? purgeHook ?? defaultConfig.deleteHook,
    theme: { ...defaultTheme, ...rest.theme },
  };
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

/** Paths reduced to the outermost ones, per path rather than per finding, so no subtree is walked twice. */
function outermostPaths(paths: readonly string[]): string[] {
  return paths.filter(
    (path, index) =>
      !paths.some(
        (other, otherIndex) =>
          otherIndex !== index && ((other === path && otherIndex < index) || path.startsWith(`${other}/`)),
      ),
  );
}

/** Whether a path is on disk, a dangling symlink included, since `removeTree` deletes the link itself. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Allocated bytes deleting `paths` would free, from one idle-priority `find -xdev` walk over the outermost
 * roots: a regular inode counts only once every link to it is inside the roots, so a file hardlinked from a
 * path that stays behind counts for nothing. Directories and other inodes count their own blocks once, however
 * many roots reach them. The walk stays on each root's filesystem, as `removeTree` refuses a tree holding a
 * mount, and a directory inode already visited is pruned with its whole subtree, so a bind mount that loops
 * back cannot make the walk unbounded. A path that has vanished counts for nothing. A walk that fails or
 * cannot read part of the tree (an unreadable directory, a missing `find`) has no answer: it returns
 * undefined rather than the share it read.
 */
async function freedBytes(paths: readonly string[]): Promise<number | undefined> {
  const roots = outermostPaths(paths);
  if (!roots.length) return 0;
  const found = await run([
    "nice",
    "-n",
    "19",
    "ionice",
    "-c",
    "3",
    "find",
    ...roots,
    "-xdev",
    "-printf",
    "%D %i %n %b %y %p\\0",
  ]);
  if (found.code !== 0) return undefined;
  const inodes = new Map<string, { blocks: number; nlink: number; regular: boolean; seen: number }>();
  const visitedDirs = new Set<string>();
  let skipped: string | undefined;
  for (const record of found.stdout.split("\0")) {
    const match = /^(\d+) (\d+) (\d+) (\d+) (.) ([\s\S]*)$/.exec(record);
    if (!match) continue;
    const [, dev, ino, nlink, blocks, type, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (skipped !== undefined && (path === skipped || path.startsWith(`${skipped}/`))) continue;
    skipped = undefined;
    const key = `${dev}:${ino}`;
    if (type === "d") {
      if (visitedDirs.has(key)) {
        skipped = path;
        continue;
      }
      visitedDirs.add(key);
    }
    const entry = inodes.get(key) ?? {
      blocks: (Number(blocks) || 0) * 512,
      nlink: Number(nlink) || 0,
      regular: type === "f",
      seen: 0,
    };
    entry.seen++;
    inodes.set(key, entry);
  }
  let total = 0;
  for (const inode of inodes.values()) if (!inode.regular || inode.seen >= inode.nlink) total += inode.blocks;
  return total;
}

export async function createPlan(
  paths: Paths,
  chosen: readonly Finding[],
  staleDays: number,
  appStaleDays = defaultAppStaleDays,
  now = Date.now(),
): Promise<Plan> {
  const findings = outermost(chosen);
  // A delete finding whose paths are on disk is costed by what deleting the planned set would free, not by its
  // batch-attributed size. A finding with nothing on disk keeps its measured size, as a package removal does.
  const onDisk = findings.filter((finding) => finding.action === "delete" && finding.paths.some(present));
  const onDiskIds = new Set(onDisk.map((finding) => finding.id));
  // A walk with no answer falls back to the scanned sizes of the findings it was costing.
  const walked = onDisk.length
    ? ((await freedBytes(onDisk.flatMap((finding) => finding.paths))) ??
      onDisk.reduce((sum, finding) => sum + finding.bytes, 0))
    : 0;
  const plannedBytes =
    findings.reduce((sum, finding) => sum + (onDiskIds.has(finding.id) ? 0 : finding.bytes), 0) + walked;
  const plan: Plan = {
    schemaVersion,
    id: newId(),
    createdAt: new Date(now).toISOString(),
    findingIds: findings.map((finding) => finding.id),
    states: Object.fromEntries(findings.map((finding) => [finding.id, finding.state])),
    categories: [...new Set(findings.map((finding) => finding.category))],
    bytes: plannedBytes,
    staleDays,
    appStaleDays,
  };
  writeJson(join(paths.state, "plans", `${plan.id}.json`), plan);
  return plan;
}

/** A target `plan` left out, and why. `idle` marks one only the `--stale-days` window holds back. */
export interface Skipped {
  id: string;
  reason: string;
  idle?: true;
}

/**
 * The findings named by id or path. A target that vanished or gained a blocker since the scan is skipped with its
 * reason, so one of them never costs the rest of the plan.
 */
export function pickById(
  findings: readonly Finding[],
  targets: readonly string[],
): { chosen: Finding[]; skipped: Skipped[] } {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const chosen: Finding[] = [];
  const skipped: Skipped[] = [];
  for (const target of targets) {
    const finding = targetIds(target)
      .map((id) => byId.get(id))
      .find(Boolean);
    if (!finding) skipped.push({ id: target, reason: "no finding with this id or path now" });
    else if (finding.idle && finding.blockers.length === 1 && finding.blockers[0] === finding.idle)
      skipped.push({
        id: target,
        reason: `not eligible: ${finding.idle}. If it is yours and finished, --stale-days 0 plans it now`,
        idle: true,
      });
    else if (!eligible(finding))
      skipped.push({ id: target, reason: `not eligible: ${finding.blockers.join("; ") || finding.action}` });
    else if (!chosen.includes(finding)) chosen.push(finding);
  }
  return { chosen, skipped };
}

export function readPlan(paths: Paths, id: string): Plan {
  const plan = JSON.parse(readFileSync(join(paths.state, "plans", `${id}.json`), "utf8")) as Plan;
  // A plan from an older keeper approved moving to a trash, not deleting for good.
  if (plan.schemaVersion !== schemaVersion)
    throw new Error(`plan ${id} was made by another keeper version, make a new one`);
  return plan;
}

/** One finding's removal, as the log keeps it: deletion is final, so this is the only record of what went. */
export interface Deleted {
  id: string;
  paths: string[];
  /**
   * Allocated bytes deleting this finding's paths would free on their own, measured before the apply lock was
   * taken: an inode counts only when every link to it lies inside this finding's paths, so a file shared
   * between two deleted findings is counted by neither, a conservative undercount. A finding that failed
   * partway records 0, because its share is unknown.
   */
  bytes: number;
}

export interface Outcome {
  applied: string[];
  /** Plan items that changed or gained a blocker since planning. Nothing was done to them. */
  stale: string[];
  /** Why each stale item was left, by id: gone, blocked and by what, or changed since the plan. */
  staleReasons: Record<string, string>;
  failed: { id: string; error: string }[];
  bytes: number;
  /** Paths deleted, by finding, including what a finding that failed partway had already removed. */
  deleted: Deleted[];
  /** Processes whose priority was lowered, which frees no space but is the point of a quiet machine again. */
  reniced: number;
  /** Orphaned processes that were ended. */
  stopped: number;
  /** The trash an older keeper kept, deleted by this run. */
  oldTrash?: OldTrash;
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

/** Sanitised, because a hook's stderr ends up in JSON output and the log. */
async function runDeleteHook(hook: string, path: string): Promise<string | undefined> {
  const result = await run([hook, path]);
  if (result.code === 0) return undefined;
  const stderr = Array.from(result.stderr, (character) => (character < " " || character === "\x7f" ? " " : character))
    .join("")
    .trim()
    .slice(0, 500);
  return `delete hook ${hook} exited ${result.code}${stderr ? `: ${stderr}` : ""}`;
}

/**
 * Deletes one path for good. A recursive remove does not stop at a mount point, so a directory with a filesystem
 * mounted at or below it is refused, from a mount table read immediately before each removal. A failed lookup refuses
 * too. `rm` cannot unlink entries inside a directory it may not write to, so on a refusal every directory the user owns
 * below the path gets its permissions back and the removal runs once more. The walk happens only then, because most
 * removals need no repair.
 */
async function removeTree(paths: Paths, path: string): Promise<void> {
  let directory: boolean;
  try {
    directory = lstatSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // gone, such as build output its worktree took with it
    throw error;
  }
  if (!directory) {
    rmSync(path, { force: true });
    return;
  }
  const checkMounts = () => {
    const mounts = mountsWithin(readFileSync(paths.mountinfo, "utf8"), realpathSync(path));
    if (mounts.length)
      throw new Error(`a filesystem is mounted at or inside ${path}, unmount it first: ${mounts.join(", ")}`);
  };
  checkMounts();
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
  }
  // `-exec ... ;` runs on a directory before find descends into it, so a tree find could not read opens up as it goes.
  const locked = ["-type", "d", "-user", String(process.getuid?.()), "!", "-perm", "-u=rwx"];
  await run(["find", path, "-xdev", ...locked, "-exec", "chmod", "u+rwx", "{}", ";"]);
  checkMounts();
  rmSync(path, { recursive: true, force: true });
}

/**
 * Drops a deleted worktree's git metadata, then its local branch. Passing the old head makes the branch deletion a
 * no-op on a branch that moved after the worktree was judged. A clone keeps its git dir inside itself, so deleting it
 * took the metadata and the branch along and nothing is left to drop.
 */
async function forgetWorktree(gitDir: string, branch?: string, head?: string): Promise<void> {
  if (!existsSync(gitDir)) return;
  const pruned = await run(["git", "--git-dir", gitDir, "worktree", "prune"]);
  if (pruned.code !== 0) throw new Error(`deleted, but git worktree prune failed: ${pruned.stderr.trim()}`);
  if (branch && head) await run(["git", "--git-dir", gitDir, "update-ref", "-d", `refs/heads/${branch}`, head]);
}

function assertIdle(paths: readonly string[]): void {
  const live = liveFiles();
  const busy = paths.filter((path) => holders(path, live));
  if (busy.length) throw new Error(`a running process works in or holds a file in ${busy.join(", ")}`);
}

/**
 * Deletes a finding's paths, recording each in `deleted` as it goes. Nothing can bring them back, so the checks that
 * matter run right before: the delete hook for a worktree, then whether a running process has its cwd or an open file
 * inside any path, which the scan judged but which can have changed since.
 */
async function remove(finding: Finding, ctx: Context, deleted: string[]): Promise<void> {
  const { gitDir, branch, head } = finding;
  const hook = ctx.config.deleteHook;
  // Checked before the hook, which may drop external state, and again after it, which can take a while.
  assertIdle(finding.paths);
  if (gitDir && hook) {
    for (const path of finding.paths) {
      const error = await runDeleteHook(expandHome(ctx.paths.home)(hook), path);
      if (error) throw new Error(error);
    }
    assertIdle(finding.paths);
  }
  for (const path of finding.paths) {
    await removeTree(ctx.paths, path);
    deleted.push(path);
    if (finding.category === "transcripts") removeEmptyParents(path, ctx.paths.home);
  }
  if (gitDir) await forgetWorktree(gitDir, branch, head);
}

/** What a finding did besides deleting: processes reniced and processes stopped. */
async function execute(
  finding: Finding,
  ctx: Context,
  deleted: string[],
): Promise<{ reniced: number; stopped: number }> {
  if (finding.action === "stop") {
    let stopped = 0;
    for (const pid of finding.pids ?? []) if (await stop(pid)) stopped++;
    if (stopped === 0) throw new Error("the process had already exited");
    return { reniced: 0, stopped };
  }
  if (finding.action === "renice") {
    let reniced = 0;
    for (const pid of [...(finding.pids ?? []), ...(finding.parent ? [finding.parent] : [])]) {
      const nice = niceness(pid);
      if (nice === undefined || nice >= lowestPriority) continue; // gone, or already at the bottom
      if ((await run(["renice", "-n", String(lowestPriority), "-p", String(pid)])).code !== 0) continue;
      reniced++;
    }
    // A process's own nice only competes inside its session's autogroup, so the group is lowered too.
    for (const pid of finding.autogroups ?? []) {
      const nice = autogroupNice(pid);
      if (nice === undefined || nice >= lowestPriority || !(await setAutogroupNice(pid, lowestPriority))) continue;
      reniced++;
    }
    if (reniced === 0) throw new Error("no process in this group could be reniced");
    return { reniced, stopped: 0 };
  }
  if (finding.action === "delete") {
    await remove(finding, ctx, deleted);
    return { reniced: 0, stopped: 0 };
  }
  if (finding.action === "truncate") {
    for (const path of finding.paths) {
      // Written in place: a rename would leave the running writer appending to a deleted file.
      const start = Math.max(0, statSync(path).size - logKeepBytes);
      const tail = await Bun.file(path).slice(start).arrayBuffer();
      writeFileSync(path, Buffer.from(tail));
    }
    return { reniced: 0, stopped: 0 };
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
  return { reniced: 0, stopped: 0 };
}

/**
 * What each planned delete finding would free on its own, from a rescan and one `freedBytes` walk per finding,
 * all before the lock is taken: the walks are full tree walks, so they must not hold the lock other keeper runs
 * wait on, and no walk may sit between the under-lock eligibility check and its deletion. A finding the
 * measurement rescan did not return gets no entry, and records 0 if it still deletes.
 */
async function measuredFreed(plan: Plan, ctx: Context): Promise<Map<string, number>> {
  const scanned = await scan(
    {
      ...ctx,
      staleDays: plan.staleDays,
      appStaleDays: plan.appStaleDays ?? ctx.appStaleDays,
      sizeOnly: new Set(plan.findingIds),
    },
    plan.categories,
  );
  const wanted = new Set(plan.findingIds);
  const measured = new Map<string, number>();
  for (const finding of scanned.findings)
    if (wanted.has(finding.id) && finding.action === "delete")
      measured.set(finding.id, (await freedBytes(finding.paths)) ?? finding.bytes);
  return measured;
}

/** Rescans and re-matches ids first: a plan is approval for the state it saw, not for whatever is there now. */
export async function applyPlan(plan: Plan, ctx: Context): Promise<Outcome> {
  const measured = await measuredFreed(plan, ctx);
  return withLock(ctx.paths, async () => {
    const outcome = await applyUnlocked(plan, ctx, measured);
    // After the rescan, so a stale plan does not empty the trash it never applied anything beside.
    const oldTrash = await emptyOldTrashUnlocked(ctx.paths, ctx.config);
    if (oldTrash) outcome.oldTrash = oldTrash;
    forget(ctx.paths, plan.categories);
    audit(ctx.paths, "apply", { plan: plan.id, ...outcome });
    return outcome;
  });
}

async function applyUnlocked(plan: Plan, ctx: Context, measured: ReadonlyMap<string, number>): Promise<Outcome> {
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
  const outcome: Outcome = {
    applied: [],
    stale: [],
    staleReasons: {},
    failed: [],
    bytes: 0,
    deleted: [],
    reniced: 0,
    stopped: 0,
  };
  for (const findingId of plan.findingIds) {
    const finding = current.get(findingId);
    if (!finding || !eligible(finding) || finding.state !== plan.states?.[findingId]) {
      outcome.stale.push(findingId);
      // A blocker comes first: a failed lookup during the rescan also moves the state, and the blocker names why.
      outcome.staleReasons[findingId] = !finding
        ? "gone since the plan"
        : !eligible(finding)
          ? `blocked now: ${finding.blockers.join("; ") || finding.action}`
          : "changed since the plan";
      continue;
    }
    // The rescan ran before this deletion, so a delete whose paths have all gone since then is stale, not a success.
    if (finding.action === "delete" && finding.paths.length && !finding.paths.some(present)) {
      outcome.stale.push(findingId);
      outcome.staleReasons[findingId] = "gone since the plan";
      continue;
    }
    const deleted: string[] = [];
    try {
      // Measured standalone before the lock, per finding: see `measuredFreed`. Non-delete actions keep their size.
      const freed = finding.action === "delete" ? (measured.get(findingId) ?? 0) : finding.bytes;
      const done = await execute(finding, ctx, deleted);
      outcome.applied.push(findingId);
      outcome.bytes += freed;
      outcome.reniced += done.reniced;
      outcome.stopped += done.stopped;
      if (deleted.length) outcome.deleted.push({ id: findingId, paths: deleted, bytes: freed });
    } catch (error) {
      outcome.failed.push({ id: findingId, error: String(error) });
      if (deleted.length) outcome.deleted.push({ id: findingId, paths: deleted, bytes: 0 });
    }
  }
  forgetUnder(
    ctx.paths,
    outcome.deleted.flatMap((entry) => entry.paths),
  );
  return outcome;
}

/** A transaction manifest from the trash an older keeper kept. */
interface OldTransaction {
  entries: { trashed: string; gitDir?: string; branch?: string; head?: string }[];
}

export interface OldTrash {
  /** Measured before deletion, for the transactions deleted, so the log keeps the last size they had. */
  bytes: number;
  /** Transactions deleted. */
  transactions: number;
  /** Transactions kept because they hold a running process's files, the delete hook failed or their files could not be removed, by id, with why. */
  errors: Record<string, string>;
}

/**
 * Older keeper versions moved removals into a trash and freed nothing until a purge. Each apply deletes what is left
 * of it, after measuring its size for the report. A worktree in it gets the delete hook, with its path in the trash,
 * and its git metadata and branch are dropped as for any deleted worktree.
 */
export function emptyOldTrash(paths: Paths): Promise<OldTrash | undefined> {
  return withLock(paths, async () => {
    const result = await emptyOldTrashUnlocked(paths, loadConfig(paths));
    if (result) audit(paths, "old-trash", result);
    return result;
  });
}

async function emptyOldTrashUnlocked(paths: Paths, config: Config): Promise<OldTrash | undefined> {
  let ids: string[];
  try {
    ids = readdirSync(paths.oldTrash);
  } catch {
    return undefined;
  }
  const dirs = ids.map((id) => join(paths.oldTrash, id));
  const measured = await sizes(dirs);
  let bytes = 0;
  const errors: Record<string, string> = {};
  for (const id of ids) {
    const dir = join(paths.oldTrash, id);
    let tx: OldTransaction | undefined;
    try {
      tx = JSON.parse(readFileSync(join(dir, "transaction.json"), "utf8")) as OldTransaction;
    } catch {}
    try {
      assertIdle([dir]);
      for (const entry of tx?.entries ?? []) {
        if (!entry.gitDir || !config.deleteHook) continue;
        const error = await runDeleteHook(expandHome(paths.home)(config.deleteHook), entry.trashed);
        if (error) throw new Error(error);
      }
      await removeTree(paths, dir);
    } catch (error) {
      errors[id] = error instanceof Error ? error.message : String(error);
      continue;
    }
    bytes += measured.get(dir) ?? 0;
    for (const entry of tx?.entries ?? [])
      if (entry.gitDir) await forgetWorktree(entry.gitDir, entry.branch, entry.head);
  }
  if (!Object.keys(errors).length) rmSync(paths.oldTrash, { recursive: true, force: true });
  return { bytes, transactions: ids.length - Object.keys(errors).length, errors };
}

/**
 * Mount points at or below `dir`. A recursive remove does not stop at a mount point, so deleting the directory would
 * delete whatever that filesystem holds. The mount point is field 5 of each mountinfo line, with space, tab, newline
 * and backslash escaped as octal.
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
    .filter((point) => point === dir || point.startsWith(prefix));
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
