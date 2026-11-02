import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { readLedger } from "./ledger";
import { ageDays, expandHome, holders, type Paths, run, sizes } from "./system";
import { type Category, categories, count, type Finding, type Risk, type Scan, schemaVersion } from "./types";
import { readUsage, type UsageLedger } from "./usage";

export const defaultStaleDays = 7;
/** Apps are used less often than files, so an app is judged unused over a longer window by default. */
export const defaultAppStaleDays = 90;
/** Large files are offered at this apparent size or above, unless the config says otherwise. */
export const defaultLargeBytes = 500 * 1024 ** 2;
const staleBuildDays = 3;
const transcriptDays = 14;
const logCapBytes = 50 * 1024 ** 2;
export const logKeepBytes = 5 * 1024 ** 2;
const buildDirs = /\/(target|node_modules|\.next|\.turbo|\.venv)$/;
/** The head of a file is enough to split most same-size files before the full hash runs. */
const partialHashBytes = 64 * 1024;

/** A machine this far past its core count is oversubscribed, so `load` findings become worth showing. */
const loadPerCore = 1.25;
/** Groups below this share of a core are noise, and renicing them would change nothing. */
const minGroupCpu = 25;
/** Short bursts are normal; only work that has held the CPU this long is deprioritised. */
const minGroupMinutes = 5;
const sampleMs = 200;
const clockTicks = 100;
/** The bottom of the range: what nice can give without root. */
export const lowestPriority = 19;
/** Below this share of time spent fully stalled, memory pressure is not what a person is feeling. */
const memoryStall = 10;
/** A cgroup this close to its memory.high cap is being throttled rather than merely busy. */
const cgroupCap = 0.9;
const cgroupRoots = ["/sys/fs/cgroup/user.slice", "/sys/fs/cgroup/agent.slice"];

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
  /** Sampled processes, so a test never has to race a real machine. Absent means the scan reads /proc. */
  processes?: readonly ProcessInfo[];
  /** Replaces the GitHub lookup in tests. With a branch, it lists only that branch's pull requests. */
  pullRequests?: (repo: string, branch?: string) => Promise<PullRequest[]>;
  cores?: number;
  loadAverage?: number;
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
  command: string;
}

