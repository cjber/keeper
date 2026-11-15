import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { alive, type Hold, liveHolds, readLedger } from "./ledger";
import { ageDays, expandHome, holders, type Paths, run, sizes, timedOut } from "./system";
import { type Category, categories, count, type Finding, type Risk, type Scan, schemaVersion } from "./types";
import { coveredDays, readUsage, type UsageLedger } from "./usage";

export const defaultStaleDays = 7;
/** Apps are used less often than files, so an app is judged unused over a longer window by default. */
export const defaultAppStaleDays = 90;
/** Large files are offered at this apparent size or above, unless the config says otherwise. */
export const defaultLargeBytes = 500 * 1024 ** 2;
const staleBuildDays = 3;
const transcriptDays = 14;
/** Temp entries are disposable by definition and a test suite leaks thousands a day, so a day idle is enough. */
const tmpStaleDays = 1;
const logCapBytes = 50 * 1024 ** 2;
export const logKeepBytes = 5 * 1024 ** 2;
const buildDirs = /\/(target|node_modules|\.next|\.turbo|\.venv)$/;
/** The head of a file is enough to split most same-size files before the full hash runs. */
const partialHashBytes = 64 * 1024;

/** A machine this far past its core count is oversubscribed, so `load` findings become worth showing. */
const loadPerCore = 1.25;
/** Groups below this share of a core are noise, and renicing them would change nothing. */
const minGroupCpu = 25;
/**
 * Short bursts are normal; only work that has held the CPU this long is deprioritised. A build that keeps starting
 * fresh workers never has an old member, so a group also counts once its members have used `minGroupCoreMinutes`.
 */
const minGroupMinutes = 5;
const minGroupCoreMinutes = 2;
/** Long enough that one scheduler burst cannot swing a group by tens of points between two scans. */
export const sampleMs = 1000;
const clockTicks = 100;
/** The bottom of the range: what nice can give without root. */
export const lowestPriority = 19;
/** An orphan whose terminal is gone and that has been running this long is dead weight, not a burst. */
const orphanMinutes = 30;
/** Below this share of time spent fully stalled, memory pressure is not what a person is feeling. */
const memoryStall = 10;
/** A cgroup this close to its memory.high cap is being throttled rather than merely busy. */
const cgroupCap = 0.9;
const cgroupRoots = ["/sys/fs/cgroup/user.slice", "/sys/fs/cgroup/agent.slice"];
/** An idle detached process this old, holding memory, has outlived whatever started it. */
const abandonedHours = 6;
/** Below this share of one core over the sample a process is idle rather than doing slow work. */
const idleCpu = 0.5;
/** RAM plus swap below this is not worth a finding: stopping it would not relieve memory pressure. */
const minHeldBytes = 16 * 1024 ** 2;
/** Programs that run a script named on their command line, so a deleted script means a stale process. */
const interpreters = /^(bun|node|deno|tsx|ts-node|python[\d.]*|ruby|perl|bash|sh|zsh|dash|fish)$/;
const shells = new Set(["bash", "sh", "zsh", "dash", "fish", "nu", "elvish", "xonsh"]);
/** Interactive tools a person comes back to, and the servers that hold panes, are never stopped as abandoned. */
const keptCommands = new Set([
  "nvim",
  "vim",
  "vi",
  "emacs",
  "emacsclient",
  "hx",
  "helix",
  "nano",
  "micro",
  "kak",
  "code",
  "tmux",
  "screen",
  "zellij",
  "kiln",
  "ssh-agent",
  "gpg-agent",
  "gnome-keyring-daemon",
]);
/** Servers whose children are panes: a child that is not the leader of a live pane's session was reparented there. */
const multiplexers = /^(tmux|screen|zellij|kiln)\b/;

/** Deprioritising any of these makes the desktop itself slow, which is the opposite of what a load finding is for. */
const sessionCommands = new Set([
  "Hyprland",
  "start-hyprland",
  "Xwayland",
  "Xorg",
  "gnome-shell",
  "plasmashell",
  "kwin_wayland",
  "kwin_x11",
  "mutter",
  "sway",
  "i3",
  "xfwm4",
  "openbox",
  "kitty",
  "kitten",
  "foot",
  "alacritty",
  "ghostty",
  "wezterm",
  "konsole",
  "gnome-terminal",
  "xterm",
  "systemd",
  "dbus-daemon",
  "dbus-broker",
  "pipewire",
  "wireplumber",
  "hypridle",
  "hyprlock",
]);

export interface Config {
  /** Absolute paths or `~/` paths to directories that hold only disposable agent output. */
  agentRoots: string[];
  /** Regular expressions matched against entry names directly under ~/.cache. */
  agentCachePatterns: string[];
  /** Directories of git checkouts whose ignored build output may be cleaned. */
  repoRoots: string[];
  /** Directories that hold worktrees. Empty keeps the default, ~/.worktrees. */
  worktreeRoots: string[];
  /** AUR helper clone directories. Empty keeps the defaults for paru and yay. */
  aurClones: string[];
  /** Appended log files that nothing rotates. Past 50M each is cut to its last 5M. */
  logs: string[];
  /** `keeper auto` notifies below this much free space. */
  warnFreeGb: number;
  /** A file under $HOME this large, stale, and not in a repo or dotdir, is offered by the `large` category. */
  largeBytes: number;
  /** Run before a worktree is deleted for good, with its trashed path then its original path. */
  purgeHook: string;
  /** Have `keeper auto` return primary checkouts to their default branch and fast-forward them. */
  freshen: boolean;
  /** Wizard colours. Empty keeps the terminal's own: reverse video for the cursor, dim for blocked rows. */
  theme: Theme;
}

/**
 * Colours as `#rrggbb`, or a palette name such as `cyan` or `brightred`, which the terminal's own theme decides.
 * Empty is the terminal's foreground: reverse video for the cursor, dim text for blocked rows.
 */
export interface Theme {
  cursor: string;
  cursorText: string;
  selected: string;
  blocked: string;
  accent: string;
  size: string;
  category: string;
  low: string;
  medium: string;
  high: string;
}

export const defaultTheme: Theme = {
  cursor: "",
  cursorText: "",
  selected: "green",
  blocked: "",
  accent: "cyan",
  size: "",
  category: "blue",
  low: "green",
  medium: "yellow",
  high: "red",
};

export const defaultConfig: Config = {
  agentRoots: [],
  agentCachePatterns: [],
  repoRoots: [],
  worktreeRoots: [],
  aurClones: [],
  logs: [],
  warnFreeGb: 20,
  largeBytes: defaultLargeBytes,
  purgeHook: "",
  freshen: false,
  theme: defaultTheme,
};

/** One pull request as `gh pr list` reports it. */
export interface PullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  headRefOid: string;
  /** The commit the merge landed on the default branch, the squash commit for a squash merge. */
  mergeCommit?: { oid: string } | null;
}

export interface Context {
  paths: Paths;
  config: Config;
  live: readonly string[];
  now: number;
  /** Worktrees and agent output touched more recently than this are blocked. */
  staleDays: number;
  /** Apps not seen running for this long are unused. Falls back to `defaultAppStaleDays` when unset. */
  appStaleDays?: number;
  /** XDG download dir, or ~/Downloads. Overridable so a test never reads the real user dirs. */
  downloadDir?: string;
  /** XDG pictures dir, or ~/Pictures. Overridable so a test never reads the real user dirs. */
  picturesDir?: string;
  /**
   * Also size agent and build findings a blocker keeps from any plan. The wizard sets it so its space bars show what is
   * waiting; scan, plan and apply leave it off, because those du walks were most of a scan's time and decide nothing.
   */
  sizeBlocked?: boolean;
  /** Sampled processes, so a test never has to race a real machine. Absent means the scan reads /proc. */
  processes?: readonly ProcessInfo[];
  /** Replaces the GitHub lookup in tests. With a branch, it lists only that branch's pull requests. A throw is a failure. */
  pullRequests?: (repo: string, branch?: string) => Promise<PullRequest[]>;
  /** Milliseconds before the first retry of a failed pull request lookup. Tests shorten it. */
  retryPause?: number;
  /** Milliseconds one `gh` pull request lookup may take. Falls back to `pullRequestTimeoutMs`. Tests shorten it. */
  pullRequestTimeout?: number;
  /**
   * Finding ids a plan names. When set, only these agent, build and worktree findings are measured and checked for
   * unwritable directories, because planning or applying a few ids must not walk every other tree in their category.
   * The rest keep 0 bytes, so a scan made this way is never stored as a complete one.
   */
  sizeOnly?: ReadonlySet<string>;
  /** Hears a problem that left a category incomplete without failing it. `scan` sets it per category. */
  warn?: (message: string) => void;
  cores?: number;
  loadAverage?: number;
  /** Whether the kernel shares CPU between session autogroups. Absent means read /proc/sys/kernel/sched_autogroup_enabled. */
  autogroup?: boolean;
  /** Memory pressure and capped cgroups, so a test can describe a stalled machine without reproducing one. */
  pressure?: MemoryPressure;
  cgroups?: readonly CgroupUsage[];
  /** Docker usage and reclaimable build cache, so a test never queries the machine's daemon. Undefined means no docker. */
  docker?: () => Promise<[DockerUsage, number] | undefined>;
}

/** Percent of the last ten seconds spent stalled on memory, as `/proc/pressure/memory` reports it. */
export interface MemoryPressure {
  some: number;
  full: number;
}

/** A cgroup that has a memory.high cap and is close enough to it to be throttled. */
export interface CgroupUsage {
  path: string;
  current: number;
  high: number;
  commands: string[];
}

/** One process as `/proc` described it over the sample window. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  nice: number;
  /** Percent of one core used across the sample. */
  cpu: number;
  /** Seconds since the process started. */
  age: number;
  /** CPU seconds used over the process's whole life. */
  cpuSeconds: number;
  command: string;
  /** Scheduler state from /proc: D means uninterruptible IO sleep and contributes to load without CPU use. */
  state?: string;
  /** Where fd 0 points. `/dev/pts/N (deleted)` means the terminal it was started in has closed. */
  stdin?: string;
  /** The scheduler autogroup, one per session, such as `/autogroup-78`. Absent when autogroup is off. */
  autogroup?: string;
  /** Session id. A pane's process leads its own session, so a session whose leader is gone has lost its pane. */
  session?: number;
  /** VmRSS plus VmSwap in bytes. Read only for processes that could be abandoned. */
  memory?: number;
  cwd?: string;
  /** The process's cgroup path. A `.service` is a systemd unit someone set up to run. */
  cgroup?: string;
  /** Newest mtime, in ms, of any regular file the process holds open for writing. 0 when it holds none. */
  written?: number;
}

const digest = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);

/**
 * The id names the thing, so an id from one scan still finds it in the next. The state names what was judged, so a
 * plan approved for one state is never applied to another.
 */
export function findingId(category: Category, target: string, state: string): { id: string; state: string } {
  return { id: digest(category, target), state: digest(category, target, state) };
}

/** Whether a scan measures this finding: every one, unless a plan named the few it is about. */
function measured(context: Context, id: string): boolean {
  return !context.sizeOnly || context.sizeOnly.has(id);
}

function entries(path: string): string[] {
  try {
    return readdirSync(path).map((name) => join(path, name));
  } catch {
    return [];
  }
}

/** Agents delete their own worktrees and scratch at any time, so a path that vanishes mid-scan is dropped, not fatal. */
async function unlessGone<T>(path: string, inspect: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await inspect();
  } catch (error) {
    if (existsSync(path)) throw error;
    return undefined;
  }
}

/**
 * Says how long ago, and how long until it is offered. A file written after the scan's clock was read has a slightly
 * negative age, which still means today.
 */
function touchedAgo(days: number, window: number): string {
  const whole = Math.max(0, Math.floor(days));
  const when = whole === 0 ? "touched today" : `touched ${count(whole, "day")} ago`;
  return `${when}, offered after ${count(window, "idle day")}`;
}

const inUse = "in use by a running process, offered once it exits";
const treeUnwritable = "holds a directory keeper cannot write, so it cannot move whole";

const found = <T>(items: (T | undefined)[]): T[] => items.filter((item): item is T => item !== undefined);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Worktrees sit at ~/.worktrees/<name> and ~/.worktrees/<repo>/<name>; the parents are not checkouts. */
export function worktreeDirs(root: string): string[] {
  return entries(root)
    .filter(isDirectory)
    .flatMap((dir) =>
      existsSync(join(dir, ".git")) ? [dir] : entries(dir).filter((d) => existsSync(join(d, ".git"))),
    );
}

