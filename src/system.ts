import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawning blocks the calling thread for about a millisecond per child, and a scan starts thousands.
 * Started all at once they freeze the wizard and flood a machine that is already loaded, so few run at a time.
 */
const maxChildren = 12;
let children = 0;
const waiting: (() => void)[] = [];

/** The exit code `timeout` uses, for a command `run` stopped because it outlived its wait. */
export const timedOut = 124;

/**
 * With `timeoutMs`, a command still running after that long is killed with its children and reported as `timedOut`, so a child that
 * never returns cannot hold its slot, and the scan behind it, forever.
 */
export async function run(argv: string[], cwd?: string, timeoutMs?: number): Promise<Result> {
  // A finishing child hands its slot straight to the next waiter, so the count never overshoots.
  if (children >= maxChildren) await new Promise<void>((resolve) => waiting.push(resolve));
  else children++;
  try {
    return await spawn(argv, cwd, timeoutMs);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else children--;
  }
}

/**
 * Waits up to `ms` for a command and reports whether it finished. Unlike `timeout`, which waits for a child that
 * ignores its signal, as a sync stuck on a busy disk does, this returns on time and leaves the command running.
 */
export async function waitFor(argv: string[], ms: number): Promise<boolean> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
  return Promise.race([child.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

async function spawn(argv: string[], cwd?: string, timeoutMs?: number): Promise<Result> {
  try {
    // A timed command leads its own process group, so the kill below also reaches whatever it started.
    const detached = timeoutMs !== undefined;
    const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached });
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, code]) => ({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (timeoutMs === undefined) return await finished;
    let expire = () => {};
    const expired = new Promise<undefined>((resolve) => {
      expire = () => resolve(undefined);
    });
    const timer = setTimeout(() => expire(), timeoutMs);
    const result = await Promise.race([finished, expired]);
    clearTimeout(timer);
    if (result) return result;
    // The whole group, because a wrapper's own child would otherwise live on and keep the pipes open.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    // Not awaited: a process that left the group can still hold a pipe, and a killed command's output is no answer.
    finished.catch(() => {});
    return { code: timedOut, stdout: "", stderr: `${argv[0]} did not finish within ${timeoutMs / 1000} s` };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
}

export interface Paths {
  home: string;
  worktrees: string[];
  aurClones: string[];
  state: string;
  /** Where an older keeper kept its trash, which apply now deletes. */
  oldTrash: string;
  /** The temp dir the `tmp` category scans: $TMPDIR, else /tmp. */
  tmp: string;
  config: string;
  units: string;
  /** The kernel's mount table, read before each deletion so it never deletes a filesystem mounted inside a path. */
  mountinfo: string;
}

export function defaultPaths(home = homedir(), env: Record<string, string | undefined> = process.env): Paths {
  return {
    home,
    worktrees: [join(home, ".worktrees")],
    aurClones: [join(home, ".cache/paru/clone"), join(home, ".cache/yay")],
    state: join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "keeper"),
    oldTrash: join(home, ".local/share/keeper/trash"),
    tmp: resolve(env.TMPDIR || "/tmp"),
    config: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "keeper/config.toml"),
    units: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd/user"),
    mountinfo: "/proc/self/mountinfo",
  };
}

export function expandHome(home: string): (path: string) => string {
  return (path) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

/** Every path a running process holds as its cwd or an open file. Unreadable processes belong to other users. */
export function liveFiles(): string[] {
  const live = new Set<string>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      live.add(readlinkSync(`/proc/${pid}/cwd`));
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target.startsWith("/")) live.add(target);
      }
    } catch {}
  }
  return [...live];
}

export function holders(path: string, live: readonly string[]): boolean {
  const prefix = `${path}/`;
  return live.some((file) => file === path || file.startsWith(prefix));
}

/** `/proc/<pid>/stat` wraps its command in parentheses, so field 19 (nice) is counted from after the last one. */
export function niceness(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
  } catch {
    return undefined;
  }
}

export function ageDays(path: string, now = Date.now()): number {
  return (now - statSync(path).mtimeMs) / 86_400_000;
}

/**
 * Writes a file through a temp file and a rename, so a reader never sees half of it. The temp name carries random
 * bytes as well as the pid: two PID namespaces can hold the same pid over one shared state directory, and a name
 * built from the pid alone lets one writer rename the other's temp file away.
 */
export function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Allocated bytes for a batch of paths, from one `du` walk over the whole batch. `du` charges a hardlinked inode
 * once per invocation, to the first path that holds it, so sizing each path on its own would count a file linked
 * into many worktrees once per worktree. `-B1` without `--apparent-size` reports allocated blocks, so a sparse
 * file counts for almost nothing. The batch charge is an attribution, not what deleting one path alone frees:
 * a shared inode stays on disk while another link to it does.
 *
 * `du` prints no line for an argument an earlier argument already covers, so only the outermost paths go to the
 * batch walk. A nested path is then sized on a walk of its own, so its size is its standalone size (which counts
 * inodes it shares with its parent again), never a silent 0.
 */
export async function sizes(paths: readonly string[]): Promise<Map<string, number>> {
  const result = new Map(paths.map((path) => [path, 0]));
  if (!paths.length) return result;
  const nested = (path: string, index: number) =>
    paths.some(
      (other, otherIndex) => (otherIndex < index && other === path) || (other !== path && path.startsWith(`${other}/`)),
    );
  const walk = async (batch: readonly string[]) => {
    // Size walks are the expensive part of every scan. Keep them in the idle CPU and IO classes so a diagnostic
    // run does not compete with the desktop when the machine is already overloaded.
    const du = await run(["nice", "-n", "19", "ionice", "-c", "3", "du", "-0", "-s", "-x", "-B1", "--", ...batch]);
    for (const line of du.stdout.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const path = line.slice(tab + 1);
      if (result.has(path)) result.set(path, Number.parseInt(line.slice(0, tab), 10) || 0);
    }
  };
  await walk(paths.filter((path, index) => !nested(path, index)));
  for (const [index, path] of paths.entries()) if (nested(path, index)) await walk([path]);
  return result;
}