export function findingId(category: Category, target: string, state: string): string {
  return createHash("sha256").update(`${category}\0${target}\0${state}`).digest("hex").slice(0, 10);
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

/** The newest pull requests in one call. A busy repository has more, so a branch missing here is looked up by name. */
const pullRequestLimit = 1000;

/** No gh, no auth or no network means no proof, which leaves a worktree behind the age window and approval. */
async function listPullRequests(repo: string, branch?: string): Promise<PullRequest[]> {
  const fields = "number,state,headRefName,headRefOid";
  const filter = branch ? ["--head", branch] : [];
  const command = ["gh", "pr", "list", "--state", "all", "--limit", String(pullRequestLimit), ...filter];
  const result = await run([...command, "--json", fields], repo);
  if (result.code !== 0) return [];
  try {
    return JSON.parse(result.stdout) as PullRequest[];
  } catch {
    return [];
  }
}

/** An operation in progress is unfinished work, however clean and pushed the tree looks. */
const unfinishedOperations = ["rebase-merge", "rebase-apply", "BISECT_LOG", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

/**
 * A merged pull request proves this checkout when it holds every local commit: the head is the PR's head, or an ancestor
 * of it when the PR gained commits pushed from elsewhere. The commit test matters because branch names get reused, and
 * a branch can gain commits after its PR merged. The ancestor test needs commits that no remote holds: without them the
 * checkout has no work of its own, like a branch just cut from main under a reused name, so only the age window may
 * judge it.
 */
async function findMerged(
  pullRequests: readonly PullRequest[],
  branch: string,
  head: string,
  git: (...args: string[]) => Promise<{ code: number }>,
  ownCommits: boolean,
): Promise<PullRequest | undefined> {
  const candidates = pullRequests.filter((pr) => pr.state === "MERGED" && pr.headRefName === branch);
  const exact = candidates.find((pr) => pr.headRefOid === head);
  if (exact || !ownCommits) return exact;
  for (const pr of candidates) {
    if ((await git("merge-base", "--is-ancestor", "HEAD", pr.headRefOid)).code === 0) return pr;
  }
  return undefined;
}

type PullRequestLookup = (commonDir: string, path: string, branch: string) => Promise<PullRequest[]>;

async function inspectWorktree(
  path: string,
  context: Context,
  bytes: number,
  lookup: PullRequestLookup,
): Promise<Finding> {
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
  const pullRequests = valid && commonDir ? await lookup(commonDir, path, branch) : [];
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
    id: findingId("worktree", path, `${head}\0${status.stdout}\0${proof}\0${open?.number ?? ""}`),
    category: "worktree",
    risk: proof ? "low" : "medium",
    action: "trash",
    title: `${relativeToRoot(path, context.paths.worktrees)} (${branch || "unknown branch"})`,
    paths: [path],
    packages: [],
    bytes,
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

function headAge(gitDir: string, now: number): number {
  try {
    return ageDays(join(gitDir, "logs/HEAD"), now);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function scanWorktrees(context: Context): Promise<Finding[]> {
  const dirs = context.paths.worktrees.flatMap(worktreeDirs);
  const leftovers = context.paths.worktrees.flatMap(leftoverDirs);
  const bytes = await sizes([...dirs, ...leftovers]);
  const fetch = context.pullRequests ?? listPullRequests;
  const known = new Map<string, Promise<PullRequest[]>>();
  const lookup: PullRequestLookup = async (commonDir, path, branch) => {
    const found = known.get(commonDir) ?? fetch(path);
    known.set(commonDir, found);
    const all = await found;
    // A full page means older pull requests went unlisted, so a branch it lacks gets a lookup of its own.
    if (all.length < pullRequestLimit || branch === "HEAD" || all.some((pr) => pr.headRefName === branch)) return all;
    return fetch(path, branch);
  };
  return found([
    ...(await Promise.all(
      dirs.map((dir) => unlessGone(dir, () => inspectWorktree(dir, context, bytes.get(dir) ?? 0, lookup))),
    )),
    ...(await Promise.all(
      leftovers.map((dir) => unlessGone(dir, () => inspectLeftover(dir, context, bytes.get(dir) ?? 0))),
    )),
  ]);
}

/** A directory beside worktrees that is not a checkout, usually what a manual removal left behind. */
function leftoverDirs(root: string): string[] {
  return entries(root)
    .filter((dir) => isDirectory(dir) && !existsSync(join(dir, ".git")))
    .flatMap((dir) => entries(dir).filter((child) => isDirectory(child) && !existsSync(join(child, ".git"))));
}

async function inspectLeftover(path: string, context: Context, bytes: number): Promise<Finding> {
  // Branch names with a slash nest worktrees a level deeper, so this one may be a parent of live checkouts.
  const nested = await run(["find", path, "-maxdepth", "3", "-name", ".git", "-print", "-quit"]);
  const age = await newestAge(path, context.now);
  const blockers: string[] = [];
  if (nested.stdout) blockers.push("contains a checkout");
  if (holders(path, context.live)) blockers.push(inUse);
  if (age < context.staleDays) blockers.push(touchedAgo(age, context.staleDays));
  return {
    id: findingId("worktree", path, `leftover\0${bytes}`),
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
    id: findingId("aur", path, String(bytes.get(path))),
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
      id: findingId("pacman-cache", "paccache", String(bytes)),
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
      id: findingId("orphans", "orphans", packages.join(",")),
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

async function scanAgent(context: Context): Promise<Finding[]> {
  const expand = expandHome(context.paths.home);
  const patterns = context.config.agentCachePatterns.map((pattern) => new RegExp(pattern));
  const cached = entries(join(context.paths.home, ".cache")).filter((path) =>
    patterns.some((pattern) => pattern.test(path.slice(path.lastIndexOf("/") + 1))),
  );
  const claimed = readLedger(context.paths).claims.map((claim) => claim.path);
  const roots = [...new Set([...context.config.agentRoots.map(expand), ...claimed, ...cached])].filter(existsSync);
  const bytes = await sizes(roots);
  const inspect = (path: string): Finding => {
    const age = ageDays(path, context.now);
    const blockers: string[] = [];
    if (holders(path, context.live)) blockers.push(inUse);
    if (age < context.staleDays) blockers.push(touchedAgo(age, context.staleDays));
    return {
      id: findingId("agent", path, `${statSync(path).mtimeMs}`),
      category: "agent",
      risk: "low",
      action: "trash",
      title: path.replace(`${context.paths.home}/`, "~/"),
      paths: [path],
      packages: [],
      bytes: bytes.get(path) ?? 0,
      reason: "Allowlisted agent output",
      blockers,
    } satisfies Finding;
  };
  return found(await Promise.all(roots.map((path) => unlessGone(path, () => inspect(path)))));
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
    ...context.paths.worktrees.flatMap(worktreeDirs),
    ...context.config.repoRoots.flatMap((root) => worktreeDirs(expand(root))),
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
  const bytes = await sizes(ignored.map((entry) => entry.path));
  return ignored.map(({ path, recent }) => ({
    id: findingId("build", path, `${bytes.get(path)}\0${recent}`),
    category: "build",
    risk: "low",
    action: "trash",
    title: path.replace(`${context.paths.home}/`, "~/"),
    paths: [path],
    packages: [],
    bytes: bytes.get(path) ?? 0,
    reason: "Git-ignored build output, restored by the next build or install",
    blockers: [
      ...(holders(path, context.live) ? [inUse] : []),
      ...(recent
        ? [`built in the last ${count(staleBuildDays, "day")}, offered after ${count(staleBuildDays, "idle day")}`]
        : []),
    ],
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
      id: findingId("transcripts", "transcripts", files.map(([, path]) => path).join("\0")),
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
        id: findingId("package-cache", path, String(size)),
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
      id: findingId("docker", "dangling-images", `${dangling.length}:${bytes}`),
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
      id: findingId("docker", "build-cache", String(reclaimableBuildCache)),
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
      id: findingId("docker", "volumes", unused.map((volume) => volume.Name).join(",")),
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
      id: findingId("snapshots", "timeshift", String(count)),
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
        id: findingId("logs", path, String(size)),
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

/** Whether a path sits inside a git checkout, by walking up to the nearest `.git`. */
function hasGitAncestor(path: string, home: string): boolean {
  for (let dir = dirname(path); dir === home || dir.startsWith(`${home}/`); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
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

/** A package keeper can judge as unused: it is installed on purpose and ships something to launch. */
export interface AppPackage {
  name: string;
  bytes: number;
  requiredBy: string[];
  groups: string[];
  /** `.desktop` and `/usr/bin` paths, so a hold on one blocks the package and the finding can point at them. */
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

/**
 * Packages as findings from what pacman reports and what the last-seen ledger remembers. Pure, so tests describe a
 * machine without touching pacman, and the no-atime rule holds by construction: nothing here reads atime.
 */
export function appFindings(
  packages: readonly AppPackage[],
  usage: UsageLedger | undefined,
  now: number,
  appStaleDays: number,
): Finding[] {
  const day = 86_400_000;
  const since = usage ? Date.parse(usage.since) : undefined;
  const coverageDays = since !== undefined ? (now - since) / day : 0;
  const covered = since !== undefined && coverageDays >= appStaleDays;
  return packages.flatMap((pkg): Finding[] => {
    const lastSeen = usage?.packages[pkg.name];
    if (lastSeen && (now - Date.parse(lastSeen)) / day < appStaleDays) return [];
    const idleDays = lastSeen ? (now - Date.parse(lastSeen)) / day : coverageDays;
    const blockers: string[] = [];
    if (!covered) {
      blockers.push(
        `usage has only been tracked for ${Math.floor(coverageDays)} of ${appStaleDays} days, offered once the ledger covers the window`,
      );
    }
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
    return [
      {
        id: findingId("apps", pkg.name, lastSeen ?? "never"),
        category: "apps",
        risk: "medium",
        action: "remove-packages",
        title: pkg.name,
        paths: pkg.paths,
        packages: [pkg.name],
        bytes: pkg.bytes,
        reason: `Installed on purpose, ${humanSize(pkg.bytes)} installed, and ${
          lastSeen
            ? `last seen running ${count(Math.floor(idleDays), "day")} ago`
            : "never seen running while usage was tracked"
        }. Removed through pacman, so reinstalling brings it back`,
        blockers,
      } satisfies Finding,
    ];
  });
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

/** Which launcher and `/usr/bin` files each package ships, so only apps with something to launch are judged. */
async function packageLaunchers(names: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (let start = 0; start < names.length; start += 200) {
    const batch = names.slice(start, start + 200);
    const output = await run(["pacman", "-Ql", ...batch]);
    if (output.code !== 0) continue;
    for (const line of output.stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space < 0) continue;
      const name = line.slice(0, space);
      const path = line.slice(space + 1);
      if (!path) continue;
      const launcher = path.startsWith("/usr/share/applications/") && path.endsWith(".desktop");
      const binary = path.startsWith("/usr/bin/") && !path.endsWith("/");
      if (launcher || binary) result.set(name, [...(result.get(name) ?? []), path]);
    }
  }
  return result;
}

async function scanApps(context: Context): Promise<Finding[]> {
  const appStaleDays = context.appStaleDays ?? defaultAppStaleDays;
  const explicit = await run(["pacman", "-Qeq"]);
  if (explicit.code !== 0) return [];
  const names = explicit.stdout.split("\n").filter(Boolean);
  if (names.length === 0) return [];
  const [metadata, launchers] = await Promise.all([packageMetadata(names), packageLaunchers(names)]);
  const apps = names.flatMap((name): AppPackage[] => {
    const meta = metadata.get(name);
    const paths = launchers.get(name) ?? [];
    if (!meta || paths.length === 0) return [];
    return [{ name, bytes: meta.bytes, requiredBy: meta.requiredBy, groups: meta.groups, paths }];
  });
  return appFindings(apps, readUsage(context.paths), context.now, appStaleDays);
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

/** Directories other categories already own, so `large` and `duplicates` leave those files to them. */
async function otherOwnedDirs(context: Context): Promise<string[]> {
  const download = await xdgDir("DOWNLOAD", context, "Downloads");
  const pictures = await xdgDir("PICTURES", context, "Pictures");
  return [...new Set([download, ...screenshotDirs(context.paths.home, pictures)])];
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
    const reason = partial
      ? `Incomplete download, safe to discard once it stopped changing`
      : installer
        ? `${humanSize(stat.size)} installer that a package or app was installed from`
        : `${humanSize(stat.size)} in Downloads, not touched for ${count(context.staleDays, "day")}`;
    return [
      {
        id: findingId("downloads", path, `${stat.size}\0${Math.round(stat.mtimeMs)}`),
        category: "downloads",
        risk,
        action: "trash",
        title: path.replace(`${context.paths.home}/`, "~/"),
        paths: [path],
        packages: [],
        bytes: stat.size,
        reason,
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
          id: findingId("screenshots", path, `${stat.size}\0${Math.round(stat.mtimeMs)}`),
          category: "screenshots",
          risk: "medium",
          action: "trash",
          title: path.replace(`${context.paths.home}/`, "~/"),
          paths: [path],
          packages: [],
          bytes: stat.size,
          reason: `Screenshot not touched for ${count(context.staleDays, "day")}, kept in a screenshots folder`,
          blockers: holders(path, context.live) ? [inUse] : [],
        } satisfies Finding,
      ];
    }),
  );
}

/**
 * Large stale files under $HOME. The walk stays on one filesystem (`-xdev`, so mount points and network mounts are
 * skipped) and prunes dot directories, which is where config, caches and git metadata live. Git repos, downloads and
 * screenshots are left to their own categories, so a file is never offered twice.
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
  return walk.stdout.split("\n").flatMap((line): Finding[] => {
    const [size = "0", mtime = "0", ...rest] = line.split("\t");
    const path = rest.join("\t");
    const bytes = Number(size);
    if (!path || !bytes) return [];
    const age = (context.now - Number(mtime) * 1000) / 86_400_000;
    if (age < context.staleDays) return [];
    if (owned.some((dir) => path.startsWith(`${dir}/`))) return [];
    if (hasGitAncestor(path, context.paths.home)) return [];
    return [
      {
        id: findingId("large", path, `${bytes}\0${Math.round(Number(mtime) * 1000)}`),
        category: "large",
        risk: "medium",
        action: "trash",
        title: path.replace(`${context.paths.home}/`, "~/"),
        paths: [path],
        packages: [],
        bytes,
        reason: `${humanSize(bytes)} file not modified for ${count(context.staleDays, "day")}. Git repos, config dirs and downloads are left to their own categories`,
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
 * where two files already share a size. Hard links and files in git repos are skipped, and the kept copy is never
 * offered. Hidden directories are pruned like `large`, so caches and git metadata stay out.
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
  const owned = await otherOwnedDirs(context);
  const files = walk.stdout.split("\n").flatMap((line): { path: string; bytes: number; mtime: number }[] => {
    const [size = "0", mtime = "0", ...rest] = line.split("\t");
    const path = rest.join("\t");
    const bytes = Number(size);
    if (!path || bytes === 0) return [];
    if (owned.some((dir) => path.startsWith(`${dir}/`))) return [];
    if (hasGitAncestor(path, context.paths.home)) return [];
    return [{ path, bytes, mtime: Math.round(Number(mtime) * 1000) }];
  });
  const bySize = new Map<number, typeof files>();
  for (const file of files) bySize.set(file.bytes, [...(bySize.get(file.bytes) ?? []), file]);
  const duplicates: { kept: string; copy: (typeof files)[number] }[] = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byPartial = new Map<string, typeof group>();
    for (const file of group) {
      const key = await partialHash(file.path);
      byPartial.set(key, [...(byPartial.get(key) ?? []), file]);
    }
    for (const candidates of byPartial.values()) {
      if (candidates.length < 2) continue;
      const byFull = new Map<string, typeof candidates>();
      for (const file of candidates) {
        const key = await sha256File(file.path);
        byFull.set(key, [...(byFull.get(key) ?? []), file]);
      }
      for (const identical of byFull.values()) {
        if (identical.length < 2) continue;
        const kept = keepCopy(identical);
        for (const copy of identical) {
          if (copy.path !== kept) duplicates.push({ kept, copy });
        }
      }
    }
  }
  return duplicates.map(
    ({ kept, copy }) =>
      ({
        id: findingId("duplicates", copy.path, `${copy.bytes}\0${copy.mtime}`),
        category: "duplicates",
        risk: "medium",
        action: "trash",
        title: copy.path.replace(`${context.paths.home}/`, "~/"),
        paths: [copy.path],
        packages: [],
        bytes: copy.bytes,
        reason: `Identical to ${kept.replace(`${context.paths.home}/`, "~/")}, which keeper keeps`,
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
  command: string;
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
      age: uptime - Number(fields[19]) / clockTicks,
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() || `[${comm}]`,
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
    const { ppid, uid, nice, age, command } = now;
    return [{ pid, ppid, uid, nice, age, command, cpu: ((now.ticks - then.ticks) / clockTicks / seconds) * 100 }];
  });
  return { processes, cores: availableParallelism(), loadAverage: loadavg()[0] ?? 0 };
}

/**
 * Groups by command, not by process group: a desktop session puts the window manager, terminals and everything a build
 * spawns into one group, so renicing that group would slow the very thing that has to stay responsive.
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
  if (loadAverage <= cores * loadPerCore) return [];
  const groups = new Map<string, ProcessInfo[]>();
  for (const proc of sample.processes) {
    const name = commandName(proc.command);
    groups.set(name, [...(groups.get(name) ?? []), proc]);
  }
  const me = process.getuid?.() ?? -1;
  return [...groups].flatMap(([name, members]) => {
    const cpu = members.reduce((sum, member) => sum + member.cpu, 0);
    const heaviest = members.reduce((hot, member) => (member.cpu > hot.cpu ? member : hot));
    const oldest = members.reduce((long, member) => (member.age > long.age ? member : long));
    if (cpu < minGroupCpu || oldest.age < minGroupMinutes * 60) return [];
    const pids = members.map((member) => member.pid).sort((a, b) => a - b);
    const blockers: string[] = [];
    if (sessionCommands.has(name)) blockers.push("part of your desktop session, which is what has to stay responsive");
    if (members.every((member) => member.nice >= lowestPriority)) blockers.push("already at the bottom priority");
    if (pids.includes(process.pid))
      blockers.push(
        "includes this keeper run, and keeper never lowers its own priority: a scan after it exits judges the rest",
      );
    if (heaviest.uid !== me) blockers.push("owned by another user");
    return [
      {
        // The command name is the state: workers come and go, and "rustc is hammering this machine" is what was judged.
        id: findingId("load", name, "cpu"),
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
      } satisfies Finding,
    ];
  });
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

/**
 * Reports where memory is stalled. `report`, never `trash`: keeper cannot decide whose working set to drop, and the cap
 * that is thrashing was usually set on purpose. High `bytes` here is memory held, not space a cleanup would free.
 */
async function scanMemory(context: Context): Promise<Finding[]> {
  const pressure = context.pressure ?? readPressure();
  const pinned = context.cgroups ?? readCgroups();
  if (pressure.full < memoryStall && pinned.length === 0) return [];
  if (pinned.length === 0) {
    return [
      {
        id: findingId("memory", "pressure", "stall"),
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
      id: findingId("memory", cgroup.path, String(cgroup.high)),
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
/** Holds are applied on every read, never stored, so a cached finding reflects a hold made or released since. */
export function withHolds(context: Context, findings: readonly Finding[]): Finding[] {
  const holds = readLedger(context.paths).holds.filter((hold) => Date.parse(hold.until) > context.now);
  return findings.map((finding) => {
    const held = holds
      .filter((hold) => finding.paths.some((path) => overlaps(path, hold.path)))
      .map(
        (hold) =>
          `held by ${hold.actor} until ${hold.until}: ${hold.reason}. keeper release ${hold.path} ends it early`,
      );
    return held.length ? { ...finding, blockers: [...finding.blockers, ...held] } : finding;
  });
}

/** Scans each category, reporting its findings, before holds, as it finishes, or undefined when it failed. */
export async function scan(
  context: Context,
  only: readonly Category[] = categories,
  done?: (category: Category, findings: Finding[] | undefined) => void,
): Promise<Scan> {
  const warnings: string[] = [];
  const results = await Promise.all(
    only.map((category) =>
      scanners[category](context).then(
        (findings) => {
          done?.(category, findings);
          return findings;
        },
        (error) => {
          warnings.push(`${category}: ${error}`);
          done?.(category, undefined);
          return [] as Finding[];
        },
      ),
    ),
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