/** The main checkout of every repo keeper can see, whether listed directly or known through one of its worktrees. */
export async function primaryCheckouts(context: Context): Promise<string[]> {
  const expand = expandHome(context.paths.home);
  const listed = context.config.repoRoots.flatMap((root) => worktreeDirs(expand(root)));
  const owners = await Promise.all(
    context.paths.worktrees.flatMap(worktreeDirs).map(async (path) => {
      const common = await run([
        "git",
        "--no-optional-locks",
        "-C",
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      return common.stdout.endsWith("/.git") ? [common.stdout.slice(0, -"/.git".length)] : [];
    }),
  );
  return [...new Set([...listed, ...owners.flat()])];
}

/**
 * Every linked checkout git names for a repo, its main checkout left out. Agents put worktrees inside the repo, such as
 * <repo>/.claude/worktrees, where walking the worktree roots never reaches them, so git is the only complete list.
 */
async function gitWorktrees(repo: string): Promise<{ paths: string[]; error?: string }> {
  const listed = await run(["git", "--no-optional-locks", "-C", repo, "worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0)
    return { paths: [], error: listed.stderr.split("\n")[0] || `git worktree list exited ${listed.code}` };
  return {
    paths: listed.stdout
      .split("\0")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .slice(1),
  };
}

/** The worktrees keeper can see: the worktree roots, plus every checkout the git of a known repo names. */
async function knownWorktrees(context: Context): Promise<string[]> {
  const roots = context.paths.worktrees.flatMap(worktreeDirs);
  const repos = await primaryCheckouts(context);
  const listed = await Promise.all(repos.map(gitWorktrees));
  const failed = repos.flatMap((repo, at) => {
    const error = listed[at]?.error;
    return error ? [`${repo} (${error})`] : [];
  });
  if (failed.length) context.warn?.(`worktrees could not be listed for ${failed.join(", ")}`);
  return [...new Set([...roots, ...listed.flatMap((entry) => entry.paths)])];
}

/** The newest pull requests in one call. A busy repository has more, so a branch missing here is looked up by name. */
const pullRequestLimit = 1000;

/** gh saying this repo is not on GitHub, which no retry changes. */
const noGitHub = [/no git remotes found/, /none of the git remotes/, /not a git repository/];

/** Exit codes for gh missing (127) and gh not logged in (4), which no retry changes either. */
const noGh = [127, 4];

/**
 * How long one `gh pr list` may take. A full page of 1000 pull requests is ten API requests, which finish in seconds,
 * so a minute only ever ends a gh that is not going to answer, such as one blocked on a keyring that never replies.
 */
const pullRequestTimeoutMs = 60_000;

/** A lookup that used up its whole wait. Not retried: it already waited longer than every retry pause together. */
class LookupTimeout extends Error {}

/**
 * A repo gh cannot serve has no pull requests, which leaves its worktrees behind the age window and approval. Any other
 * failure throws: a timeout or rate limit on a busy machine says nothing about whether a branch was merged.
 */
async function listPullRequests(repo: string, branch?: string, timeout = pullRequestTimeoutMs): Promise<PullRequest[]> {
  const fields = "number,state,headRefName,headRefOid,mergeCommit";
  const filter = branch ? ["--head", branch] : [];
  const command = ["gh", "pr", "list", "--state", "all", "--limit", String(pullRequestLimit), ...filter];
  const result = await run([...command, "--json", fields], repo, timeout);
  if (result.code === timedOut) throw new LookupTimeout(result.stderr);
  if (noGh.includes(result.code) || noGitHub.some((pattern) => pattern.test(result.stderr))) return [];
  if (result.code !== 0) throw new Error(result.stderr.split("\n")[0] || `gh exited ${result.code}`);
  return JSON.parse(result.stdout) as PullRequest[];
}

/** Tries a lookup that failed again after a pause, longer each time, before giving up on it. */
async function retried<T>(attempt: () => Promise<T>, pause: number, attempts = 3): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= attempts || error instanceof LookupTimeout) throw error;
      await Bun.sleep(pause * tries);
    }
  }
}

