import { randomBytes } from "node:crypto";
import {
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

/** One finding's removal, as the log keeps it: deletion is final, so this is the only record of what went. */
export interface Deleted {
  id: string;
  paths: string[];
  /** Uncompressed size the finding measured. A finding that failed partway records 0, because its share is unknown. */
  bytes: number;
}

export interface Outcome {
  applied: string[];
  /** Plan items that changed or gained a blocker since planning. Nothing was done to them. */
  stale: string[];
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
  } catch {
    return; // already gone, such as a worktree's build output its parent took with it
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
 * no-op on a branch that moved after the worktree was judged.
 */
async function forgetWorktree(gitDir: string, branch?: string, head?: string): Promise<void> {
  await run(["git", "--git-dir", gitDir, "worktree", "prune"]);
  if (branch && head) await run(["git", "--git-dir", gitDir, "update-ref", "-d", `refs/heads/${branch}`, head]);
}

/**
 * Deletes a finding's paths, recording each in `deleted` as it goes. Nothing can bring them back, so the checks that
 * matter run right before: the delete hook for a worktree, then whether a running process has its cwd or an open file
 * inside any path, which the scan judged but which can have changed since.
 */
async function remove(finding: Finding, ctx: Context, deleted: string[]): Promise<void> {
  const { gitDir, branch, head } = finding;
  const hook = ctx.config.deleteHook;
  if (gitDir && hook) {
    for (const path of finding.paths) {
      const error = await runDeleteHook(expandHome(ctx.paths.home)(hook), path);
      if (error) throw new Error(error);
    }
  }
  const live = liveFiles();
  const busy = finding.paths.filter((path) => holders(path, live));
  if (busy.length) throw new Error(`a running process works in or holds a file in ${busy.join(", ")}`);
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

/** Rescans and re-matches ids first: a plan is approval for the state it saw, not for whatever is there now. */
export function applyPlan(plan: Plan, ctx: Context): Promise<Outcome> {
  return withLock(ctx.paths, async () => {
    const oldTrash = await emptyOldTrashUnlocked(ctx.paths, ctx.config);
    const outcome = await applyUnlocked(plan, ctx);
    if (oldTrash) outcome.oldTrash = oldTrash;
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
  const outcome: Outcome = { applied: [], stale: [], failed: [], bytes: 0, deleted: [], reniced: 0, stopped: 0 };
  for (const findingId of plan.findingIds) {
    const finding = current.get(findingId);
    if (!finding || finding.state !== plan.states?.[findingId] || !eligible(finding)) {
      outcome.stale.push(findingId);
      continue;
    }
    const deleted: string[] = [];
    try {
      const done = await execute(finding, ctx, deleted);
      outcome.applied.push(findingId);
      outcome.bytes += finding.bytes;
      outcome.reniced += done.reniced;
      outcome.stopped += done.stopped;
      if (deleted.length) outcome.deleted.push({ id: findingId, paths: deleted, bytes: finding.bytes });
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
  /** Measured before deletion, so the log keeps the last size the old trash had. */
  bytes: number;
  transactions: number;
  /** Transactions kept because the delete hook failed or their files could not be removed, by id, with why. */
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
  const bytes = (await sizes([paths.oldTrash])).get(paths.oldTrash) ?? 0;
  const errors: Record<string, string> = {};
  for (const id of ids) {
    const dir = join(paths.oldTrash, id);
    let tx: OldTransaction | undefined;
    try {
      tx = JSON.parse(readFileSync(join(dir, "transaction.json"), "utf8")) as OldTransaction;
    } catch {}
    try {
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
    for (const entry of tx?.entries ?? [])
      if (entry.gitDir) await forgetWorktree(entry.gitDir, entry.branch, entry.head);
  }
  if (!Object.keys(errors).length) rmSync(paths.oldTrash, { recursive: true, force: true });
  return { bytes, transactions: ids.length, errors };
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
