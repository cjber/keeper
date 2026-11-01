import { readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(argv: string[], cwd?: string): Promise<Result> {
  try {
    const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
}

export interface Paths {
  home: string;
  worktrees: string;
  paruClone: string;
  state: string;
  trash: string;
  config: string;
  units: string;
}

export function defaultPaths(home = homedir()): Paths {
  return {
    home,
    worktrees: join(home, ".worktrees"),
    paruClone: join(home, ".cache/paru/clone"),
    state: join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "keeper"),
    trash: join(home, ".local/share/keeper/trash"),
    config: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "keeper/config.toml"),
    units: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd/user"),
  };
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

export function ageDays(path: string, now = Date.now()): number {
  return (now - statSync(path).mtimeMs) / 86_400_000;
}

export async function sizes(paths: readonly string[], limit = 8): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < paths.length) {
        const path = paths[next++] as string;
        const du = await run(["du", "-sxb", path]);
        result.set(path, Number.parseInt(du.stdout, 10) || 0);
      }
    }),
  );
  return result;
}