/** An operation in progress is unfinished work, however clean and pushed the tree looks. */
const unfinishedOperations = ["rebase-merge", "rebase-apply", "BISECT_LOG", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

/**
 * A merged pull request proves this checkout when it holds every local commit: the head is the PR's head, or an ancestor
 * of it when the PR gained commits pushed from elsewhere. The commit test matters because branch names get reused, and
 * a branch can gain commits after its PR merged. The ancestor test needs commits that no remote holds: without them the
 * checkout has no work of its own, like a branch just cut from main under a reused name, so only the age window may
 * judge it. A PR a bot rebased before merging holds none of the local commits, so it proves the checkout by content
 * instead: every file the local commits changed is exactly as the merge commit landed it.
 */
async function findMerged(
  pullRequests: readonly PullRequest[],
  branch: string,
  head: string,
  git: (...args: string[]) => Promise<{ code: number; stdout: string }>,
  ownCommits: boolean,
): Promise<PullRequest | undefined> {
  const candidates = pullRequests.filter((pr) => pr.state === "MERGED" && pr.headRefName === branch);
  const exact = candidates.find((pr) => pr.headRefOid === head);
  if (exact || !ownCommits) return exact;
  for (const pr of candidates) {
    if ((await git("merge-base", "--is-ancestor", "HEAD", pr.headRefOid)).code === 0) return pr;
  }
  for (const pr of candidates) {
    if (pr.mergeCommit?.oid && (await landedContent(pr.mergeCommit.oid, git))) return pr;
  }
  return undefined;
}

/** Every file changed since HEAD forked from the merge commit's history is identical in the merge commit. */
async function landedContent(
  merge: string,
  git: (...args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<boolean> {
  // A merge commit this clone never fetched fails here, which leaves the checkout unproven.
  const base = await git("merge-base", "HEAD", merge);
  if (base.code !== 0 || !base.stdout) return false;
  const changed = await git("diff", "--no-renames", "--name-only", "-z", base.stdout, "HEAD");
  const files = changed.stdout.split("\0").filter(Boolean);
  if (changed.code !== 0 || !files.length) return false;
  return (
    (await git("diff", "--quiet", "--no-renames", merge, "HEAD", "--", ...files.map((f) => `:(literal)${f}`))).code ===
    0
  );
}

/** Undefined when the repo's pull requests could not be listed, which is not the same as having none. */
type PullRequestLookup = (commonDir: string, path: string, branch: string) => Promise<PullRequest[] | undefined>;

async function inspectWorktree(path: string, context: Context, lookup: PullRequestLookup): Promise<Finding> {
  const git = (...args: string[]) => run(["git", "--no-optional-locks", "-C", path, ...args]);
  const blockers: string[] = [];
  const [names, status, ahead, defaultBranch] = await Promise.all([
    git(
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--absolute-git-dir",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ),
    git("status", "--porcelain"),
    git("rev-list", "--count", "HEAD", "--not", "--remotes"),
    git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
  ]);
  // One rev-parse prints a line per query. Any failure, an unborn HEAD included, leaves the work unprovable.
  const valid = names.code === 0;
  const [commonDir = "", gitDir = "", head = "", branch = ""] = valid ? names.stdout.split("\n") : [];
  if (!valid) blockers.push("not a valid checkout, so its work cannot be checked. Look at it yourself");
  if (status.stdout) {
    const files = status.stdout.split("\n").length;
    blockers.push(
      `${count(files, "uncommitted or untracked file")}, commit, stash or delete ${files === 1 ? "it" : "them"}`,
    );
  }
  if (holders(path, context.live)) blockers.push(inUse);
  const operation = unfinishedOperations.find((name) => gitDir && existsSync(join(gitDir, name)));
  if (operation) blockers.push(`${operation} is in progress, finish or abort it`);
  const listed = valid && commonDir ? await lookup(commonDir, path, branch) : [];
  // An open pull request cannot be ruled out either, so the worktree waits for a scan that can list them.
  if (!listed)
    blockers.push("its pull requests could not be listed, so neither a merge nor an open PR is known. Scan again");
  const pullRequests = listed ?? [];
  const open = pullRequests.find((pr) => pr.state === "OPEN" && pr.headRefName === branch);
  if (open) blockers.push(`PR #${open.number} is open, merge or close it`);
  const ownCommits = ahead.code === 0 && Number(ahead.stdout) > 0;
  const merged = await findMerged(pullRequests, branch, head, git, ownCommits);
  const mainlineRef = defaultBranch.stdout;
  // A merged branch is usually deleted from the remote, and the pull request is what still holds this commit.
  if (!merged && (ahead.code !== 0 || ahead.stdout !== "0")) {
    blockers.push(
      ahead.stdout
        ? `${count(Number(ahead.stdout), "commit")} on no remote, push ${ahead.stdout === "1" ? "it" : "them"} to keep the work`
        : "unknown commits on no remote, push the branch to keep the work",
    );
  }
  const mainline = mainlineRef.replace(/^origin\//, "");
  const contained =
    Boolean(mainlineRef) &&
    branch !== mainline &&
    (await git("merge-base", "--is-ancestor", "HEAD", mainlineRef)).code === 0;
  const proof = merged ? `Merged in PR #${merged.number}` : contained ? "Every commit is on the default branch" : "";
  // Commits and checkouts move logs/HEAD. The index will not do: any `git status` rewrites it.
  const touched = Math.min(
    ageDays(path, context.now),
    gitDir ? headAge(gitDir, context.now) : Number.POSITIVE_INFINITY,
  );
  // Only a merge outruns the age window. A branch just cut from main is also contained in it, and is about to be used.
  if (!merged && touched < context.staleDays) blockers.push(touchedAgo(touched, context.staleDays));
  return {
    ...findingId("worktree", path, `${head}\0${status.stdout}\0${proof}\0${open?.number ?? ""}`),
    category: "worktree",
    risk: proof ? "low" : "medium",
    action: "trash",
    title: `${worktreeName(path, context)} (${branch || "unknown branch"})`,
    paths: [path],
    packages: [],
    bytes: 0,
    // The reason states the proof alone; uncommitted files and the like are blockers, so the two never contradict.
    reason: proof || "No merged pull request or default branch holds its commits",
    blockers,
    gitDir: commonDir || undefined,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    head: head || undefined,
  };
}

function relativeToRoot(path: string, roots: readonly string[]): string {
  const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
  return root ? path.slice(root.length + 1) : path;
}

/** A worktree's name inside its worktree root, or its home-relative path when it sits beside its own repo instead. */
function worktreeName(path: string, context: Context): string {
  const relative = relativeToRoot(path, context.paths.worktrees);
  return relative === path ? path.replace(`${context.paths.home}/`, "~/") : relative;
}

function headAge(gitDir: string, now: number): number {
  try {
    return ageDays(join(gitDir, "logs/HEAD"), now);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function scanWorktrees(context: Context): Promise<Finding[]> {
  const dirs = await knownWorktrees(context);
  const leftovers = context.paths.worktrees.flatMap(leftoverDirs);
  const fetch =
    context.pullRequests ??
    ((repo: string, branch?: string) => listPullRequests(repo, branch, context.pullRequestTimeout));
  const failed = new Set<string>();
  // One warning per repo, because one failed lookup leaves every worktree of that repo unproven.
  const list = (commonDir: string, path: string, branch?: string) =>
    retried(() => fetch(path, branch), context.retryPause ?? 2000).catch((error: unknown) => {
      if (!failed.has(commonDir)) {
        failed.add(commonDir);
        const repo = commonDir.replace(/\/\.git$/, "");
        context.warn?.(`pull requests of ${repo} could not be listed, so its worktrees stay unproven: ${error}`);
      }
      return undefined;
    });
  const known = new Map<string, Promise<PullRequest[] | undefined>>();
  const lookup: PullRequestLookup = async (commonDir, path, branch) => {
    const found = known.get(commonDir) ?? list(commonDir, path);
    known.set(commonDir, found);
    const all = await found;
    // A full page means older pull requests went unlisted, so a branch it lacks gets a lookup of its own.
    if (!all || all.length < pullRequestLimit || branch === "HEAD" || all.some((pr) => pr.headRefName === branch))
      return all;
    return list(commonDir, path, branch);
  };
  // Walking a checkout is the costly part of a scan, and most worktrees are blocked, so only one that could be planned
  // is measured. A blocked finding keeps 0 bytes, which reads as an unknown size.
  const checkouts = found(
    await Promise.all(dirs.map((dir) => unlessGone(dir, () => inspectWorktree(dir, context, lookup)))),
  );
  const bytes = await sizes(
    checkouts
      .filter((finding) => !finding.blockers.length && measured(context, finding.id))
      .flatMap((finding) => finding.paths),
  );
  return [
    ...checkouts.map((finding) => ({ ...finding, bytes: bytes.get(finding.paths[0] as string) ?? 0 })),
    ...found(await Promise.all(leftovers.map((dir) => unlessGone(dir, () => inspectLeftover(dir, context))))),
  ];
}

/** A directory beside worktrees that is not a checkout, usually what a manual removal left behind. */
function leftoverDirs(root: string): string[] {
  return entries(root)
    .filter((dir) => isDirectory(dir) && !existsSync(join(dir, ".git")))
    .flatMap((dir) => entries(dir).filter((child) => isDirectory(child) && !existsSync(join(child, ".git"))));
}

async function inspectLeftover(path: string, context: Context): Promise<Finding> {
  // Branch names with a slash nest worktrees a level deeper, so this one may be a parent of live checkouts.
  const nested = await run(["find", path, "-maxdepth", "3", "-name", ".git", "-print", "-quit"]);
  const age = await newestAge(path, context.now);
  const blockers: string[] = [];
  if (nested.stdout) blockers.push("contains a checkout");
  if (holders(path, context.live)) blockers.push(inUse);
  if (age < context.staleDays) blockers.push(touchedAgo(age, context.staleDays));
  const wanted = !blockers.length && measured(context, findingId("worktree", path, "").id);
  const bytes = wanted ? ((await sizes([path])).get(path) ?? 0) : 0;
  return {
    ...findingId("worktree", path, `leftover\0${bytes}`),
    category: "worktree",
    risk: "medium",
    action: "trash",
    title: `${relativeToRoot(path, context.paths.worktrees)} (no checkout)`,
    paths: [path],
    packages: [],
    bytes,
    reason: "Directory in a worktree root that git does not track",
    blockers,
  };
}

async function building(): Promise<boolean> {
  return (await run(["pgrep", "-x", "paru|makepkg|pacman"])).code === 0;
}

async function scanAur(context: Context): Promise<Finding[]> {
  const roots = context.paths.aurClones;
  const clones = roots.flatMap(entries).filter(isDirectory);
  const installed = new Set((await run(["pacman", "-Qq"])).stdout.split("\n"));
  const busy = await building();
  const uninstalled = clones.filter((dir) => !installed.has(dir.slice(dir.lastIndexOf("/") + 1)));
  // A clone of an installed package keeps its PKGBUILD, which paru diffs on the next update.
  const artifacts = clones
    .filter((dir) => !uninstalled.includes(dir))
    .flatMap((dir) =>
      entries(dir).filter(
        (path) => /\/(src|pkg)$/.test(path) || /\.(pkg\.tar\.\w+|tar\.\w+|deb|AppImage|zip)$/.test(path),
      ),
    );
  const bytes = await sizes([...uninstalled, ...artifacts]);
  const finding = (path: string, title: string, reason: string): Finding => ({
    ...findingId("aur", path, String(bytes.get(path))),
    category: "aur",
    risk: "low",
    action: "trash",
    title,
    paths: [path],
    packages: [],
    bytes: bytes.get(path) ?? 0,
    reason,
    blockers: busy
      ? ["a package build is running, offered once it finishes"]
      : holders(path, context.live)
        ? ["in use by a running process"]
        : [],
  });
  const relative = (path: string) => relativeToRoot(path, roots);
  return [
    ...uninstalled.map((path) =>
      finding(path, `${relative(path)} clone`, "AUR clone of a package that is not installed"),
    ),
    ...artifacts.map((path) => finding(path, relative(path), "Build output or download, recreated on the next build")),
  ];
}

async function scanPacmanCache(): Promise<Finding[]> {
  const dry = await run(["paccache", "-dk1"]);
  const saved = /disk space saved: ([\d.]+) (\w+)/.exec(dry.stdout);
  if (!saved) return [];
  const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  const bytes = Math.round(Number(saved[1]) * (units[saved[2] as string] ?? 1));
  return [
    {
      ...findingId("pacman-cache", "paccache", String(bytes)),
      category: "pacman-cache",
      risk: "low",
      action: "paccache",
      title: "Old package versions in the pacman cache",
      paths: [],
      packages: [],
      bytes,
      reason: "Keeps the newest cached version of each package",
      blockers: (await building()) ? ["a package operation is running, offered once it finishes"] : [],
    },
  ];
}

async function scanOrphans(): Promise<Finding[]> {
  const packages = (await run(["pacman", "-Qdtq"])).stdout.split("\n").filter(Boolean);
  if (packages.length === 0) return [];
  const info = await run(["expac", "%m", ...packages]);
  const bytes = info.stdout.split("\n").reduce((sum, size) => sum + (Number(size) || 0), 0);
  return [
    {
      ...findingId("orphans", "orphans", packages.join(",")),
      category: "orphans",
      risk: "medium",
      action: "remove-packages",
      title: count(packages.length, "orphaned package"),
      paths: [],
      packages,
      bytes,
      reason: "Installed as dependencies that nothing requires any more",
      blockers: (await building()) ? ["a package operation is running, offered once it finishes"] : [],
    },
  ];
}

/**
 * Directories inside these roots that keeper cannot write. A move to the trash that has to cross a filesystem copies
 * the tree before removing the source, and a directory without write permission stops that removal partway, leaving
 * half a finding moved and the run partial, so a tree that holds one is not offered.
 */
async function unwritableDirs(roots: readonly string[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const found = await run(["find", ...roots, "-xdev", "-type", "d", "!", "-writable", "-printf", "%p\\0"]);
  return [...found.stdout.split("\0").filter(Boolean), ...quotedPaths(found.stderr)];
}

async function scanAgent(context: Context): Promise<Finding[]> {
  const expand = expandHome(context.paths.home);
  const patterns = context.config.agentCachePatterns.map((pattern) => new RegExp(pattern));
  const cached = entries(join(context.paths.home, ".cache")).filter((path) =>
    patterns.some((pattern) => pattern.test(path.slice(path.lastIndexOf("/") + 1))),
  );
  const claimed = readLedger(context.paths).claims.map((claim) => claim.path);
  const roots = [...new Set([...context.config.agentRoots.map(expand), ...claimed, ...cached])].filter(existsSync);
  const inspect = (path: string): Finding => {
    const age = ageDays(path, context.now);
    const blockers: string[] = [];
    if (holders(path, context.live)) blockers.push(inUse);
    if (age < context.staleDays) blockers.push(touchedAgo(age, context.staleDays));
    return {
      ...findingId("agent", path, `${statSync(path).mtimeMs}`),
      category: "agent",
      risk: "low",
      action: "trash",
      title: path.replace(`${context.paths.home}/`, "~/"),
      paths: [path],
      packages: [],
      bytes: 0,
      reason: "Allowlisted agent output",
      blockers,
    } satisfies Finding;
  };
  const judged = found(await Promise.all(roots.map((path) => unlessGone(path, () => inspect(path)))));
  // Agent output inside its idle window is never planned, so only the rest are walked unless the caller wants every
  // size. The same walk catches a directory keeper cannot write, which a move to the trash could not remove.
  const walked = judged
    .filter((finding) => (context.sizeBlocked || !finding.blockers.length) && measured(context, finding.id))
    .flatMap((finding) => finding.paths);
  const [bytes, unwritable] = await Promise.all([sizes(walked), unwritableDirs(walked)]);
  const held = (path: string) => unwritable.some((dir) => dir === path || dir.startsWith(`${path}/`));
  return judged.map((finding) => {
    const path = finding.paths[0] as string;
    return {
      ...finding,
      blockers: held(path) ? [...finding.blockers, treeUnwritable] : finding.blockers,
      bytes: bytes.get(path) ?? 0,
    };
  });
}

/** A temp entry this large gets a row of its own. Smaller ones are grouped by name, so a leaky test suite is one row. */
const tmpOwnRowBytes = 100 * 1024 ** 2;
/** A bound socket is how a server such as tmux keeps its temp dir in use without an open file there. */
const tmpSocket = "holds a socket a running program listens on, offered once it exits";

/**
 * X and session files a running display depends on: the `.X<n>-lock` that names its server's PID and the socket
 * directories. A lock is a plain file nobody keeps open, so no other blocker sees it, and these are never offered.
 */
const tmpDisplay = /^(\.X\d+-lock|\.(X11|ICE|font|XIM|Test)-unix)$/;
const tmpLockAlive = "a lock file naming a process that is still alive, offered once it exits";

/** The PID a small lock file holds, as `uv.lock` style tools and X write it, or undefined when it is not one. */
function lockPid(path: string): number | undefined {
  if (!/[-.]lock$/i.test(path)) return undefined;
  try {
    if (statSync(path).size > 32) return undefined;
    const match = /^\s*(\d+)\s*$/.exec(readFileSync(path, "latin1"));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

interface TmpEntry {
  path: string;
  bytes: number;
  inodes: number;
  /** Newest mtime anywhere inside, in seconds, so a directory still being written is never stale. */
  mtime: number;
}

/** The paths in an error such as `du: cannot read directory '/tmp/x': Permission denied`. */
function quotedPaths(stderr: string): string[] {
  return [...stderr.matchAll(/'(\/[^\n]*?)': /g)].map((match) => match[1] as string);
}

/**
 * Size, newest mtime and inode count of every entry `depth` levels below `root`, from two `du` walks rather than a stat
 * per file: a temp dir can hold a million inodes. Lines end in NUL, so no file name can split one.
 */
async function tmpUsage(root: string, depth: number): Promise<{ entries: TmpEntry[]; unreadable: string[] }> {
  const du = ["du", "-0", "-x", "-a", "-d", String(depth)];
  const [sized, counted] = await Promise.all([
    run([...du, "-b", "--time", "--time-style=+%s", root]),
    run([...du, "--inodes", root]),
  ]);
  const fields = (line: string, n: number) => {
    const parts = line.split("\t");
    return [...parts.slice(0, n - 1), parts.slice(n - 1).join("\t")];
  };
  const atDepth = (path: string) =>
    path.startsWith(`${root}/`) && path.slice(root.length + 1).split("/").length === depth;
  const inodes = new Map(
    counted.stdout.split("\0").map((line) => {
      const [count, path] = fields(line, 2);
      return [path, Number(count)];
    }),
  );
  const entries = sized.stdout.split("\0").flatMap((line) => {
    const [bytes, mtime, path = ""] = fields(line, 3);
    return atDepth(path) ? [{ path, bytes: Number(bytes), inodes: inodes.get(path) ?? 1, mtime: Number(mtime) }] : [];
  });
  return { entries, unreadable: quotedPaths(`${sized.stderr}\n${counted.stderr}`) };
}

/**
 * Paths under `root` that another user owns, without descending into them, plus any the walk could not read. An entry
 * that is one is not ours to judge, and one that holds one could not be moved whole, so neither is offered.
 */
async function tmpForeign(root: string, uid: number): Promise<string[]> {
  const found = await run([
    "find",
    root,
    "-xdev",
    "-mindepth",
    "1",
    "!",
    "-uid",
    String(uid),
    "-printf",
    "%p\\0",
    "-prune",
  ]);
  return [...found.stdout.split("\0").filter(Boolean), ...quotedPaths(found.stderr)];
}

/**
 * What running processes still point at in the temp dir beyond open files: Claude Code session ids, from the id it gives
 * every child and any `--resume` argument, and bound unix sockets, read once per network namespace. A socket file
 * outlives its listener, so only a bound one counts.
 */
function tmpReferences(): { sessions: Set<string>; sockets: Set<string> } {
  const sessions = new Set<string>();
  const sockets = new Set<string>();
  const namespaces = new Set<string>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const text = `${readFileSync(`/proc/${pid}/environ`, "latin1")}\0${readFileSync(`/proc/${pid}/cmdline`, "latin1")}`;
      for (const id of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])
        sessions.add(id);
      const namespace = readlinkSync(`/proc/${pid}/ns/net`);
      if (namespaces.has(namespace)) continue;
      namespaces.add(namespace);
      for (const line of readFileSync(`/proc/${pid}/net/unix`, "utf8").split("\n")) {
        const path = line.split(" ").at(-1) ?? "";
        if (path.startsWith("/")) sockets.add(path);
      }
    } catch {}
  }
  return { sessions, sockets };
}

/**
 * The random part of a temp name becomes `*`: `nebula-test-home-dyqgGU` is `nebula-test-home-*`, `uv-0f3e9a2b.lock` is
 * `uv-*.lock` and Python's `tmpk3j9xabq` is `tmp*`. A word counts as random when it has a digit or mixed case.
 */
function strictPattern(name: string): string {
  return name.replace(/[A-Za-z0-9_]+/g, (word) => {
    if (/^\d+$/.test(word)) return "*";
    const mixed = /[a-z]/.test(word) && /[A-Z]/.test(word) && !/^[A-Z][a-z]+$/.test(word);
    if (word.length < 6 || !(/\d/.test(word) || mixed)) return word;
    return `${/^(tmp|[a-z_]*[a-z](?=[A-Z0-9][A-Za-z0-9]{5}$))/.exec(word)?.[0] ?? ""}*`;
  });
}

/**
 * Groups temp names by pattern. A random suffix with no digit and one case, which one Python temp name in sixteen has,
 * falls back to its separator, so it joins `nebula-test-home-*` when another name makes that group. A name no other
 * shares goes in `*` with the other one-offs, so a temp dir of scattered logs is one row rather than hundreds.
 */
export function tmpPatterns(names: readonly string[]): Map<string, string[]> {
  const add = (groups: Map<string, string[]>, key: string, name: string) => {
    const members = groups.get(key);
    if (members) members.push(name);
    else groups.set(key, [name]);
  };
  const strict = new Map<string, string[]>();
  for (const name of names) add(strict, strictPattern(name), name);
  const loose = new Map<string, string[]>();
  for (const name of names) {
    const key = strictPattern(name);
    const fallback = name.replace(/(^\.?tmp|[-._])[A-Za-z0-9_]{6,10}$/, "$1*");
    add(loose, key === name && strict.has(fallback) ? fallback : key, name);
  }
  const groups = new Map<string, string[]>();
  for (const [key, members] of loose) for (const name of members) add(groups, members.length > 1 ? key : "*", name);
  return groups;
}

function tmpFinding(title: string, members: readonly TmpEntry[], blockers: string[]): Finding {
  const state = members.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.mtime}`).join("\0");
  const inodes = members.reduce((sum, entry) => sum + entry.inodes, 0);
  return {
    // A pattern splits into a ready row and a waiting row under the same title, so the id tells them apart.
    ...findingId("tmp", `${title}\0${blockers.length ? "waiting" : "ready"}`, state),
    category: "tmp",
    risk: "low",
    action: "trash",
    title: members.length > 1 ? `${title} (${count(members.length, "entry", "entries")})` : title,
    paths: members.map((entry) => entry.path),
    packages: [],
    bytes: members.reduce((sum, entry) => sum + entry.bytes, 0),
    inodes,
    reason: `${members.length > 1 ? "Temp entries you own, grouped by name" : "Temp entry you own"}, ${count(inodes, "inode")}`,
    blockers,
  };
}

/**
 * Stale entries you own in the temp dir. On a tmpfs with a quota the inode count is often what runs out, which is why a
 * finding carries it. Claude Code keeps one temp dir per session inside `claude-<uid>`, so those are judged per session.
 */
async function scanTmp(context: Context): Promise<Finding[]> {
  const root = context.paths.tmp;
  const uid = process.getuid?.() ?? -1;
  const claude = join(root, `claude-${uid}`);
  const home = context.paths.home;
  if (root === "/" || root === home || home.startsWith(`${root}/`) || existsSync(join(root, ".git")))
    throw new Error(`${root} holds home or a repository, so it is not scanned as the temp dir. Point TMPDIR at one`);
  const [top, sessions, foreign, unwritable] = await Promise.all([
    tmpUsage(root, 1),
    isDirectory(claude) ? tmpUsage(claude, 2) : { entries: [], unreadable: [] },
    tmpForeign(root, uid),
    unwritableDirs([root]),
  ]);
  const ledger = readLedger(context.paths);
  const holds = liveHolds(context.paths, context.now).map((hold) => hold.path);
  const kept = [
    ...ledger.claims.map((claim) => claim.path),
    ...holds,
    context.paths.state,
    context.paths.trash,
    ...context.paths.worktrees,
    ...context.paths.aurClones,
  ];
  const others = new Set(foreign);
  const ours = (path: string) => {
    for (let at = path; at.startsWith(`${root}/`); at = dirname(at)) if (others.has(at)) return false;
    return true;
  };
  const entries = [...top.entries.filter((entry) => entry.path !== claude), ...sessions.entries]
    .filter(
      (entry) =>
        ours(entry.path) &&
        !(dirname(entry.path) === root && tmpDisplay.test(basename(entry.path))) &&
        !kept.some((path) => overlaps(path, entry.path)),
    )
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  // Keyed by entry, so a million open files cost one pass rather than one per entry.
  const keyOf = (path: string) => {
    const parts = path.slice(root.length + 1).split("/");
    return join(root, ...parts.slice(0, parts[0] === `claude-${uid}` ? 3 : 1));
  };
  const under = (paths: Iterable<string>) =>
    new Set([...paths].filter((path) => path.startsWith(`${root}/`)).map(keyOf));
  const references = tmpReferences();
  const busy = under(context.live);
  const listening = under(references.sockets);
  const mixed = under([...foreign, ...unwritable, ...top.unreadable, ...sessions.unreadable]);
  const age = (entry: TmpEntry) => (context.now - entry.mtime * 1000) / 86_400_000;
  const window = Math.min(context.staleDays, tmpStaleDays);
  const recent = `touched less than ${count(window, "day")} ago, offered once idle that long`;
  const blockersOf = (entry: TmpEntry, grouped: boolean) => [
    ...(busy.has(entry.path) ? [inUse] : []),
    ...(listening.has(entry.path) ? [tmpSocket] : []),
    ...(alive(lockPid(entry.path)) ? [tmpLockAlive] : []),
    ...(mixed.has(entry.path)
      ? ["holds files another user owns, or a directory keeper cannot write or read, so it cannot move whole"]
      : []),
    ...(references.sessions.has(basename(entry.path)) && entry.path.startsWith(`${claude}/`)
      ? ["its Claude Code session is still running, offered once it exits"]
      : []),
    ...(age(entry) < window ? [grouped ? recent : touchedAgo(age(entry), window)] : []),
  ];
  const small = entries.filter((entry) => entry.bytes < tmpOwnRowBytes);
  const loose = small.filter((entry) => !entry.path.startsWith(`${claude}/`));
  const byName = new Map(loose.map((entry) => [basename(entry.path), entry]));
  const groups = [...tmpPatterns(loose.map((entry) => basename(entry.path)))].map(([pattern, names]) => ({
    title: join(root, pattern),
    members: names.map((name) => byName.get(name) as TmpEntry),
  }));
  const claudeSessions = small.filter((entry) => entry.path.startsWith(`${claude}/`));
  if (claudeSessions.length) groups.push({ title: join(claude, "*/*"), members: claudeSessions });
  // Each group is one row of members ready now and one blocked row that says how many wait and why.
  const grouped = groups.flatMap(({ title, members }) => {
    const ready: TmpEntry[] = [];
    const waiting: TmpEntry[] = [];
    const tally = new Map<string, number>();
    for (const entry of members) {
      const blockers = blockersOf(entry, true);
      (blockers.length ? waiting : ready).push(entry);
      for (const why of blockers) tally.set(why, (tally.get(why) ?? 0) + 1);
    }
    const row = (list: TmpEntry[], blockers: string[]) =>
      list.length ? [tmpFinding(list.length > 1 ? title : (list[0] as TmpEntry).path, list, blockers)] : [];
    return [
      ...row(ready, []),
      ...row(
        waiting,
        [...tally].map(([why, n]) => `${count(n, "entry", "entries")}: ${why}`),
      ),
    ];
  });
  return [
    ...entries
      .filter((entry) => entry.bytes >= tmpOwnRowBytes)
      .map((entry) => tmpFinding(entry.path, [entry], blockersOf(entry, false))),
    ...grouped,
  ];
}

/** Newest of a directory and its direct entries, read async so a directory of thousands never stalls the wizard. */
async function newestAge(path: string, now: number): Promise<number> {
  const top = ageDays(path, now);
  const names = await readdir(path).catch(() => []);
  const ages = await Promise.all(
    names.map((name) =>
      lstat(join(path, name)).then(
        (stat) => (now - stat.mtimeMs) / 86_400_000,
        () => Number.POSITIVE_INFINITY,
      ),
    ),
  );
  return ages.reduce((min, age) => Math.min(min, age), top);
}

/**
 * A build rewrites files deep inside its output without touching anything near the top, so the top cannot show it idle.
 * Installers keep the mtimes in their tarballs, so the top level is checked as well, where a fresh install shows.
 * The walk runs in `find` rather than here: statting a node_modules in process stalls the wizard for seconds.
 * A failed walk, a vanished path included, counts as recent, so it is never offered.
 */
async function hasRecentFile(path: string, days: number): Promise<boolean> {
  const recent = `-${Math.ceil(days * 1440)}`;
  const top = await run(["find", path, "-maxdepth", "1", "-mmin", recent, "-print", "-quit"]);
  if (top.code !== 0 || top.stdout) return true;
  const deep = await run([
    "find",
    path,
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "l",
    ")",
    "-mmin",
    recent,
    "-print",
    "-quit",
  ]);
  return deep.code !== 0 || deep.stdout !== "";
}

/** Build output is disposable even inside a worktree that must stay, which is where most of the space sits. */
async function scanBuild(context: Context): Promise<Finding[]> {
  const expand = expandHome(context.paths.home);
  const repos = [
    ...new Set([
      ...(await knownWorktrees(context)),
      ...context.config.repoRoots.flatMap((root) => worktreeDirs(expand(root))),
    ]),
  ];
  const candidates = repos.flatMap((repo) => {
    const top = entries(repo).filter((path) => buildDirs.test(path));
    const nested = entries(repo)
      .filter((path) => /\/(apps|packages|crates|services)$/.test(path))
      .flatMap(entries)
      .flatMap(entries)
      .filter((path) => buildDirs.test(path));
    return [...top, ...nested].filter(isDirectory);
  });
  // A recent build still counts, as blocked, so the space it holds shows as build output rather than as its worktree.
  const ignored = (
    await Promise.all(
      candidates.map(async (path) => {
        const parent = dirname(path);
        const name = basename(path);
        const check = await run(["git", "-C", parent, "check-ignore", "-q", name]);
        const tracked = await run(["git", "-C", parent, "ls-files", name]);
        if (check.code !== 0 || tracked.code !== 0 || tracked.stdout !== "") return undefined;
        return { path, recent: await hasRecentFile(path, staleBuildDays) };
      }),
    )
  ).filter((entry) => entry !== undefined);
  // A recent or in-use build is never planned, so only the rest are walked unless the caller wants every size.
  const judged = ignored.map(({ path, recent }) => ({
    path,
    recent,
    blockers: [
      ...(holders(path, context.live) ? [inUse] : []),
      ...(recent
        ? [`built in the last ${count(staleBuildDays, "day")}, offered after ${count(staleBuildDays, "idle day")}`]
        : []),
    ],
  }));
  const bytes = await sizes(
    judged
      .filter(
        (entry) =>
          (context.sizeBlocked || !entry.blockers.length) && measured(context, findingId("build", entry.path, "").id),
      )
      .map((entry) => entry.path),
  );
  return judged.map(({ path, recent, blockers }) => ({
    ...findingId("build", path, `${bytes.get(path) ?? 0}\0${recent}`),
    category: "build",
    risk: "low",
    action: "trash",
    title: path.replace(`${context.paths.home}/`, "~/"),
    paths: [path],
    packages: [],
    bytes: bytes.get(path) ?? 0,
    reason: "Git-ignored build output, restored by the next build or install",
    blockers,
  }));
}

async function scanTranscripts(context: Context): Promise<Finding[]> {
  const roots = [
    ".codex/sessions",
    ".codex/archived_sessions",
    ".claude/projects",
    ".claude/jobs",
    ".claude/file-history",
  ];
  const found = await Promise.all(
    roots.map((root) =>
      run([
        "find",
        join(context.paths.home, root),
        "-type",
        "f",
        "-mtime",
        `+${transcriptDays}`,
        "-printf",
        "%s\\t%p\\n",
      ]),
    ),
  );
  const files = found
    .flatMap((result) => result.stdout.split("\n"))
    .filter(Boolean)
    .map((line) => line.split("\t") as [string, string]);
  if (files.length === 0) return [];
  return [
    {
      ...findingId("transcripts", "transcripts", files.map(([, path]) => path).join("\0")),
      category: "transcripts",
      risk: "low",
      action: "trash",
      title: `${count(files.length, "agent transcript")} over ${count(transcriptDays, "day")} old`,
      paths: files.map(([, path]) => path),
      packages: [],
      bytes: files.reduce((sum, [size]) => sum + Number(size), 0),
      reason: "Bulk session logs. Config and history databases are left in place",
      blockers: [],
    },
  ];
}

/** A cache only some tools can prune. The rest are cleared whole, so they are offered only once they grow large. */
interface PackageCache {
  tool: string;
  path: string;
  action: Finding["action"];
  prunes: boolean;
}

const packageCaches: PackageCache[] = [
  { tool: "uv", path: ".cache/uv", action: "uv-prune", prunes: true },
  { tool: "pnpm", path: ".local/share/pnpm/store", action: "pnpm-prune", prunes: true },
  { tool: "npm", path: ".npm/_cacache", action: "npm-clean", prunes: false },
  { tool: "bun", path: ".bun/install/cache", action: "bun-clean", prunes: false },
];

const cleanAboveBytes = 2 * 1024 ** 3;

/** Whether the tool is running, not counting keeper itself, which runs under bun from source. */
async function running(tool: string): Promise<boolean> {
  const own = new Set([process.pid, process.ppid]);
  const found = await run(["pgrep", "-x", tool === "npm" ? "npm|npx|npm exec.*" : tool]);
  return found.stdout.split("\n").some((pid) => pid && !own.has(Number(pid)));
}

async function scanPackageCaches(context: Context): Promise<Finding[]> {
  const present = packageCaches.filter((cache) => existsSync(join(context.paths.home, cache.path)));
  const bytes = await sizes(present.map((cache) => join(context.paths.home, cache.path)));
  const findings = await Promise.all(
    present.map(async (cache): Promise<Finding | undefined> => {
      const path = join(context.paths.home, cache.path);
      const size = bytes.get(path) ?? 0;
      if (!cache.prunes && size < cleanAboveBytes) return undefined;
      const gib = Math.round(size / 1024 ** 3);
      return {
        ...findingId("package-cache", path, String(size)),
        category: "package-cache",
        risk: "low",
        action: cache.action,
        title: `${cache.tool} cache`,
        paths: [],
        packages: [],
        // A prune frees an unknown share; a clean frees the lot.
        bytes: cache.prunes ? 0 : size,
        reason: cache.prunes
          ? `Cache holds ${gib}G. Pruning removes entries nothing references, so the amount freed is unknown until it runs`
          : `Cache holds ${gib}G of downloads that ${cache.tool} fetches again on the next install`,
        // Clearing a cache under a running install can break that install, and uv refuses while it holds the lock.
        blockers: (await running(cache.tool)) ? [`${cache.tool} is running, offered once it exits`] : [],
      };
    }),
  );
  return found(findings);
}

/** Build cache unused for a week is dropped; newer layers are what the next build reuses. */
export const dockerCacheHours = 168;

function dockerBytes(size: string): number {
  const match = /^([\d.]+)\s*([kMGT]?B)/.exec(size);
  const units: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return match ? Number(match[1]) * (units[match[2] as string] ?? 1) : 0;
}

interface DockerVolume {
  Name: string;
  Links: string;
  Size: string;
  Labels: string;
}

/** What `docker system df -v --format {{json .}}` prints, as far as keeper reads it. */
export interface DockerUsage {
  Images: { Containers: string; Size: string; Repository: string }[] | null;
  Volumes: DockerVolume[] | null;
}

async function scanDocker(context: Context): Promise<Finding[]> {
  const usage = await (context.docker ?? readDocker)();
  return usage ? dockerFindings(...usage) : [];
}

async function readDocker(): Promise<[DockerUsage, number] | undefined> {
  const df = await run(["docker", "system", "df", "-v", "--format", "{{json .}}"]);
  // No docker, a daemon this user cannot reach, or a shim that prints nothing means there is nothing to judge.
  if (df.code !== 0 || !df.stdout) return undefined;
  const summary = await run(["docker", "system", "df", "--format", "{{json .}}"]);
  const build = summary.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { Type: string; Reclaimable: string })
    .find((row) => row.Type === "Build Cache");
  return [JSON.parse(df.stdout), dockerBytes(build?.Reclaimable ?? "0B")];
}

export function dockerFindings(usage: DockerUsage, reclaimableBuildCache: number): Finding[] {
  const findings: Finding[] = [];
  const dangling = (usage.Images ?? []).filter((image) => image.Repository === "<none>" && image.Containers === "0");
  if (dangling.length) {
    const bytes = dangling.reduce((sum, image) => sum + dockerBytes(image.Size), 0);
    findings.push({
      ...findingId("docker", "dangling-images", `${dangling.length}:${bytes}`),
      category: "docker",
      risk: "low",
      action: "docker-image-prune",
      title: `${dangling.length} dangling docker images`,
      paths: [],
      packages: [],
      bytes,
      reason: "Untagged image layers no container uses. A rebuild recreates any that are needed",
      blockers: [],
    });
  }
  if (reclaimableBuildCache > 0) {
    findings.push({
      ...findingId("docker", "build-cache", String(reclaimableBuildCache)),
      category: "docker",
      risk: "low",
      action: "docker-builder-prune",
      title: "docker build cache",
      paths: [],
      packages: [],
      // Docker applies the age filter itself, so how much of the reclaimable total goes is known only after it runs.
      bytes: 0,
      reason: `${Math.round(reclaimableBuildCache / 1e9)}G reclaimable. Pruning drops entries unused for ${count(dockerCacheHours / 24, "day")}; builds still reuse anything newer`,
      blockers: [],
    });
  }
  const unused = (usage.Volumes ?? []).filter((volume) => volume.Links === "0");
  if (unused.length) {
    const project = (volume: DockerVolume) => /com\.docker\.compose\.project=([^,]+)/.exec(volume.Labels)?.[1];
    const projects = [...new Set(unused.map((volume) => project(volume) ?? volume.Name))];
    findings.push({
      ...findingId("docker", "volumes", unused.map((volume) => volume.Name).join(",")),
      category: "docker",
      risk: "high",
      action: "report",
      title: `${unused.length} unused docker volumes`,
      paths: [],
      packages: [],
      bytes: unused.reduce((sum, volume) => sum + dockerBytes(volume.Size), 0),
      // Volumes hold databases, and removing one cannot be undone, so keeper names them and leaves the call to a person.
      reason: `No container uses them, but they can hold database data. Projects: ${projects.join(", ")}. Review with docker volume ls --filter dangling=true and remove with docker volume rm`,
      blockers: [],
    });
  }
  return findings;
}

async function scanSnapshots(): Promise<Finding[]> {
  const list = await run(["sudo", "-n", "btrfs", "subvolume", "list", "-s", "/"]);
  const count = list.stdout.split("\n").filter((line) => line.includes("timeshift")).length;
  if (count === 0) return [];
  return [
    {
      ...findingId("snapshots", "timeshift", String(count)),
      category: "snapshots",
      risk: "high",
      action: "report",
      title: `${count} Timeshift snapshots`,
      paths: [],
      packages: [],
      bytes: 0,
      reason: "Snapshots keep deleted data on disk, so a cleanup can free less than it removed",
      blockers: [],
    },
  ];
}

async function scanLogs(context: Context): Promise<Finding[]> {
  const expand = expandHome(context.paths.home);
  return context.config.logs.map(expand).flatMap((path) => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    if (size <= logCapBytes) return [];
    return [
      {
        ...findingId("logs", path, String(size)),
        category: "logs",
        risk: "low",
        action: "truncate",
        title: path.replace(`${context.paths.home}/`, "~/"),
        paths: [path],
        packages: [],
        bytes: size - logKeepBytes,
        reason: "Appended log that nothing rotates. Keeps the last 5M in place, so a writer can carry on",
        blockers: [],
      } satisfies Finding,
    ];
  });
}

/** Short uncompressed size: 512K, 340M, 2.3G. */
function humanSize(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  const power = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${power >= 3 ? value.toFixed(1) : Math.round(value)}${units[power]}`;
}

/** Whether a path sits inside a git checkout, by walking up to the nearest `.git`. The cache keeps a large walk cheap. */
function hasGitAncestor(path: string, home: string, cache = new Map<string, boolean>()): boolean {
  for (let dir = dirname(path); dir === home || dir.startsWith(`${home}/`); dir = dirname(dir)) {
    const known = cache.get(dir);
    if (known === true) return true;
    if (known === undefined) {
      const found = existsSync(join(dir, ".git"));
      cache.set(dir, found);
      if (found) return true;
    }
    if (dir === home) break;
  }
  return false;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A package keeper can judge as unused: it is installed on purpose and ships a desktop launcher. */
export interface AppPackage {
  name: string;
  bytes: number;
  requiredBy: string[];
  groups: string[];
  /** `.desktop` launcher paths, so a hold on one blocks the package and the finding can point at them. */
  paths: string[];
}

const baseGroups = ["base", "base-devel"];
/** Packages that are part of the machine itself and must never be removed for space. */
const systemPackages = /^(linux|linux-lts|linux-zen|linux-hardened|linux-rt|linux-firmware|systemd|mkinitcpio)/;
const firmwarePackages = /(-firmware$|^firmware-|-(ucode|microcode)$|^(amd|intel)-(ucode|microcode))/;
const driverPackages =
  /(-driver$|^driver-|^nvidia|^lib32-nvidia|^vulkan-|^xf86-video-|^xf86-input-|^mesa|^libva|^libva-|^intel-media-driver|^lib32-mesa)/;
const displayPackages = new Set([
  "xorg-server",
  "xorg-xwayland",
  "wayland",
  "weston",
  "hyprland",
  "sway",
  "i3",
  "gnome-shell",
  "plasma-desktop",
  "kwin",
  "mutter",
  "sddm",
  "gdm",
  "lightdm",
  "greetd",
  "uwsm",
]);

/** During the learning window only the largest unseen apps are shown, so a first run is a shortlist, not a wall. */
const appCandidateLimit = 15;

/**
 * Packages as findings from what pacman reports and what the last-seen ledger remembers. Pure, so tests describe a
 * machine without touching pacman, and the no-atime rule holds by construction: nothing here reads atime.
 *
 * Before the samples cover the window an app cannot be proven unused. Rather than list every installed app as blocked,
 * the largest unseen ones become candidates: still explicit, so only their id can ever remove them, but eligible so a
 * person can act on a big app now instead of waiting out the window. Nothing is offered without at least one sample,
 * because a gap means the watch stopped rather than an app being unused.
 */
export function appFindings(
  packages: readonly AppPackage[],
  usage: UsageLedger | undefined,
  now: number,
  appStaleDays: number,
): Finding[] {
  const day = 86_400_000;
  if (!usage) return [];
  const coverage = coveredDays(usage, now);
  if (coverage === 0) return [];
  const covered = coverage >= appStaleDays;
  const findings = packages.flatMap((pkg): Finding[] => {
    const lastSeen = usage.packages[pkg.name];
    if (lastSeen && (now - Date.parse(lastSeen)) / day < appStaleDays) return [];
    const blockers: string[] = [];
    if (pkg.requiredBy.length) {
      blockers.push(
        `${count(pkg.requiredBy.length, "installed package")} ${pkg.requiredBy.length === 1 ? "depends" : "depend"} on it`,
      );
    }
    if (pkg.groups.some((group) => baseGroups.includes(group)))
      blockers.push("member of a base group the system needs");
    if (systemPackages.test(pkg.name)) blockers.push("a kernel or system package");
    if (firmwarePackages.test(pkg.name)) blockers.push("firmware the hardware may need");
    if (driverPackages.test(pkg.name)) blockers.push("a driver the hardware may need");
    if (displayPackages.has(pkg.name)) blockers.push("part of the display server or desktop session");
    const idle = lastSeen ? Math.floor((now - Date.parse(lastSeen)) / day) : appStaleDays;
    const reason = covered
      ? `Not seen running ${lastSeen ? `${count(idle, "day")} ago` : `in ${count(appStaleDays, "day")}`}, ${humanSize(pkg.bytes)} installed. Removed through pacman, so reinstalling brings it back. Only planned by its id`
      : `Candidate: not seen in ${count(coverage, "day")} of sampling, ${appStaleDays} needed to confirm, ${humanSize(pkg.bytes)} installed. Only an explicit id removes it`;
    return [
      {
        ...findingId("apps", pkg.name, lastSeen ?? "never"),
        category: "apps",
        risk: "medium",
        action: "remove-packages",
        title: pkg.name,
        paths: pkg.paths,
        packages: [pkg.name],
        bytes: pkg.bytes,
        reason,
        explicit: true,
        blockers,
      } satisfies Finding,
    ];
  });
  if (covered) return findings;
  // Learning: only removable candidates, largest first, and only a short list, so the first run stays quiet.
  return findings
    .filter((finding) => finding.blockers.length === 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, appCandidateLimit);
}

/** Explicitly installed packages, their size, dependants and groups, batched so a scan starts a few processes. */
async function packageMetadata(
  names: readonly string[],
): Promise<Map<string, { bytes: number; requiredBy: string[]; groups: string[] }>> {
  const result = new Map<string, { bytes: number; requiredBy: string[]; groups: string[] }>();
  for (let start = 0; start < names.length; start += 200) {
    const batch = names.slice(start, start + 200);
    const output = await run(["expac", "-Q", "-l", "\u001f", "%n\t%N\t%G\t%m", ...batch]);
    if (output.code !== 0) continue;
    for (const line of output.stdout.split("\n")) {
      const [name, requiredBy = "", groups = "", bytes = "0"] = line.split("\t");
      if (!name) continue;
      result.set(name, {
        bytes: Number(bytes) || 0,
        requiredBy: requiredBy.split("\u001f").filter(Boolean),
        groups: groups.split("\u001f").filter(Boolean),
      });
    }
  }
  return result;
}

/** A `.desktop` launcher is what makes a package an app. A CLI tool with only a `/usr/bin` binary is out of scope. */
function isDesktopLauncher(path: string): boolean {
  return path.startsWith("/usr/share/applications/") && path.endsWith(".desktop");
}

/** `pacman -Qo` output as package to `.desktop` launcher paths, ignoring anything that is not a desktop launcher. */
export function launcherOwners(lines: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of lines) {
    const match = /^(.+) is owned by (\S+) /.exec(line);
    const file = match?.[1];
    const name = match?.[2];
    if (!file || !name || !isDesktopLauncher(file)) continue;
    result.set(name, [...(result.get(name) ?? []), file]);
  }
  return result;
}

/**
 * Which desktop launchers each package owns. Reading the applications directory and asking pacman who owns each file is
 * far cheaper than listing every file of every installed package, and it is exactly the `.desktop` set apps cares about.
 */
async function packageLaunchers(): Promise<Map<string, string[]>> {
  const found = await run([
    "find",
    "/usr/share/applications",
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "l",
    ")",
    "-name",
    "*.desktop",
  ]);
  if (found.code !== 0) return new Map();
  const files = found.stdout.split("\n").filter(Boolean);
  const lines: string[] = [];
  for (let start = 0; start < files.length; start += 200) {
    const batch = files.slice(start, start + 200);
    const owners = await run(["pacman", "-Qo", "--", ...batch]);
    if (owners.stdout) lines.push(...owners.stdout.split("\n"));
  }
  return launcherOwners(lines);
}

async function scanApps(context: Context): Promise<Finding[]> {
  const appStaleDays = context.appStaleDays ?? defaultAppStaleDays;
  const launchers = await packageLaunchers();
  if (launchers.size === 0) return [];
  const explicit = await run(["pacman", "-Qeq"]);
  if (explicit.code !== 0) return [];
  const installed = new Set(explicit.stdout.split("\n").filter(Boolean));
  const names = [...launchers.keys()].filter((name) => installed.has(name));
  if (names.length === 0) return [];
  const metadata = await packageMetadata(names);
  return appFindings(appCandidates(names, metadata, launchers), readUsage(context.paths), context.now, appStaleDays);
}

/** Joins package metadata and launchers into app candidates, so a CLI-only package can never become one. */
export function appCandidates(
  names: readonly string[],
  metadata: ReadonlyMap<string, { bytes: number; requiredBy: string[]; groups: string[] }>,
  launchers: ReadonlyMap<string, readonly string[]>,
): AppPackage[] {
  return names.flatMap((name): AppPackage[] => {
    const meta = metadata.get(name);
    const paths = (launchers.get(name) ?? []).filter(isDesktopLauncher);
    if (!meta || paths.length === 0) return [];
    return [{ name, bytes: meta.bytes, requiredBy: meta.requiredBy, groups: meta.groups, paths }];
  });
}

async function xdgDir(name: "DOWNLOAD" | "PICTURES", context: Context, fallback: string): Promise<string> {
  if (name === "DOWNLOAD" && context.downloadDir) return context.downloadDir;
  if (name === "PICTURES" && context.picturesDir) return context.picturesDir;
  const result = await run(["xdg-user-dir", name]);
  if (result.code === 0 && result.stdout.startsWith("/")) return result.stdout;
  return join(context.paths.home, fallback);
}

function screenshotDirs(home: string, pictures: string): string[] {
  return [
    ...new Set([
      join(pictures, "Screenshots"),
      join(pictures, "screenshots"),
      join(home, "Screenshots"),
      join(pictures, "grim"),
      join(pictures, "hyprshot"),
    ]),
  ];
}

/** Directories other categories already own, so `large` leaves those files to them. */
async function otherOwnedDirs(context: Context): Promise<string[]> {
  const download = await xdgDir("DOWNLOAD", context, "Downloads");
  const pictures = await xdgDir("PICTURES", context, "Pictures");
  return [...new Set([download, ...screenshotDirs(context.paths.home, pictures)])];
}

/**
 * The user's own document trees. A duplicate is only offered when the copy keeper keeps sits in a different one of
 * these, so two files inside one application or project never count as a duplicate.
 */
async function personalDirs(context: Context): Promise<string[]> {
  const download = await xdgDir("DOWNLOAD", context, "Downloads");
  const pictures = await xdgDir("PICTURES", context, "Pictures");
  const named = ["Documents", "Music", "Videos", "Desktop"].map((name) => join(context.paths.home, name));
  return [...new Set([download, pictures, ...named])];
}

/** A duplicate is only offered across two of these roots, never inside one tree. */
function personalRoot(path: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => path === root || path.startsWith(`${root}/`));
}

const appTreeNames = new Set([
  "games",
  "gog",
  "gog games",
  "lutris",
  "heroic",
  "steam",
  "steamlibrary",
  "steamapps",
  "epic games",
  "battlenet",
  "battle.net",
  "ubisoft",
  "ubisoft connect",
  "ea games",
  "origin",
  "playonlinux",
  "bottles",
  "proton",
  "wine",
  "wineprefix",
  "drive_c",
  "flatpak",
  "virtualbox vms",
  "vms",
  "virtual machines",
  "qemu",
  "libvirt",
  "vmware",
  "vagrant",
]);
const appTreeChildren = new Set(["drive_c", "system.reg", "steamapps"]);
/** Files that mark a directory as an application install rather than a person's document. */
const installMarkers = new Set([
  ".exe",
  ".msi",
  ".dll",
  ".toc",
  ".pak",
  ".vpk",
  ".uasset",
  ".umap",
  ".bundle",
  ".w3speech",
  ".arc",
  ".forge",
  ".assets",
  ".bank",
  ".bnk",
  ".pck",
  ".rpa",
  ".xp3",
  ".vdf",
  ".acf",
  ".vdi",
  ".vmdk",
  ".qcow2",
  ".vhd",
  ".vhdx",
  ".ova",
  ".ovf",
  ".vbox",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function isInstallMarker(name: string): boolean {
  return installMarkers.has(extensionOf(name));
}

function isAppTreeDir(dir: string, cache: Map<string, boolean>): boolean {
  const known = cache.get(dir);
  if (known !== undefined) return known;
  let verdict = appTreeNames.has(basename(dir).toLowerCase());
  if (!verdict) {
    try {
      verdict = readdirSync(dir).some((name) => appTreeChildren.has(name) || isInstallMarker(name));
    } catch {
      verdict = false;
    }
  }
  cache.set(dir, verdict);
  return verdict;
}

/**
 * Whether a file belongs to an installed application rather than the person's own documents. Games, Wine prefixes,
 * Steam, Lutris, Heroic and GOG libraries, flatpak data and VM stores are all install trees, and so is any directory
 * holding an install marker such as a `.exe`, `.toc` or `.pak`. `large` and `duplicates` never offer these.
 */
export function insideAppTree(path: string, home: string, cache = new Map<string, boolean>()): boolean {
  if (isInstallMarker(basename(path))) return true;
  for (let dir = dirname(path); dir === home || dir.startsWith(`${home}/`); dir = dirname(dir)) {
    if (dir === home) return false;
    if (isAppTreeDir(dir, cache)) return true;
  }
  return false;
}

const partialExtensions = [".crdownload", ".part", ".partial", ".download", ".opdownload"];
const installerExtensions = [".pkg.tar.zst", ".pkg.tar.xz", ".pkg.tar.zstd", ".AppImage"];

async function scanDownloads(context: Context): Promise<Finding[]> {
  const dir = await xdgDir("DOWNLOAD", context, "Downloads");
  return entries(dir).flatMap((path): Finding[] => {
    if (!isFile(path)) return [];
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return [];
    }
    const name = basename(path);
    const age = (context.now - stat.mtimeMs) / 86_400_000;
    const partial = partialExtensions.some((ext) => name.endsWith(ext));
    const installer = installerExtensions.some((ext) => name.endsWith(ext));
    // Partials are abandoned once a day old, so they are low risk then and offered sooner than the idle window.
    if (!partial && age < context.staleDays) return [];
    const risk: Risk = partial && age >= 1 ? "low" : "medium";
    const reason = `${
      partial
        ? "Incomplete download, safe to discard once it stopped changing"
        : installer
          ? `${humanSize(stat.size)} installer that a package or app was installed from`
          : `${humanSize(stat.size)} in Downloads, not touched for ${count(context.staleDays, "day")}`
    }. Only planned by its id`;
    return [
      {
        ...findingId("downloads", path, `${stat.size}\0${Math.round(stat.mtimeMs)}`),
        category: "downloads",
        risk,
        action: "trash",
        title: path.replace(`${context.paths.home}/`, "~/"),
        paths: [path],
        packages: [],
        bytes: stat.size,
        reason,
        explicit: true,
        blockers: holders(path, context.live) ? [inUse] : [],
      } satisfies Finding,
    ];
  });
}

const screenshotExtensions = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"];

async function scanScreenshots(context: Context): Promise<Finding[]> {
  const pictures = await xdgDir("PICTURES", context, "Pictures");
  const dirs = screenshotDirs(context.paths.home, pictures).filter(existsSync);
  return dirs.flatMap((dir) =>
    entries(dir).flatMap((path): Finding[] => {
      const name = basename(path);
      if (!screenshotExtensions.some((ext) => name.endsWith(ext))) return [];
      if (!isFile(path)) return [];
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        return [];
      }
      if ((context.now - stat.mtimeMs) / 86_400_000 < context.staleDays) return [];
      return [
        {
          ...findingId("screenshots", path, `${stat.size}\0${Math.round(stat.mtimeMs)}`),
          category: "screenshots",
          risk: "medium",
          action: "trash",
          title: path.replace(`${context.paths.home}/`, "~/"),
          paths: [path],
          packages: [],
          bytes: stat.size,
          reason: `Screenshot not touched for ${count(context.staleDays, "day")}, kept in a screenshots folder. Only planned by its id`,
          explicit: true,
          blockers: holders(path, context.live) ? [inUse] : [],
        } satisfies Finding,
      ];
    }),
  );
}

/**
 * Large stale files under $HOME. The walk stays on one filesystem (`-xdev`, so mount points and network mounts are
 * skipped) and prunes dot directories, which is where config, caches and git metadata live. Git repos, downloads,
 * screenshots and application trees are left alone, so game data, Wine prefixes and VM images are never offered.
 */
async function scanLarge(context: Context): Promise<Finding[]> {
  const threshold = context.config.largeBytes;
  const walk = await run([
    "find",
    context.paths.home,
    "-xdev",
    "(",
    "-name",
    ".*",
    "-prune",
    ")",
    "-o",
    "(",
    "-type",
    "f",
    "-size",
    `+${threshold}c`,
    "-printf",
    "%s\\t%T@\\t%p\\n",
    ")",
  ]);
  if (walk.code !== 0) return [];
  const owned = await otherOwnedDirs(context);
  const appTrees = new Map<string, boolean>();
  const gitTrees = new Map<string, boolean>();
  return walk.stdout.split("\n").flatMap((line): Finding[] => {
    const [size = "0", mtime = "0", ...rest] = line.split("\t");
    const path = rest.join("\t");
    const bytes = Number(size);
    if (!path || !bytes) return [];
    const age = (context.now - Number(mtime) * 1000) / 86_400_000;
    if (age < context.staleDays) return [];
    if (owned.some((dir) => path.startsWith(`${dir}/`))) return [];
    if (hasGitAncestor(path, context.paths.home, gitTrees)) return [];
    if (insideAppTree(path, context.paths.home, appTrees)) return [];
    return [
      {
        ...findingId("large", path, `${bytes}\0${Math.round(Number(mtime) * 1000)}`),
        category: "large",
        risk: "medium",
        action: "trash",
        title: path.replace(`${context.paths.home}/`, "~/"),
        paths: [path],
        packages: [],
        bytes,
        reason: `${humanSize(bytes)} file not modified for ${count(context.staleDays, "day")}. Git repos, config dirs, downloads, screenshots and application trees are left alone. Only planned by its id`,
        explicit: true,
        blockers: holders(path, context.live) ? [inUse] : [],
      } satisfies Finding,
    ];
  });
}

/** The head of a file is enough to split most same-size files before the full hash runs. */
async function partialHash(path: string): Promise<string> {
  const head = await Bun.file(path).slice(0, partialHashBytes).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(head)).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The copy to keep: newest, then shallowest path, then the first alphabetically. */
function keepCopy(files: readonly { path: string; mtime: number }[]): string {
  const newest = Math.max(...files.map((file) => file.mtime));
  const tied = files.filter((file) => file.mtime === newest);
  return tied.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0]
    ?.path as string;
}

/**
 * Identical files under $HOME, size first, then a partial hash, then a full hash, so a large home is hashed only
 * where two files already share a size. Hard links, files in git repos and application trees are skipped. A copy is
 * offered only when the kept copy sits in a different one of the user's own document trees, never inside one tree.
 * Hidden directories are pruned like `large`, so caches and git metadata stay out.
 */
async function scanDuplicates(context: Context): Promise<Finding[]> {
  const walk = await run([
    "find",
    context.paths.home,
    "-xdev",
    "(",
    "-name",
    ".*",
    "-prune",
    ")",
    "-o",
    "(",
    "-type",
    "f",
    "-links",
    "1",
    "-printf",
    "%s\\t%T@\\t%p\\n",
    ")",
  ]);
  if (walk.code !== 0) return [];
  const personal = await personalDirs(context);
  const appTrees = new Map<string, boolean>();
  const gitTrees = new Map<string, boolean>();
  const files = walk.stdout.split("\n").flatMap((line): { path: string; bytes: number; mtime: number }[] => {
    const [size = "0", mtime = "0", ...rest] = line.split("\t");
    const path = rest.join("\t");
    const bytes = Number(size);
    if (!path || bytes === 0) return [];
    return [{ path, bytes, mtime: Math.round(Number(mtime) * 1000) }];
  });
  const bySize = new Map<number, typeof files>();
  for (const file of files) bySize.set(file.bytes, [...(bySize.get(file.bytes) ?? []), file]);
  const duplicates: { kept: string; copy: (typeof files)[number] }[] = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    // A file only matters once it shares a size with another, so the repo and app-tree walk runs on those few files.
    const candidates = group.filter(
      (file) =>
        !hasGitAncestor(file.path, context.paths.home, gitTrees) &&
        !insideAppTree(file.path, context.paths.home, appTrees),
    );
    if (candidates.length < 2) continue;
    const byPartial = new Map<string, typeof group>();
    for (const file of candidates) {
      const key = await partialHash(file.path);
      byPartial.set(key, [...(byPartial.get(key) ?? []), file]);
    }
    for (const partials of byPartial.values()) {
      if (partials.length < 2) continue;
      const byFull = new Map<string, typeof group>();
      for (const file of partials) {
        const key = await sha256File(file.path);
        byFull.set(key, [...(byFull.get(key) ?? []), file]);
      }
      for (const identical of byFull.values()) {
        if (identical.length < 2) continue;
        const kept = keepCopy(identical);
        const keptRoot = personalRoot(kept, personal);
        if (!keptRoot) continue;
        for (const copy of identical) {
          if (copy.path === kept) continue;
          const copyRoot = personalRoot(copy.path, personal);
          if (!copyRoot || copyRoot === keptRoot) continue;
          duplicates.push({ kept, copy });
        }
      }
    }
  }
  return duplicates.map(
    ({ kept, copy }) =>
      ({
        ...findingId("duplicates", copy.path, `${copy.bytes}\0${copy.mtime}`),
        category: "duplicates",
        risk: "medium",
        action: "trash",
        title: copy.path.replace(`${context.paths.home}/`, "~/"),
        paths: [copy.path],
        packages: [],
        bytes: copy.bytes,
        reason: `Identical to ${kept.replace(`${context.paths.home}/`, "~/")}, which keeper keeps. Only planned by its id`,
        explicit: true,
        blockers: holders(copy.path, context.live) ? [inUse] : [],
      }) satisfies Finding,
  );
}

interface RawProcess {
  pid: number;
  ppid: number;
  uid: number;
  nice: number;
  /** utime + stime in clock ticks, so two snapshots give the CPU used between them. */
  ticks: number;
  age: number;
  session: number;
  command: string;
  state: string;
  cgroup?: string;
}

function readProcess(pid: number, uptime: number): RawProcess | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    // Everything after the command: state, ppid, pgrp, then utime, stime, nice and starttime further along.
    const fields = stat.slice(close + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      uid: lstatSync(`/proc/${pid}`).uid,
      nice: Number(fields[16]),
      ticks: Number(fields[11]) + Number(fields[12]),
      state: fields[0] ?? "?",
      session: Number(fields[3]),
      age: uptime - Number(fields[19]) / clockTicks,
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() || `[${comm}]`,
      cgroup: attempt(() => readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").at(-1)?.split(":")[2]),
    };
  } catch {
    return undefined; // the process exited while it was being read
  }
}

function snapshot(): Map<number, RawProcess> {
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  return new Map(
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => {
        const found = readProcess(Number(name), uptime);
        return found ? ([[found.pid, found]] as [number, RawProcess][]) : [];
      }),
  );
}

/** Two snapshots give real usage instead of ps's average over a process's whole life. */
async function sampleProcesses(milliseconds = sampleMs): Promise<{
  processes: ProcessInfo[];
  cores: number;
  loadAverage: number;
}> {
  const before = snapshot();
  await Bun.sleep(milliseconds);
  const after = snapshot();
  const seconds = milliseconds / 1000;
  const processes = [...after].flatMap(([pid, now]) => {
    const then = before.get(pid);
    if (!then) return []; // started during the sample, so there is no usage to measure
    const { ppid, uid, nice, age, session, command, state, cgroup } = now;
    const cpu = ((now.ticks - then.ticks) / clockTicks / seconds) * 100;
    const stdin = attempt(() => readlinkSync(`/proc/${pid}/fd/0`));
    const autogroup = attempt(() => readFileSync(`/proc/${pid}/autogroup`, "utf8").split(" ")[0]);
    const cpuSeconds = now.ticks / clockTicks;
    return [{ pid, ppid, uid, nice, age, session, command, cpu, cpuSeconds, stdin, autogroup, state, cgroup }];
  });
  return { processes, cores: availableParallelism(), loadAverage: loadavg()[0] ?? 0 };
}

/** Another user's process, or one that exited, cannot be read, which is the same as not knowing. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function autogroupEnabled(): boolean {
  return attempt(() => readFileSync("/proc/sys/kernel/sched_autogroup_enabled", "utf8").trim()) === "1";
}

/**
 * An interactive program whose terminal closed while it ignored the hangup: reparented to init, its stdin a pseudo
 * terminal that no longer exists. Nobody can use or quit it any more, so one that keeps the CPU busy is stopped.
 */
function orphaned(proc: ProcessInfo): boolean {
  return (
    proc.ppid === 1 &&
    /^\/dev\/pts\/\d+ \(deleted\)$/.test(proc.stdin ?? "") &&
    proc.cpu >= minGroupCpu &&
    proc.age >= orphanMinutes * 60
  );
}

/** Where a process tree stops: init, a multiplexer or remote login, or the desktop session itself. */
function treeBoundary(proc: ProcessInfo): boolean {
  const name = commandName(proc.command);
  return proc.pid <= 2 || sessionCommands.has(name) || /^(tmux|screen|zellij|sshd|login)\b/.test(name);
}

/**
 * The process a tree of work hangs from: the highest ancestor below a terminal, multiplexer pane or init that the same
 * user owns. Two projects in two panes are two trees, while a build and every worker it spawns are one.
 */
function treeRoots(processes: readonly ProcessInfo[]): Map<number, number> {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const roots = new Map<number, number>();
  for (const proc of processes) {
    let at = proc;
    for (let parent = byPid.get(at.ppid); parent && parent.uid === at.uid && !treeBoundary(parent); ) {
      at = parent;
      parent = byPid.get(at.ppid);
    }
    roots.set(proc.pid, at.pid);
  }
  return roots;
}

/** This keeper run and every process above it, which is the session that asked for the scan. */
function callers(processes: readonly ProcessInfo[]): Set<number> {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const found = new Set<number>([process.pid]);
  for (let at = byPid.get(process.ppid); at && !found.has(at.pid); at = byPid.get(at.ppid)) found.add(at.pid);
  return found;
}

/**
 * Groups by command within one process tree, not by process group or by name alone: a desktop session puts the window
 * manager, terminals and everything a build spawns into one process group, and a name alone puts every project's
 * `bun` or `claude` into one row, so renicing either would slow work nobody chose. Kernel threads are not offered.
 */
async function scanLoad(context: Context): Promise<Finding[]> {
  const sample = context.processes
    ? {
        processes: context.processes,
        cores: context.cores ?? availableParallelism(),
        loadAverage: context.loadAverage ?? loadavg()[0] ?? 0,
      }
    : await sampleProcesses();
  const { cores, loadAverage } = sample;
  const me = process.getuid?.() ?? -1;
  const asking = callers(sample.processes);
  const orphans = sample.processes.filter((proc) => proc.uid === me && !asking.has(proc.pid) && orphaned(proc));
  // An orphan busy for half an hour is worth stopping on a quiet machine too, so it skips the load gate.
  const stops = orphans.map(
    (proc) =>
      ({
        // Apply rescans, so a pid that was reused meanwhile has to be an orphaned dead terminal with this command too.
        ...findingId("load", `orphan\0${proc.pid}`, proc.command),
        category: "load",
        risk: "medium",
        action: "stop",
        title: clip(proc.command),
        paths: [],
        packages: [],
        bytes: 0,
        cpu: Math.round(proc.cpu),
        pids: [proc.pid],
        reason: `${Math.round(proc.cpu)}% of one core for ${Math.round(proc.age / 60)} minutes after its terminal closed. Nothing can use or quit it any more, so stopping it loses no work anyone can reach. Only planned by its id`,
        explicit: true,
        blockers: [],
      }) satisfies Finding,
  );
  if (loadAverage <= cores * loadPerCore) return stops;
  const stopped = new Set(orphans.map((proc) => proc.pid));
  // kthreadd is pid 2 and the parent of every kernel thread, which no renice from here can or should touch.
  const processes = sample.processes.filter((proc) => proc.pid !== 2 && proc.ppid !== 2 && !stopped.has(proc.pid));
  const roots = treeRoots(processes);
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  // With autogroup on the scheduler splits CPU between sessions first, so only a session's autogroup nice moves CPU
  // away from it. The desktop's group and the caller's are never lowered, since an agent shell can share either.
  const autogroupOn = context.autogroup ?? autogroupEnabled();
  const spared = new Set(
    processes
      .filter((proc) => sessionCommands.has(commandName(proc.command)) || asking.has(proc.pid))
      .map((proc) => proc.autogroup),
  );
  const groups = new Map<string, { name: string; members: ProcessInfo[] }>();
  for (const proc of processes) {
    const name = commandName(proc.command);
    const key = `${name}\0${roots.get(proc.pid)}`;
    const group = groups.get(key) ?? { name, members: [] };
    group.members.push(proc);
    groups.set(key, group);
  }
  const renices = [...groups].flatMap(([key, { name, members }]) => {
    const cpu = members.reduce((sum, member) => sum + member.cpu, 0);
    const heaviest = members.reduce((hot, member) => (member.cpu > hot.cpu ? member : hot));
    const oldest = members.reduce((long, member) => (member.age > long.age ? member : long));
    const used = members.reduce((sum, member) => sum + member.cpuSeconds, 0);
    const sustained = oldest.age >= minGroupMinutes * 60 || used >= minGroupCoreMinutes * 60;
    if (cpu < minGroupCpu || !sustained) return [];
    const pids = members.map((member) => member.pid).sort((a, b) => a - b);
    const blockers: string[] = [];
    if (sessionCommands.has(name)) blockers.push("part of your desktop session, which is what has to stay responsive");
    if (members.every((member) => member.nice >= lowestPriority)) blockers.push("already at the bottom priority");
    if (pids.some((pid) => asking.has(pid)))
      blockers.push(
        "includes this keeper run or the session that started it, and keeper never lowers its caller: a scan after it exits judges the rest",
      );
    if (heaviest.uid !== me) blockers.push("owned by another user");
    // One member per autogroup is enough to name it.
    const named = new Map<string, number>();
    for (const { autogroup, pid } of members)
      if (autogroupOn && autogroup && !spared.has(autogroup) && !named.has(autogroup)) named.set(autogroup, pid);
    const autogroups = [...named.values()];
    const root = byPid.get(roots.get(heaviest.pid) ?? -1);
    const parent =
      !autogroupOn &&
      root &&
      !pids.includes(root.pid) &&
      root.uid === me &&
      !asking.has(root.pid) &&
      !sessionCommands.has(commandName(root.command))
        ? root.pid
        : undefined;
    return [
      {
        // Command and tree are the state: workers come and go, and "rustc in this build is hammering the machine" is
        // what was judged.
        ...findingId("load", key, "cpu"),
        category: "load",
        risk: "medium",
        action: "renice",
        title: `${clip(heaviest.command)}${pids.length > 1 ? ` (+${pids.length - 1} more)` : ""}`,
        paths: [],
        packages: [],
        bytes: 0,
        cpu: Math.round(cpu),
        pids,
        reason: `${Math.round(cpu)}% of one core while load is ${loadAverage.toFixed(1)} on ${cores} cores. Lowering its priority keeps it running and gives the CPU back to the apps you are using`,
        blockers,
        ...(autogroups.length ? { autogroups } : {}),
        ...(parent ? { parent } : {}),
      } satisfies Finding,
    ];
  });
  const sustained = processes.some(
    (proc) => proc.age >= minGroupMinutes * 60 || proc.cpuSeconds >= minGroupCoreMinutes * 60,
  );
  if (!stops.length && !renices.length && sustained) {
    const accounted = processes.reduce((sum, proc) => sum + proc.cpu, 0) / 100;
    const unexplained = loadAverage - accounted;
    if (unexplained > 1) {
      const io = processes.filter((proc) => proc.state === "D").length;
      const hint = io
        ? `${io} sampled process${io === 1 ? " is" : "es are"} in uninterruptible IO sleep`
        : "CPU-visible processes do not account for the load";
      return [
        ...stops,
        {
          ...findingId("load", "unattributed", `${loadAverage}\0${accounted}\0${io}`),
          category: "load",
          risk: "low",
          action: "report",
          title: "load not explained by CPU work",
          paths: [],
          packages: [],
          bytes: 0,
          cpu: Math.round(accounted * 100),
          reason: `Load is ${loadAverage.toFixed(1)} on ${cores} cores, but sampled CPU work accounts for only ${accounted.toFixed(1)} runnable cores: ${hint}. Check the memory category for reclaim pressure and IO wait before renicing anything`,
          blockers: ["diagnostic only; no process explains the remaining load"],
        } satisfies Finding,
      ];
    }
  }
  return [...stops, ...renices];
}

/** argv[0] without its directory, which is what a person would call the program. */
function commandName(command: string): string {
  return basename(command.split(" ")[0] ?? command);
}

function clip(command: string): string {
  return command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function readPressure(): MemoryPressure {
  try {
    const text = readFileSync("/proc/pressure/memory", "utf8");
    const average = (kind: string) => Number(new RegExp(`${kind} avg10=([\\d.]+)`).exec(text)?.[1] ?? 0);
    return { some: average("some"), full: average("full") };
  } catch {
    return { some: 0, full: 0 }; // a kernel without pressure stall information
  }
}

function commandsIn(cgroup: string, limit = 3): string[] {
  try {
    const commands = readFileSync(join(cgroup, "cgroup.procs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        } catch {
          return "";
        }
      });
    return [...new Set(commands.filter(Boolean))].slice(0, limit);
  } catch {
    return [];
  }
}

/** Walks the slices a person's processes live in, keeping only cgroups that have a `memory.high` cap and are at it. */
function readCgroups(): CgroupUsage[] {
  const found: CgroupUsage[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (!isDirectory(path)) continue;
      try {
        const high = readFileSync(join(path, "memory.high"), "utf8").trim();
        const current = Number(readFileSync(join(path, "memory.current"), "utf8"));
        if (high !== "max" && current >= Number(high) * cgroupCap) {
          found.push({ path, current, high: Number(high), commands: commandsIn(path) });
        }
      } catch {}
      walk(path, depth + 1);
    }
  };
  for (const root of cgroupRoots) walk(root, 0);
  return found;
}

