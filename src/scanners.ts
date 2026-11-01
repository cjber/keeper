import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ageDays, holders, type Paths, run, sizes } from "./system";
import { type Category, type Finding, type Scan, schemaVersion } from "./types";

export const defaultStaleDays = 7;
const staleBuildDays = 3;
const transcriptDays = 14;
const buildDirs = /\/(target|node_modules|\.next|\.turbo|\.venv)$/;

export interface Config {
  /** Absolute paths or `~/` paths to directories that hold only disposable agent output. */
  agentRoots: string[];
  /** Regular expressions matched against entry names directly under ~/.cache. */
  agentCachePatterns: string[];
  /** Directories of git checkouts whose ignored build output may be cleaned. */
  repoRoots: string[];
}

export interface Context {
  paths: Paths;
  config: Config;
  live: readonly string[];
  now: number;
  /** Worktrees and agent output touched more recently than this are blocked. */
  staleDays: number;
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

async function inspectWorktree(path: string, context: Context, bytes: number): Promise<Finding> {
  const git = (...args: string[]) => run(["git", "--no-optional-locks", "-C", path, ...args]);
  const valid = (await git("rev-parse", "--git-common-dir")).code === 0;
  const blockers: string[] = [];
  const [status, ahead, head, branch, commonDir] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-list", "--count", "HEAD", "--not", "--remotes"),
    git("rev-parse", "HEAD"),
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  if (!valid) blockers.push("not a valid checkout, so its work cannot be checked");
  if (status.stdout) blockers.push(`${status.stdout.split("\n").length} uncommitted or untracked files`);
  // Ancestry of main says nothing after a squash merge, so the question is only whether HEAD exists on a remote.
  if (ahead.code !== 0 || ahead.stdout !== "0") blockers.push(`${ahead.stdout || "unknown"} commits on no remote`);
  if (holders(path, context.live)) blockers.push("in use by a running process");
  const gitIndex = commonDir.stdout ? entries(join(commonDir.stdout, "worktrees")) : [];
  const touched = Math.min(ageDays(path, context.now), ...gitIndex.filter(sameWorktree(path)).map(headAge(context)));
  if (touched < context.staleDays) blockers.push(`touched ${Math.floor(touched)} days ago`);
  return {
    id: findingId("worktree", path, `${head.stdout}\0${status.stdout}`),
    category: "worktree",
    risk: "medium",
    action: "trash",
    title: `${path.replace(`${context.paths.worktrees}/`, "")} (${branch.stdout || "unknown branch"})`,
    paths: [path],
    packages: [],
    bytes,
    reason: "Worktree with every commit on a remote and nothing uncommitted",
    blockers,
    gitDir: commonDir.stdout || undefined,
  };
}

/** Commits and checkouts move logs/HEAD. The index will not do: any `git status` rewrites it. */
function sameWorktree(path: string): (admin: string) => boolean {
  return (admin) => {
    try {
      return readFileSync(join(admin, "gitdir"), "utf8").trim() === join(path, ".git");
    } catch {
      return false;
    }
  };
}

function headAge(context: Context): (admin: string) => number {
  return (admin) => {
    try {
      return ageDays(join(admin, "logs/HEAD"), context.now);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
}

async function scanWorktrees(context: Context): Promise<Finding[]> {
  const dirs = worktreeDirs(context.paths.worktrees);
  const bytes = await sizes(dirs);
  return Promise.all(dirs.map((dir) => inspectWorktree(dir, context, bytes.get(dir) ?? 0)));
}

async function building(): Promise<boolean> {
  return (await run(["pgrep", "-x", "paru|makepkg|pacman"])).code === 0;
}

async function scanAur(context: Context): Promise<Finding[]> {
  const clones = entries(context.paths.paruClone).filter(isDirectory);
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
  const relative = (path: string) => path.replace(`${context.paths.paruClone}/`, "");
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
  const expand = (path: string) => (path.startsWith("~/") ? join(context.paths.home, path.slice(2)) : path);
  const patterns = context.config.agentCachePatterns.map((pattern) => new RegExp(pattern));
  const cached = entries(join(context.paths.home, ".cache")).filter((path) =>
    patterns.some((pattern) => pattern.test(path.slice(path.lastIndexOf("/") + 1))),
  );
  const roots = [...context.config.agentRoots.map(expand).filter(existsSync), ...cached];
  const bytes = await sizes(roots);
  return roots.map((path) => {
    const age = ageDays(path, context.now);
    const blockers: string[] = [];
    if (holders(path, context.live)) blockers.push("in use by a running process");
    if (age < context.staleDays) blockers.push(`touched ${Math.floor(age)} days ago`);
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
  });
}

/** Newest of a directory and its direct entries: a build or install touches those even when the top is unchanged. */
function newestAge(path: string, now: number): number {
  return Math.min(ageDays(path, now), ...entries(path).map((entry) => lstatAge(entry, now)));
}

function lstatAge(path: string, now: number): number {
  try {
    return (now - lstatSync(path).mtimeMs) / 86_400_000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Build output is disposable even inside a worktree that must stay, which is where most of the space sits. */
async function scanBuild(context: Context): Promise<Finding[]> {
  const expand = (path: string) => (path.startsWith("~/") ? join(context.paths.home, path.slice(2)) : path);
  const repos = [
    ...worktreeDirs(context.paths.worktrees),
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
  const stale = candidates.filter((path) => newestAge(path, context.now) >= staleBuildDays);
  const ignored = (
    await Promise.all(
      stale.map(async (path) => {
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
  const roots = [".codex/sessions", ".codex/archived_sessions", ".claude/projects", ".claude/jobs"];
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

async function scanUv(context: Context): Promise<Finding[]> {
  const cache = join(context.paths.home, ".cache/uv");
  if (!existsSync(cache)) return [];
  const bytes = (await sizes([cache])).get(cache) ?? 0;
  return [
    {
      id: findingId("uv-cache", cache, String(bytes)),
      category: "uv-cache",
      risk: "low",
      action: "uv-prune",
      title: "uv cache",
      paths: [],
      packages: [],
      bytes: 0,
      reason: `Cache holds ${Math.round(bytes / 1024 ** 3)}G. Pruning removes entries no environment needs, so the amount freed is unknown until it runs`,
      blockers: [],
    },
  ];
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

const scanners: Record<Category, (context: Context) => Promise<Finding[]>> = {
  worktree: scanWorktrees,
  aur: scanAur,
  "pacman-cache": scanPacmanCache,
  orphans: scanOrphans,
  agent: scanAgent,
  build: scanBuild,
  transcripts: scanTranscripts,
  "uv-cache": scanUv,
  snapshots: scanSnapshots,
};

export async function scan(context: Context, only?: readonly Category[]): Promise<Scan> {
  const selected = only ?? (Object.keys(scanners) as Category[]);
  const warnings: string[] = [];
  const results = await Promise.all(
    selected.map((category) =>
      scanners[category](context).catch((error) => {
        warnings.push(`${category}: ${error}`);
        return [] as Finding[];
      }),
    ),
  );
  return {
    schemaVersion,
    scannedAt: new Date(context.now).toISOString(),
    findings: results.flat().sort((a, b) => b.bytes - a.bytes),
    warnings,
  };
}
