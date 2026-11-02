import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { readLedger } from "./ledger";
import { ageDays, expandHome, holders, type Paths, run, sizes } from "./system";
import { type Category, categories, type Finding, type Scan, schemaVersion } from "./types";

export const defaultStaleDays = 7;
const staleBuildDays = 3;
const transcriptDays = 14;
const logCapBytes = 50 * 1024 ** 2;
export const logKeepBytes = 5 * 1024 ** 2;
const buildDirs = /\/(target|node_modules|\.next|\.turbo|\.venv)$/;

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
  /** Sampled processes, so a test never has to race a real machine. Absent means the scan reads /proc. */
  processes?: readonly ProcessInfo[];
  /** Replaces the GitHub lookup in tests. */
  pullRequests?: (repo: string) => Promise<PullRequest[]>;
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

/** A file written after the scan's clock was read has a slightly negative age, which still means today. */
function touchedAgo(days: number): string {
  const whole = Math.max(0, Math.floor(days));
  return whole === 0 ? "touched today" : whole === 1 ? "touched 1 day ago" : `touched ${whole} days ago`;
}

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

/** No gh, no auth or no network means no proof, which leaves a worktree behind the age window and approval. */
async function listPullRequests(repo: string): Promise<PullRequest[]> {
  const fields = "number,state,headRefName,headRefOid";
  const result = await run(["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", fields], repo);
  if (result.code !== 0) return [];
  try {
    return JSON.parse(result.stdout) as PullRequest[];
  } catch {
    return [];
  }
}

/** An operation in progress is unfinished work, however clean and pushed the tree looks. */
const unfinishedOperations = ["rebase-merge", "rebase-apply", "BISECT_LOG", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

type PullRequestLookup = (commonDir: string, path: string) => Promise<PullRequest[]>;

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
  if (!valid) blockers.push("not a valid checkout, so its work cannot be checked");
  if (status.stdout) blockers.push(`${status.stdout.split("\n").length} uncommitted or untracked files`);
  if (holders(path, context.live)) blockers.push("in use by a running process");
  const operation = unfinishedOperations.find((name) => gitDir && existsSync(join(gitDir, name)));
  if (operation) blockers.push(`${operation} is in progress`);
  const pullRequests = valid && commonDir ? await lookup(commonDir, path) : [];
  const open = pullRequests.find((pr) => pr.state === "OPEN" && pr.headRefName === branch);
  if (open) blockers.push(`PR #${open.number} is open`);
  // The commit must match too: a branch name gets reused, and a branch can gain commits after its PR merged.
  const merged = pullRequests.find(
    (pr) => pr.state === "MERGED" && pr.headRefName === branch && pr.headRefOid === head,
  );
  // A merged branch is usually deleted from the remote, and the pull request is what still holds this commit.
  if (!merged && (ahead.code !== 0 || ahead.stdout !== "0")) {
    blockers.push(ahead.stdout === "1" ? "1 commit on no remote" : `${ahead.stdout || "unknown"} commits on no remote`);
  }
  const mainline = defaultBranch.stdout.replace(/^origin\//, "");
  const contained =
    Boolean(defaultBranch.stdout) &&
    branch !== mainline &&
    (await git("merge-base", "--is-ancestor", "HEAD", defaultBranch.stdout)).code === 0;
  const proof = merged ? `Merged in PR #${merged.number}` : contained ? "Every commit is on the default branch" : "";
  // Commits and checkouts move logs/HEAD. The index will not do: any `git status` rewrites it.
  const touched = Math.min(
    ageDays(path, context.now),
    gitDir ? headAge(gitDir, context.now) : Number.POSITIVE_INFINITY,
  );
  // Only a merge outruns the age window. A branch just cut from main is also contained in it, and is about to be used.
  if (!merged && touched < context.staleDays) blockers.push(touchedAgo(touched));
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
  const lookup: PullRequestLookup = (commonDir, path) => {
    const found = known.get(commonDir) ?? fetch(path);
    known.set(commonDir, found);
    return found;
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
  if (holders(path, context.live)) blockers.push("in use by a running process");
  if (age < context.staleDays) blockers.push(touchedAgo(age));
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
      ? ["a package build is running"]
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
      blockers: (await building()) ? ["a package operation is running"] : [],
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
      title: `${packages.length} orphaned packages`,
      paths: [],
      packages,
      bytes,
      reason: "Installed as dependencies that nothing requires any more",
      blockers: (await building()) ? ["a package operation is running"] : [],
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
    if (holders(path, context.live)) blockers.push("in use by a running process");
    if (age < context.staleDays) blockers.push(touchedAgo(age));
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
  const ignored = (
    await Promise.all(
      candidates.map(async (path) => {
        if (await hasRecentFile(path, staleBuildDays)) return undefined;
        const parent = dirname(path);
        const name = basename(path);
        const check = await run(["git", "-C", parent, "check-ignore", "-q", name]);
        const tracked = await run(["git", "-C", parent, "ls-files", name]);
        return check.code === 0 && tracked.code === 0 && tracked.stdout === "" ? path : undefined;
      }),
    )
  ).filter((path): path is string => path !== undefined);
  const bytes = await sizes(ignored);
  return ignored.map((path) => ({
    id: findingId("build", path, String(bytes.get(path))),
    category: "build",
    risk: "low",
    action: "trash",
    title: path.replace(`${context.paths.home}/`, "~/"),
    paths: [path],
    packages: [],
    bytes: bytes.get(path) ?? 0,
    reason: "Git-ignored build output, restored by the next build or install",
    blockers: holders(path, context.live) ? ["in use by a running process"] : [],
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
      title: `${files.length} agent transcripts over ${transcriptDays} days old`,
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
        blockers: (await running(cache.tool)) ? [`${cache.tool} is running`] : [],
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
      reason: `${Math.round(reclaimableBuildCache / 1e9)}G reclaimable. Pruning drops entries unused for ${dockerCacheHours / 24} days; builds still reuse anything newer`,
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
    if (pids.includes(process.pid)) blockers.push("this keeper run is part of the command");
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
  load: scanLoad,
  memory: scanMemory,
};

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** `done` hears each category as it finishes, with its finding count, or undefined when it failed. */
export async function scan(
  context: Context,
  only: readonly Category[] = categories,
  done?: (category: Category, findings: number | undefined) => void,
): Promise<Scan> {
  const warnings: string[] = [];
  const results = await Promise.all(
    only.map((category) =>
      scanners[category](context).then(
        (findings) => {
          done?.(category, findings.length);
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
  const holds = readLedger(context.paths).holds.filter((hold) => Date.parse(hold.until) > context.now);
  const findings = results.flat();
  for (const finding of findings) {
    for (const hold of holds) {
      if (finding.paths.some((path) => overlaps(path, hold.path))) {
        finding.blockers.push(`held by ${hold.actor} until ${hold.until}: ${hold.reason}`);
      }
    }
  }
  return {
    schemaVersion,
    scannedAt: new Date(context.now).toISOString(),
    findings: findings.sort((a, b) => b.bytes - a.bytes),
    warnings,
  };
}