/** RSS and swap, cwd, cgroup and the newest write to an open file, read only for a process that could be abandoned. */
function readFacts(proc: ProcessInfo): ProcessInfo {
  const status = attempt(() => readFileSync(`/proc/${proc.pid}/status`, "utf8")) ?? "";
  const kib = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? 0) * 1024;
  let written = 0;
  for (const fd of entries(`/proc/${proc.pid}/fd`)) {
    // Stdout and stderr are where whoever started it captured its output, the file counterpart of a terminal. A
    // detached child of a supervisor that has gone appends there while it retries, which shows it alive, not its work.
    if (/\/fd\/[12]$/.test(fd)) continue;
    const target = attempt(() => readlinkSync(fd));
    if (!target?.startsWith("/") || target.startsWith("/dev/") || target.endsWith(" (deleted)")) continue;
    const info = attempt(() => readFileSync(fd.replace("/fd/", "/fdinfo/"), "utf8")) ?? "";
    const flags = Number.parseInt(/^flags:\s+(\d+)/m.exec(info)?.[1] ?? "0", 8);
    if ((flags & 3) === 0) continue; // opened read-only
    const stat = attempt(() => statSync(target));
    if (stat?.isFile()) written = Math.max(written, stat.mtimeMs);
  }
  return {
    ...proc,
    memory: kib("VmRSS") + kib("VmSwap"),
    cwd: attempt(() => readlinkSync(`/proc/${proc.pid}/cwd`)),
    cgroup: attempt(() => readFileSync(`/proc/${proc.pid}/cgroup`, "utf8").trim().split("\n").at(-1)?.split(":")[2]),
    written,
  };
}

/** The script an interpreter runs, resolved against its working directory. */
function scriptOf(proc: ProcessInfo): string | undefined {
  const [program = "", ...args] = proc.command.split(" ");
  if (!interpreters.test(basename(program))) return undefined;
  const script = args.find(
    (arg) => !arg.startsWith("-") && (arg.includes("/") || /\.[cm]?[jt]sx?$|\.(py|sh|rb|pl)$/.test(arg)),
  );
  if (!script) return undefined;
  return script.startsWith("/") || !proc.cwd ? script : join(proc.cwd, script);
}

/**
 * Why nobody can reach this process any more, or undefined when someone still can. A live terminal on stdin means a
 * person or a pane can type into it, and a process in the desktop's own session was autostarted by it. Otherwise it was reparented to init or the user manager, or to a multiplexer
 * server while the pane session it was started in is gone.
 */
function detachment(proc: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>): string | undefined {
  if (/^\/dev\/(pts\/\d+|tty\d*)$/.test(proc.stdin ?? "")) return undefined;
  // The compositor double-forks what it autostarts, so a tray applet sits under init inside the desktop's session.
  const leader = proc.session === undefined ? undefined : byPid.get(proc.session);
  if (leader && sessionCommands.has(commandName(leader.command))) return undefined;
  const parent = byPid.get(proc.ppid);
  if (proc.ppid === 1 || (parent && commandName(parent.command) === "systemd")) return "reparented to init";
  if (parent && multiplexers.test(commandName(parent.command)) && proc.session !== proc.pid) {
    if (proc.session !== undefined && !byPid.has(proc.session))
      return `reparented to ${commandName(parent.command)} after its pane closed`;
  }
  return undefined;
}

/**
 * Long-lived processes nobody can reach that sit idle on RAM and swap, such as a test fixture whose runner was killed
 * before its cleanup ran. Each signal alone also fits live work, so every one is required: detached, idle over the
 * sample, older than `abandonedHours`, and either its script was deleted or, unless it daemonised itself on purpose,
 * it has written no open file besides its own output for as long. Shells, editors, multiplexers, systemd units and the caller are never offered.
 */
function abandonedFindings(context: Context, processes: readonly ProcessInfo[]): Finding[] {
  const me = process.getuid?.() ?? -1;
  const asking = callers(processes);
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const holds = liveHolds(context.paths, context.now);
  const window = abandonedHours * 3600;
  return processes.flatMap((sampled) => {
    const name = commandName(sampled.command);
    if (sampled.uid !== me || asking.has(sampled.pid) || sampled.pid <= 2) return [];
    if (sampled.age < window || sampled.cpu >= idleCpu) return [];
    if (keptCommands.has(name) || sessionCommands.has(name)) return [];
    const how = detachment(sampled, byPid);
    if (!how) return [];
    const proc = context.processes ? sampled : readFacts(sampled);
    const held = proc.memory ?? 0;
    if (held < minHeldBytes || proc.cgroup?.endsWith(".service")) return [];
    const script = scriptOf(proc);
    if (shells.has(name) && !script) return []; // an interactive shell
    const quiet = (proc.written ?? 0) < context.now - window * 1000;
    const evidence =
      script && !existsSync(script)
        ? `its script ${script} no longer exists`
        : proc.session !== proc.pid && quiet
          ? `it has written nothing but its own output for ${abandonedHours} hours`
          : undefined;
    if (!evidence) return [];
    const blockers = holds
      .filter((hold) =>
        [proc.cwd, script].some((path) => path && (path === hold.path || path.startsWith(`${hold.path}/`))),
      )
      .map(holdBlocker);
    return [
      {
        // Apply rescans, so a pid that was reused meanwhile has to be abandoned with this command too.
        ...findingId("memory", `abandoned\0${proc.pid}`, proc.command),
        category: "memory",
        risk: "medium",
        action: "stop",
        title: clip(proc.command),
        paths: [],
        packages: [],
        bytes: 0,
        memory: held,
        cpu: Math.round(proc.cpu),
        pids: [proc.pid],
        reason: `${humanSize(held)} of RAM and swap held, idle for ${Math.round(proc.age / 3600)} hours, ${how}, and ${evidence}. Nothing can reach it, so stopping it frees the memory. Only planned by its id`,
        explicit: true,
        blockers,
      } satisfies Finding,
    ];
  });
}

/**
 * Reports where memory is stalled. `report`, never `trash`: keeper cannot decide whose working set to drop, and the cap
 * that is thrashing was usually set on purpose. High `bytes` here is memory held, not space a cleanup would free.
 */
async function scanMemory(context: Context): Promise<Finding[]> {
  // Abandoned holders are worth stopping on a machine with room to spare too, so they skip the pressure gate.
  const abandoned = abandonedFindings(context, context.processes ?? (await sampleProcesses()).processes);
  return [...abandoned, ...pressureFindings(context)];
}

function pressureFindings(context: Context): Finding[] {
  const pressure = context.pressure ?? readPressure();
  const pinned = context.cgroups ?? readCgroups();
  if (pressure.full < memoryStall && pinned.length === 0) return [];
  if (pinned.length === 0) {
    return [
      {
        ...findingId("memory", "pressure", "stall"),
        category: "memory",
        risk: "medium",
        action: "report",
        title: `memory pressure: every task stalled ${Math.round(pressure.full)}% of the time`,
        paths: [],
        packages: [],
        bytes: 0,
        reason: "No cgroup is at a cap, so the working set simply does not fit in RAM",
        blockers: [],
      },
    ];
  }
  return pinned.map((cgroup) => {
    const name = cgroupName(cgroup.path);
    const command = cgroup.commands[0];
    return {
      ...findingId("memory", cgroup.path, String(cgroup.high)),
      category: "memory",
      risk: "medium",
      action: "report",
      title: command ? `${name} · ${clip(command)}` : name,
      paths: [],
      packages: [],
      bytes: cgroup.current,
      reason: `${gigabytes(cgroup.current)} held against a ${gigabytes(cgroup.high)} memory.high cap, while every task stalls on memory ${Math.round(pressure.full)}% of the time`,
      blockers: [],
    };
  });
}

/** Session scopes carry a full UUID; the short form is enough to find one with systemctl. */
function cgroupName(path: string): string {
  const name = basename(path).replace(/\.scope$/, "");
  return /^(agent-session-[0-9a-f]{8})-[0-9a-f-]+$/.exec(name)?.[1] ?? name;
}

const scanners: Record<Category, (context: Context) => Promise<Finding[]>> = {
  worktree: scanWorktrees,
  aur: scanAur,
  "pacman-cache": scanPacmanCache,
  orphans: scanOrphans,
  agent: scanAgent,
  build: scanBuild,
  transcripts: scanTranscripts,
  tmp: scanTmp,
  "package-cache": scanPackageCaches,
  docker: scanDocker,
  snapshots: scanSnapshots,
  logs: scanLogs,
  apps: scanApps,
  large: scanLarge,
  downloads: scanDownloads,
  screenshots: scanScreenshots,
  duplicates: scanDuplicates,
  load: scanLoad,
  memory: scanMemory,
};

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** `done` hears each category as it finishes, with its finding count, or undefined when it failed. */
function holdBlocker(hold: Hold): string {
  return `held by ${hold.actor} until ${hold.until}: ${hold.reason}. keeper release ${hold.path} ends it early`;
}

/** Holds are applied on every read, never stored, so a cached finding reflects a hold made or released since. */
export function withHolds(context: Context, findings: readonly Finding[]): Finding[] {
  const holds = liveHolds(context.paths, context.now);
  return findings.map((finding) => {
    const held = holds.filter((hold) => finding.paths.some((path) => overlaps(path, hold.path))).map(holdBlocker);
    return held.length ? { ...finding, blockers: [...finding.blockers, ...held] } : finding;
  });
}

/**
 * Scans each category, reporting its findings, before holds, as it finishes, or undefined when it failed. `warned` says
 * the category finished but is incomplete, so it must not stand in for a later scan.
 */
export async function scan(
  context: Context,
  only: readonly Category[] = categories,
  done?: (category: Category, findings: Finding[] | undefined, warned: boolean) => void,
): Promise<Scan> {
  const warnings: string[] = [];
  const results = await Promise.all(
    only.map((category) => {
      let warned = false;
      const warn = (message: string) => {
        warned = true;
        warnings.push(`${category}: ${message}`);
      };
      return scanners[category]({ ...context, warn }).then(
        (findings) => {
          done?.(category, findings, warned);
          return findings;
        },
        (error) => {
          warnings.push(`${category}: ${error}`);
          done?.(category, undefined, true);
          return [] as Finding[];
        },
      );
    }),
  );
  const at = new Date(context.now).toISOString();
  return {
    schemaVersion,
    scannedAt: at,
    categoryScannedAt: Object.fromEntries(only.map((category) => [category, at])),
    findings: withHolds(context, results.flat()).sort((a, b) => b.bytes - a.bytes),
    warnings,
  };
}
