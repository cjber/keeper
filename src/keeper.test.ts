import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedScan } from "./cache";
import { dangerous, health, runCli, schema } from "./cli";
import { freshen } from "./freshen";
import { BusyError, type Ledger, readLedger, updateLedger, withLock, writeLedger } from "./ledger";
import { applyPlan, bulkPlan, context, createPlan, loadConfig, purge, undo } from "./ops";
import {
  type Context,
  defaultConfig,
  dockerFindings,
  type ProcessInfo,
  type PullRequest,
  sampleMs,
  scan,
  tmpPatterns,
  worktreeDirs,
} from "./scanners";
import { defaultPaths, holders, niceness, run, waitFor } from "./system";
import { units } from "./timer";
import { eligible, type Finding } from "./types";

let home: string;
let ctx: Context;
const old = new Date(Date.now() - 30 * 86_400_000);

async function git(cwd: string, ...args: string[]) {
  const result = await run(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    cwd,
  );
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** A pushed repo plus one worktree under ~/.worktrees, all aged past every staleness window. */
async function worktree(name: string): Promise<string> {
  const remote = join(home, `${name}.git`);
  const main = join(home, `${name}-main`);
  mkdirSync(remote);
  await git(remote, "init", "-q", "--bare", "-b", "main");
  await git(home, "clone", "-q", remote, main);
  writeFileSync(join(main, "file"), "x");
  writeFileSync(join(main, ".gitignore"), "target/\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "init");
  await git(main, "push", "-q", "origin", "HEAD:main");
  const path = join(home, ".worktrees", name);
  await git(main, "worktree", "add", "-q", "-b", `b-${name}`, path);
  return path;
}

function age(path: string) {
  utimesSync(path, old, old);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-"));
  mkdirSync(join(home, ".worktrees"));
  ctx = {
    paths: defaultPaths(home, {}),
    config: { ...defaultConfig, agentRoots: ["~/batch"], agentCachePatterns: ["^pr\\d+-venv$"] },
    live: [],
    now: Date.now(),
    staleDays: 7,
    docker: async () => undefined,
  };
  ctx.paths.state = join(home, "state");
  ctx.paths.tmp = join(home, "tmp");
  mkdirSync(ctx.paths.tmp);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("worktree discovery looks through repo parent folders", () => {
  mkdirSync(join(home, ".worktrees/repo/one/.git"), { recursive: true });
  mkdirSync(join(home, ".worktrees/flat/.git"), { recursive: true });
  expect(worktreeDirs(join(home, ".worktrees")).sort()).toEqual([
    join(home, ".worktrees/flat"),
    join(home, ".worktrees/repo/one"),
  ]);
});

test("a pushed, clean, idle worktree is the only eligible one", async () => {
  const clean = await worktree("clean");
  const dirty = await worktree("dirty");
  const live = await worktree("live");
  const recent = await worktree("recent");
  writeFileSync(join(dirty, "new"), "work");
  for (const path of [clean, dirty, live]) {
    age(path);
  }
  for (const admin of ["clean", "dirty", "live"]) {
    age(join(home, `${admin}-main/.git/worktrees/${admin}/logs/HEAD`));
  }
  const report = await scan({ ...ctx, live: [join(live, "src")] }, ["worktree"]);
  const by = (path: string) => report.findings.find((finding) => finding.paths[0] === path);
  expect(by(clean)?.blockers).toEqual([]);
  expect(by(dirty)?.blockers).toContain("1 uncommitted or untracked file, commit, stash or delete it");
  expect(by(live)?.blockers.join()).toContain("running process");
  expect(by(recent)?.blockers.join()).toContain("touched");
});

test("a commit only on this machine blocks the worktree", async () => {
  const path = await worktree("ahead");
  await git(path, "commit", "-qm", "local", "--allow-empty");
  age(path);
  const report = await scan(ctx, ["worktree"]);
  expect(report.findings[0]?.blockers).toContain("1 commit on no remote, push it to keep the work");
});

test("build output is found in a dirty worktree only when ignored", async () => {
  const path = await worktree("build");
  writeFileSync(join(path, "wip"), "keep me");
  mkdirSync(join(path, "target"));
  writeFileSync(join(path, "target/out"), "bin");
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules/x"), "not ignored in this repo");
  for (const file of ["target/out", "target", "node_modules/x", "node_modules"]) age(join(path, file));
  const report = await scan(ctx, ["build"]);
  expect(report.findings.map((finding) => finding.paths[0])).toEqual([join(path, "target")]);
});

test("apply moves to trash, undo restores, and a changed finding is refused as stale", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  writeFileSync(join(batch, "out"), "data");
  age(batch);
  const { findings } = await scan(ctx, ["agent"]);
  const plan = createPlan(ctx.paths, findings, 7);
  const applied = await applyPlan(plan, ctx);
  expect(applied.applied).toHaveLength(1);
  expect(existsSync(batch)).toBe(false);
  await undo(ctx.paths, applied.transaction as string);
  expect(readFileSync(join(batch, "out"), "utf8")).toBe("data");

  writeFileSync(join(batch, "new"), "fresh");
  const stale = await applyPlan(plan, ctx);
  expect(stale.stale).toHaveLength(1);
  expect(existsSync(join(batch, "out"))).toBe(true);
});

test("apply still enforces the plan's window on findings it rescans", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  const { findings } = await scan({ ...ctx, staleDays: 0 }, ["agent"]);
  const plan = createPlan(ctx.paths, findings, 7);
  expect((await applyPlan(plan, ctx)).stale).toHaveLength(1);
  expect(existsSync(batch)).toBe(true);
});

test("a hold blocks a finding that would otherwise be ready, until it expires", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  age(batch);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  writeLedger(ctx.paths, { holds: [{ path: batch, until, reason: "resuming", actor: "a" }], claims: [] });
  expect((await scan(ctx, ["agent"])).findings[0]?.blockers.join()).toContain("held by a");
  const expired = new Date(Date.now() - 1000).toISOString();
  writeLedger(ctx.paths, { holds: [{ path: batch, until: expired, reason: "old", actor: "a" }], claims: [] });
  expect((await scan(ctx, ["agent"])).findings[0]?.blockers).toEqual([]);
});

test("a claimed path becomes a finding once stale", async () => {
  const scratch = join(home, "scratch");
  mkdirSync(scratch);
  age(scratch);
  writeLedger(ctx.paths, { holds: [], claims: [{ path: scratch, actor: "a", at: "now" }] });
  expect((await scan(ctx, ["agent"])).findings.map((finding) => finding.paths[0])).toContain(scratch);
});

test("temp names group by the pattern their random part leaves", () => {
  const groups = tmpPatterns([
    "nebula-test-home-dyqgGU",
    "nebula-test-home-wege2i",
    "nebula-test-home-qwerty",
    "uv-0f3e9a2b44.lock",
    "uv-77137c8075.lock",
    "tmpk3j9xabq",
    "tmp_o_zfjwe",
    "com.google.Chrome.yeY6kp",
    "com.google.Chrome.sEpbEr",
    "opencode",
    "fastbrowse-641-evidence",
  ]);
  expect(Object.fromEntries([...groups].map(([pattern, names]) => [pattern, names.length]))).toEqual({
    "nebula-test-home-*": 3,
    "uv-*.lock": 2,
    "tmp*": 2,
    "com.google.Chrome.*": 2,
    "*": 2,
  });
});

test("stale temp entries are one row that apply moves to trash and undo restores, leaving fresh, open and held ones", async () => {
  const tmp = ctx.paths.tmp;
  const leaked = ["leak-a1B2c3", "leak-Zz9yy8", "leak-qwerty"].map((name) => join(tmp, name)).sort();
  for (const dir of leaked) {
    mkdirSync(dir);
    writeFileSync(join(dir, "f"), "x");
    age(join(dir, "f"));
    age(dir);
  }
  const fresh = join(tmp, "leak-Fr3sh0");
  mkdirSync(fresh);
  const writing = join(tmp, "leak-Wr1te0");
  mkdirSync(writing);
  writeFileSync(join(writing, "now"), "x");
  age(writing);
  const open = join(tmp, "leak-0pen00");
  mkdirSync(open);
  age(open);
  const held = join(tmp, "leak-He1d00");
  mkdirSync(held);
  age(held);
  const locked = join(tmp, "leak-L0cked");
  mkdirSync(join(locked, "sub"), { recursive: true });
  age(join(locked, "sub"));
  age(locked);
  chmodSync(join(locked, "sub"), 0);
  writeLedger(ctx.paths, {
    holds: [{ path: held, until: "2099-01-01T00:00:00Z", reason: "r", actor: "a" }],
    claims: [],
  });
  const live = { ...ctx, live: [join(open, "socket")] };
  const { findings } = await scan(live, ["tmp"]);
  const ready = findings.filter(eligible);
  expect(ready.map((finding) => [finding.title, finding.paths, finding.inodes])).toEqual([
    [`${tmp}/leak-* (3 entries)`, leaked, 6],
  ]);
  expect(findings.find((finding) => !eligible(finding))?.paths).toEqual([open, fresh, locked, writing].sort());
  expect(findings.flatMap((finding) => finding.paths)).not.toContain(held);

  // Applied a minute later, as a person would, so the id must not depend on the clock.
  const applied = await applyPlan(createPlan(ctx.paths, ready, 7), { ...live, now: live.now + 60_000 });
  chmodSync(join(locked, "sub"), 0o755);
  expect(applied.applied).toHaveLength(1);
  expect(leaked.filter((dir) => existsSync(dir))).toEqual([]);
  await undo(ctx.paths, applied.transaction as string);
  expect(leaked.map((dir) => readFileSync(join(dir, "f"), "utf8"))).toEqual(["x", "x", "x"]);
});

test("display and session files are never offered, and a lock whose PID is alive is blocked", async () => {
  const tmp = ctx.paths.tmp;
  const display = [".X1-lock", ".X11-unix", ".ICE-unix", ".font-unix", ".XIM-unix", ".Test-unix"].map((name) =>
    join(tmp, name),
  );
  for (const path of display) {
    if (path.endsWith("-lock")) writeFileSync(path, `${String(process.pid).padStart(10)}\n`);
    else mkdirSync(path);
    age(path);
  }
  const live = join(tmp, "build.lock");
  writeFileSync(live, String(process.pid));
  age(live);
  const dead = join(tmp, "stale.lock");
  writeFileSync(dead, "999999999\n");
  age(dead);
  const { findings } = await scan(ctx, ["tmp"]);
  const paths = findings.flatMap((finding) => finding.paths);
  expect(display.filter((path) => paths.includes(path))).toEqual([]);
  expect(findings.find((finding) => finding.paths.includes(live))?.blockers.join()).toContain("alive");
  expect(findings.filter(eligible).flatMap((finding) => finding.paths)).toEqual([dead]);
});

test("claims refuse home, its parents and repositories", async () => {
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/HEAD"), "ref");
  expect(dangerous(home, home)).toBe(true);
  expect(dangerous("/", home)).toBe(true);
  expect(dangerous(repo, home)).toBe(true);
  expect(dangerous(join(home, "scratch"), home)).toBe(false);
});

test("a live lock makes a second mutation fail as busy, and a dead lock is taken over", async () => {
  mkdirSync(ctx.paths.state, { recursive: true });
  writeFileSync(join(ctx.paths.state, "lock"), String(process.pid));
  await expect(withLock(ctx.paths, async () => 1)).rejects.toBeInstanceOf(BusyError);
  writeFileSync(join(ctx.paths.state, "lock"), "999999999");
  expect(await withLock(ctx.paths, async () => 1)).toBe(1);
  expect(existsSync(join(ctx.paths.state, "lock"))).toBe(false);
});

test("a hold waits for the lock, so it cannot land in the middle of an apply", async () => {
  mkdirSync(ctx.paths.state, { recursive: true });
  writeFileSync(join(ctx.paths.state, "lock"), String(process.pid));
  const hold = { path: home, until: "2099-01-01T00:00:00Z", reason: "r", actor: "a" };
  const add = (ledger: Ledger) => ({ ...ledger, holds: [hold] });
  await expect(updateLedger(ctx.paths, add)).rejects.toBeInstanceOf(BusyError);
  expect(readLedger(ctx.paths).holds).toEqual([]);
  rmSync(join(ctx.paths.state, "lock"));
  await updateLedger(ctx.paths, add);
  expect(readLedger(ctx.paths).holds).toEqual([hold]);
});

test("purge keeps young trash and removes old trash", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  age(batch);
  const { findings } = await scan(ctx, ["agent"]);
  const { transaction } = await applyPlan(createPlan(ctx.paths, findings, 7), ctx);
  expect((await purge(ctx.paths, 14)).purged).toEqual([]);
  expect((await purge(ctx.paths, 0, Date.now() + 1000)).purged).toEqual([transaction as string]);
  expect(existsSync(join(ctx.paths.trash, transaction as string))).toBe(false);
});

test("waitFor returns on time from a command that ignores SIGTERM, as a stuck sync does", async () => {
  const started = Date.now();
  expect(await waitFor(["sh", "-c", "trap '' TERM; sleep 3"], 200)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await waitFor(["true"], 1000)).toBe(true);
});

test("holders matches the path and children but not a sibling prefix", () => {
  expect(holders("/a/b", ["/a/b/c"])).toBe(true);
  expect(holders("/a/b", ["/a/b"])).toBe(true);
  expect(holders("/a/b", ["/a/bc"])).toBe(false);
});

test("the unit quotes systemd specials and logs to a file", () => {
  const unit = units(["/bin/keeper"], ctx.paths, "/a%b")["keeper.service"] as string;
  expect(unit).toContain('"PATH=/a%%b"');
  expect(unit).toContain(`append:${ctx.paths.state}/keeper.log`);
  expect(unit).toContain('"/bin/keeper" "auto"');
});

test("free space readings get their own hourly unit, apart from the nightly run", () => {
  const all = units(["/bin/keeper"], ctx.paths, "/usr/bin");
  expect(all["keeper-sample.timer"]).toContain("OnCalendar=hourly");
  expect(all["keeper-sample.service"]).toContain('"/bin/keeper" "sample"');
});

test("the wizard refuses to open without a terminal", async () => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "index.tsx")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(2);
  expect(JSON.parse(await new Response(child.stderr).text()).error.code).toBe("usage");
});

test("runCli rejects unknown options", async () => {
  expect(await runCli(["scan", "--nope"])).toBe(2);
});

const uid = process.getuid?.() ?? 0;

function proc(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 10,
    ppid: 1,
    uid,
    nice: 0,
    cpu: 120,
    age: 600,
    command: "cargo build --release",
    ...overrides,
    cpuSeconds: overrides.cpuSeconds ?? ((overrides.cpu ?? 120) / 100) * (overrides.age ?? 600),
  };
}

test("load groups split by process tree, so one project's bun is never reniced with another's", async () => {
  const tmux = proc({ pid: 100, cpu: 0, command: "tmux new -s work" });
  const paneA = proc({ pid: 101, ppid: 100, cpu: 0, command: "zsh" });
  const paneB = proc({ pid: 102, ppid: 100, cpu: 0, command: "zsh" });
  const tests = proc({ pid: 110, ppid: 101, cpu: 90, command: "bun test HomeConversation.test.tsx" });
  const worker = proc({ pid: 111, ppid: 110, cpu: 60, command: "bun test --worker" });
  const server = proc({ pid: 120, ppid: 102, cpu: 80, command: "bun /other/src/index.tsx" });
  const { findings } = await scan(
    { ...ctx, processes: [tmux, paneA, paneB, tests, worker, server], cores: 2, loadAverage: 9 },
    ["load"],
  );
  expect(findings.map((finding) => finding.pids).sort()).toEqual([[110, 111], [120]]);
  expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
});

test("a build whose workers are all young is still named once they have used real CPU", async () => {
  const daemons = [115, 80, 70].map((cpu, i) =>
    proc({ pid: 200 + i, ppid: 1, cpu, age: 229, command: `/usr/lib/jvm/bin/java -cp worker${i}.jar` }),
  );
  const { findings } = await scan({ ...ctx, processes: daemons, cores: 2, loadAverage: 9 }, ["load"]);
  expect(findings.map((finding) => finding.cpu).sort()).toEqual([115, 70, 80]);
});

test("kernel threads are never load findings, and the session that ran keeper is never reniced", async () => {
  const kernel = [
    proc({ pid: 2, ppid: 0, uid: 0, command: "[kthreadd]" }),
    proc({ pid: 300, ppid: 2, uid: 0, command: "[kswapd0]" }),
    proc({ pid: 301, ppid: 2, uid: 0, command: "[kworker/8:2-events]" }),
  ];
  const caller = proc({ pid: process.ppid, ppid: 1, command: "claude --remote-control" });
  const { findings } = await scan({ ...ctx, processes: [...kernel, caller], cores: 2, loadAverage: 9 }, ["load"]);
  expect(findings.map((finding) => finding.pids)).toEqual([[process.ppid]]);
  expect(findings[0]?.blockers.join()).toContain("the session that started it");
});

test("load is sampled for a full second, and --cached says load is always scanned now", async () => {
  expect(sampleMs).toBeGreaterThanOrEqual(1000);
  const hot = { ...ctx, processes: [proc()], cores: 2, loadAverage: 9 };
  const report = await cachedScan(hot, { reuse: true, only: ["load", "tmp"] });
  expect(report.live).toEqual(["load"]);
  expect((await cachedScan(hot, { reuse: false, only: ["load"] })).live).toEqual([]);
});

test("a flag the command does not take is refused rather than dropped", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli(["claim", "/", "--reason", "dogfood"])).toBe(2);
    expect(String(errors.mock.calls[0]?.[0])).toContain("claim does not take --reason");
    expect(await runCli(["scan", "--days", "3"])).toBe(2);
  } finally {
    errors.mockRestore();
  }
});

test("load findings appear only on an oversubscribed machine, grouped by command", async () => {
  const group = [proc(), proc({ pid: 11, ppid: 10, cpu: 30 })];
  const busy = await scan({ ...ctx, processes: group, cores: 4, loadAverage: 12 }, ["load"]);
  expect(busy.findings).toHaveLength(1);
  expect(busy.findings[0]).toMatchObject({ category: "load", action: "renice", risk: "medium", cpu: 150 });
  expect(busy.findings[0]?.pids).toEqual([10, 11]);
  expect(busy.findings[0]?.blockers).toEqual([]);

  // Load 2 on 4 cores is a machine doing its job, so there is nothing to report.
  const idle = await scan({ ...ctx, processes: group, cores: 4, loadAverage: 2 }, ["load"]);
  expect(idle.findings).toEqual([]);
});

test("a burst too short to matter and a command already at the bottom are not eligible", async () => {
  const young = await scan({ ...ctx, processes: [proc({ age: 60 })], cores: 2, loadAverage: 9 }, ["load"]);
  expect(young.findings).toEqual([]);

  const lowered = await scan({ ...ctx, processes: [proc({ nice: 19 })], cores: 2, loadAverage: 9 }, ["load"]);
  expect(lowered.findings[0]?.blockers.join()).toContain("already at the bottom priority");
});

test("the desktop session is never reniced, because it is what has to stay responsive", async () => {
  const session = await scan(
    { ...ctx, processes: [proc({ command: "/usr/bin/kitty --single-instance", cpu: 90 })], cores: 2, loadAverage: 9 },
    ["load"],
  );
  expect(session.findings[0]?.blockers.join()).toContain("desktop session");
});

test("memory findings name the cgroup pinned at its cap, and can never be planned", async () => {
  const pinned = {
    path: "/sys/fs/cgroup/user.slice/agent-session-1.scope",
    current: 3.2 * 1024 ** 3,
    high: 3 * 1024 ** 3,
    commands: ["cargo build --release"],
  };
  const { findings } = await scan({ ...ctx, pressure: { some: 80, full: 60 }, cgroups: [pinned] }, ["memory"]);
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  expect(finding).toMatchObject({ category: "memory", action: "report" });
  expect(finding?.title).toContain("agent-session-1");
  expect(finding && eligible(finding)).toBe(false);
});

test("memory pressure with no pinned cgroup is still reported, and a healthy machine stays silent", async () => {
  const stalled = await scan({ ...ctx, pressure: { some: 50, full: 20 }, cgroups: [] }, ["memory"]);
  expect(stalled.findings).toHaveLength(1);
  expect(stalled.findings[0]?.title).toContain("memory pressure");

  const healthy = await scan({ ...ctx, pressure: { some: 2, full: 0 }, cgroups: [] }, ["memory"]);
  expect(healthy.findings).toEqual([]);
});

test("applying a load plan lowers the priority and undo puts it back", async () => {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const hot: Context = {
      ...ctx,
      processes: [proc({ pid: child.pid, cpu: 300, command: "sleep 30" })],
      cores: 2,
      loadAverage: 8,
    };
    const { findings } = await scan(hot, ["load"]);
    // The child inherits the test's own nice, which a reniced shell has already raised.
    const start = niceness(child.pid);
    expect(start).toBeLessThan(19);

    const applied = await applyPlan(createPlan(ctx.paths, findings, 7), hot);
    expect(applied.reniced).toBe(1);
    expect(niceness(child.pid)).toBe(19);

    const restored = await undo(ctx.paths, applied.transaction as string);
    // Raising a nice value back needs root, so the honest contract is that it is either restored or reported.
    expect(restored.reniced + restored.stuck.length).toBe(1);
    expect(niceness(child.pid)).toBe(restored.reniced ? start : 19);
  } finally {
    child.kill();
  }
});

test("an orphan whose terminal is gone is stopped, not reniced, even on a quiet machine", async () => {
  const hours = 4 * 3600;
  const tui = proc({ pid: 500, cpu: 88, age: hours, command: "bun /src/index.tsx", stdin: "/dev/pts/7 (deleted)" });
  const daemon = proc({ pid: 501, cpu: 88, age: hours, command: "/usr/bin/syncthing", stdin: "/dev/null" });
  const live = proc({ pid: 502, ppid: 400, cpu: 88, age: hours, command: "htop", stdin: "/dev/pts/8" });
  for (const loadAverage of [9, 0.5]) {
    const { findings } = await scan({ ...ctx, processes: [tui, daemon, live], cores: 2, loadAverage }, ["load"]);
    const stop = findings.filter((finding) => finding.action === "stop");
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatchObject({ category: "load", risk: "medium", explicit: true, pids: [500], blockers: [] });
    expect(findings.some((finding) => finding.action === "renice" && finding.pids?.includes(500))).toBe(false);
  }
  // A dead terminal alone is not enough: a short burst is left to finish.
  const young = await scan({ ...ctx, processes: [{ ...tui, age: 120 }], cores: 2, loadAverage: 0.5 }, ["load"]);
  expect(young.findings).toEqual([]);
});

test("applying a stop finding ends the process", async () => {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const hot: Context = {
    ...ctx,
    processes: [proc({ pid: child.pid, cpu: 90, age: 7200, command: "sleep 30", stdin: "/dev/pts/9 (deleted)" })],
    cores: 2,
    loadAverage: 0.5,
  };
  const { findings } = await scan(hot, ["load"]);
  const stop = findings.filter((finding) => finding.action === "stop");
  const applied = await applyPlan(createPlan(ctx.paths, stop, 7), hot);
  expect(applied.stopped).toBe(1);
  expect(await Promise.race([child.exited.then(() => "exited"), Bun.sleep(2000).then(() => "running")])).toBe("exited");
});

test("with autogroup on, renice lowers each session's autogroup but never the desktop's", async () => {
  const desktop = proc({ pid: 50, cpu: 5, command: "Hyprland", autogroup: "/autogroup-78" });
  const sharing = proc({ pid: 60, cpu: 120, command: "cargo build", autogroup: "/autogroup-78" });
  const own = proc({ pid: 70, cpu: 120, command: "bun test", autogroup: "/autogroup-90" });
  const own2 = proc({ pid: 71, ppid: 70, cpu: 60, command: "bun test --worker", autogroup: "/autogroup-90" });
  const processes = [desktop, sharing, own, own2];
  const on = await scan({ ...ctx, processes, cores: 2, loadAverage: 9, autogroup: true }, ["load"]);
  const byPid = (pid: number) => on.findings.find((finding) => finding.pids?.includes(pid));
  expect(byPid(70)?.autogroups).toEqual([70]);
  expect(byPid(60)?.autogroups).toBeUndefined();
  const off = await scan({ ...ctx, processes, cores: 2, loadAverage: 9, autogroup: false }, ["load"]);
  expect(off.findings.every((finding) => finding.autogroups === undefined)).toBe(true);
});

const autogroupOf = (pid: number) => {
  try {
    const [name, , nice] = readFileSync(`/proc/${pid}/autogroup`, "utf8").trim().split(" ");
    return { name: name as string, nice: Number(nice) };
  } catch {
    return undefined;
  }
};

test.skipIf(!autogroupOf(process.pid))("applying a load plan lowers the autogroup and undo puts it back", async () => {
  // setsid gives the child a session, and so an autogroup, of its own.
  const child = Bun.spawn(["setsid", "sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 40 && autogroupOf(child.pid)?.name === autogroupOf(process.pid)?.name; i++) await Bun.sleep(50);
    const hot: Context = {
      ...ctx,
      processes: [proc({ pid: child.pid, cpu: 300, command: "sleep 30", autogroup: autogroupOf(child.pid)?.name })],
      cores: 2,
      loadAverage: 8,
      autogroup: true,
    };
    const { findings } = await scan(hot, ["load"]);
    const applied = await applyPlan(createPlan(ctx.paths, findings, 7), hot);
    expect(autogroupOf(child.pid)?.nice).toBe(19);
    await undo(ctx.paths, applied.transaction as string);
    expect(autogroupOf(child.pid)?.nice).toBe(0);
  } finally {
    child.kill();
  }
});

function pull(state: PullRequest["state"], head: string, name: string): () => Promise<PullRequest[]> {
  return async () => [{ number: 7, state, headRefName: name, headRefOid: head }];
}

test("a merged PR for this exact commit proves a recent worktree done", async () => {
  const path = await worktree("merged");
  const head = await git(path, "rev-parse", "HEAD");
  const report = await scan({ ...ctx, pullRequests: pull("MERGED", head, "b-merged") }, ["worktree"]);
  expect(report.findings[0]).toMatchObject({ risk: "low", blockers: [] });
  expect(report.findings[0]?.reason).toContain("PR #7");
});

test("a worktree removed mid-scan drops out without hiding the others", async () => {
  const kept = await worktree("kept");
  const gone = await worktree("gone");
  const report = await scan(
    {
      ...ctx,
      pullRequests: async (path) => {
        if (path === gone) rmSync(gone, { recursive: true, force: true });
        return [];
      },
    },
    ["worktree"],
  );
  expect(report.warnings).toEqual([]);
  expect(report.findings.map((finding) => finding.paths[0])).toEqual([kept]);
});

test("a squash-merged branch deleted from the remote is still proven by its PR", async () => {
  const path = await worktree("squashed");
  await git(path, "commit", "-qm", "work", "--allow-empty");
  const head = await git(path, "rev-parse", "HEAD");
  const unproven = await scan(ctx, ["worktree"]);
  expect(unproven.findings[0]?.blockers.join()).toContain("on no remote");
  const report = await scan({ ...ctx, pullRequests: pull("MERGED", head, "b-squashed") }, ["worktree"]);
  expect(report.findings[0]).toMatchObject({ risk: "low", blockers: [] });
});

test("a branch behind its merged PR's head is proven, but one just cut from main is not", async () => {
  const path = await worktree("behind");
  await git(path, "commit", "-qm", "first", "--allow-empty");
  const local = await git(path, "rev-parse", "HEAD");
  // The PR gained a commit pushed from elsewhere, which this checkout fetched but never moved to.
  await git(path, "commit", "-qm", "second", "--allow-empty");
  const prHead = await git(path, "rev-parse", "HEAD");
  await git(path, "reset", "-q", "--hard", local);
  const report = await scan({ ...ctx, pullRequests: pull("MERGED", prHead, "b-behind") }, ["worktree"]);
  expect(report.findings[0]).toMatchObject({ risk: "low", blockers: [] });
  const fresh = await worktree("fresh");
  const main = await git(fresh, "rev-parse", "HEAD");
  await git(fresh, "commit", "-qm", "old work", "--allow-empty");
  const oldHead = await git(fresh, "rev-parse", "HEAD");
  await git(fresh, "reset", "-q", "--hard", main);
  const reused = await scan({ ...ctx, pullRequests: pull("MERGED", oldHead, "b-fresh") }, ["worktree"]);
  expect(reused.findings.find((finding) => finding.paths[0] === fresh)?.blockers.join()).toContain("touched");
});

test("a squash-merged PR that a bot rebased is proven by content, and extra local work is not", async () => {
  const path = await worktree("rebased");
  const main = join(home, "rebased-main");
  writeFileSync(join(path, "file"), "work");
  writeFileSync(join(path, "added"), "new");
  await git(path, "add", ".");
  await git(path, "commit", "-qm", "work");
  // Main moved on, the bot rebased the branch onto it, and the squash merge landed the branch's files.
  writeFileSync(join(main, "unrelated"), "main moved");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "main moved");
  writeFileSync(join(main, "file"), "work");
  writeFileSync(join(main, "added"), "new");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "squash");
  const squash = await git(main, "rev-parse", "HEAD");
  // A later change on main to a file the branch touched does not undo the proof.
  writeFileSync(join(main, "added"), "edited later");
  await git(main, "commit", "-qam", "later");
  await git(main, "push", "-q", "origin", "HEAD:main");
  const merged = async (): Promise<PullRequest[]> => [
    { number: 7, state: "MERGED", headRefName: "b-rebased", headRefOid: "1".repeat(40), mergeCommit: { oid: squash } },
  ];
  const report = await scan({ ...ctx, pullRequests: merged }, ["worktree"]);
  expect(report.findings[0]).toMatchObject({ risk: "low", blockers: [] });
  expect(report.findings[0]?.reason).toContain("PR #7");

  writeFileSync(join(path, "extra"), "unmerged");
  await git(path, "add", ".");
  await git(path, "commit", "-qm", "more");
  const extra = await scan({ ...ctx, pullRequests: merged }, ["worktree"]);
  expect(extra.findings[0]?.risk).toBe("medium");
  expect(extra.findings[0]?.blockers.join()).toContain("on no remote");
});

test("a branch older than the newest page of PRs is looked up by name", async () => {
  const path = await worktree("old");
  const head = await git(path, "rev-parse", "HEAD");
  const page = Array.from({ length: 1000 }, (_, i) => ({
    number: i + 2000,
    state: "OPEN" as const,
    headRefName: `other-${i}`,
    headRefOid: "x",
  }));
  const asked: (string | undefined)[] = [];
  const report = await scan(
    {
      ...ctx,
      pullRequests: async (_repo, branch) => {
        asked.push(branch);
        return branch ? [{ number: 7, state: "MERGED", headRefName: branch, headRefOid: head }] : page;
      },
    },
    ["worktree"],
  );
  expect(asked).toEqual([undefined, "b-old"]);
  expect(report.findings[0]?.reason).toContain("PR #7");
});

test("a reused branch name is not proof, because the commit differs", async () => {
  await worktree("reused");
  const report = await scan({ ...ctx, pullRequests: pull("MERGED", "0".repeat(40), "b-reused") }, ["worktree"]);
  expect(report.findings[0]?.risk).toBe("medium");
  expect(report.findings[0]?.blockers.join()).toContain("touched");
});

test("an open PR blocks the worktree", async () => {
  const path = await worktree("open");
  age(path);
  age(join(home, "open-main/.git/worktrees/open/logs/HEAD"));
  const report = await scan({ ...ctx, pullRequests: pull("OPEN", "x", "b-open") }, ["worktree"]);
  expect(report.findings[0]?.blockers).toEqual(["PR #7 is open, merge or close it"]);
});

test("a new branch cut from main keeps the age window, and only an idle one is low risk", async () => {
  const path = await worktree("fresh");
  await git(join(home, "fresh-main"), "remote", "set-head", "origin", "main");
  const fresh = (await scan(ctx, ["worktree"])).findings[0];
  expect(fresh?.blockers.join()).toContain("touched");
  age(path);
  age(join(home, "fresh-main/.git/worktrees/fresh/logs/HEAD"));
  const idle = (await scan(ctx, ["worktree"])).findings[0];
  expect(idle).toMatchObject({ risk: "low", blockers: [] });
});

test("a rebase in progress blocks a clean, pushed worktree", async () => {
  const path = await worktree("rebasing");
  mkdirSync(join(home, "rebasing-main/.git/worktrees/rebasing/rebase-merge"));
  age(path);
  age(join(home, "rebasing-main/.git/worktrees/rebasing/logs/HEAD"));
  const report = await scan(ctx, ["worktree"]);
  expect(report.findings[0]?.blockers).toEqual(["rebase-merge is in progress, finish or abort it"]);
});

test("a stray directory is a finding, unless a checkout sits inside it", async () => {
  mkdirSync(join(home, ".worktrees/repo/stray"), { recursive: true });
  mkdirSync(join(home, ".worktrees/repo/cb/feature/.git"), { recursive: true });
  const stray = join(home, ".worktrees/repo/stray");
  age(stray);
  age(join(home, ".worktrees/repo/cb"));
  age(join(home, ".worktrees/repo/cb/feature"));
  const { findings } = await scan(ctx, ["worktree"]);
  const by = (name: string) => findings.find((finding) => finding.paths[0]?.endsWith(name));
  expect(by("stray")).toMatchObject({ risk: "medium", blockers: [] });
  expect(by("repo/cb")?.blockers).toContain("contains a checkout");
});

test("purge deletes a worktree's branch only if it has not moved, and undo works until then", async () => {
  const path = await worktree("gone");
  await worktree("moved");
  const merged = async (repo: string, branch: string) => pull("MERGED", await git(repo, "rev-parse", "HEAD"), branch)();
  const prs = async (repo: string) => (repo.endsWith("gone") ? merged(repo, "b-gone") : merged(repo, "b-moved"));
  const live = { ...ctx, pullRequests: prs };
  const { findings } = await scan(live, ["worktree"]);
  await applyPlan(createPlan(ctx.paths, findings, 7), live);
  expect(existsSync(path)).toBe(false);
  expect(await git(join(home, "gone-main"), "branch", "--list", "b-gone")).toContain("b-gone");

  const movedMain = join(home, "moved-main");
  await git(movedMain, "commit", "-qm", "later", "--allow-empty");
  await git(movedMain, "update-ref", "refs/heads/b-moved", "HEAD");

  await purge(ctx.paths, 0);
  expect(await git(join(home, "gone-main"), "branch", "--list", "b-gone")).toBe("");
  expect(await git(movedMain, "branch", "--list", "b-moved")).toContain("b-moved");
});

test("purge reports measured free space separately from uncompressed size", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  writeFileSync(join(batch, "out"), "data");
  age(batch);
  const { findings } = await scan(ctx, ["agent"]);
  await applyPlan(createPlan(ctx.paths, findings, 7), ctx);
  const result = await purge(ctx.paths, 0);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.freed).toBeGreaterThanOrEqual(0);
});

test("a failing purge hook keeps the transaction so it can retry", async () => {
  const path = await worktree("hooked");
  const hook = join(home, "hook.sh");
  const seen = join(home, "seen");
  writeFileSync(hook, `#!/bin/sh\ntest -f "$1/file" && echo "$2" >> ${seen}\nexit "$(cat ${home}/code)"\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(home, "code"), "1");
  mkdirSync(join(home, ".config/keeper"), { recursive: true });
  writeFileSync(ctx.paths.config, `purgeHook = "${hook}"\n`);
  age(path);
  age(join(home, "hooked-main/.git/worktrees/hooked/logs/HEAD"));
  const { findings } = await scan(ctx, ["worktree"]);
  const { transaction } = await applyPlan(createPlan(ctx.paths, findings, 7), ctx);
  expect(await purge(ctx.paths, 0)).toMatchObject({ purged: [], failed: [transaction] });
  writeFileSync(join(home, "code"), "0");
  expect(await purge(ctx.paths, 0)).toMatchObject({ purged: [transaction], failed: [] });
  expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([path, path]);
});

test("a recent file deep in build output blocks it, though everything near the top is old", async () => {
  const path = await worktree("deep");
  mkdirSync(join(path, "target/debug/deps"), { recursive: true });
  writeFileSync(join(path, "target/debug/deps/lib"), "new");
  for (const dir of ["target/debug/deps", "target/debug", "target"]) age(join(path, dir));
  const recent = (await scan(ctx, ["build"])).findings;
  expect(recent.map((finding) => finding.blockers)).toEqual([["built in the last 3 days, offered after 3 idle days"]]);
  age(join(path, "target/debug/deps/lib"));
  expect((await scan(ctx, ["build"])).findings.map((finding) => finding.blockers)).toEqual([[]]);
});

test("an oversized log keeps its tail and its inode", async () => {
  const log = join(home, "app.log");
  writeFileSync(log, Buffer.alloc(51 * 1024 ** 2, 97));
  const inode = statSync(log).ino;
  const live = { ...ctx, config: { ...ctx.config, logs: ["~/app.log", "~/absent.log"] } };
  const { findings } = await scan(live, ["logs"]);
  expect(findings).toHaveLength(1);
  await applyPlan(createPlan(ctx.paths, findings, 7), live);
  expect(statSync(log).size).toBe(5 * 1024 ** 2);
  expect(statSync(log).ino).toBe(inode);
});

test("undo refuses to overwrite a path that exists again, then finishes once it is clear", async () => {
  const batch = join(home, "batch");
  mkdirSync(batch);
  age(batch);
  const { findings } = await scan(ctx, ["agent"]);
  const { transaction } = await applyPlan(createPlan(ctx.paths, findings, 7), ctx);
  mkdirSync(batch);
  await expect(undo(ctx.paths, transaction as string)).rejects.toThrow("exist again");
  rmSync(batch, { recursive: true });
  expect((await undo(ctx.paths, transaction as string)).restored).toEqual([batch]);
});

test("a theme sets only the colours it names, and a misspelt one is an error", () => {
  mkdirSync(join(home, ".config/keeper"), { recursive: true });
  writeFileSync(ctx.paths.config, '[theme]\ncursor = "#333333"\n');
  expect(loadConfig(ctx.paths).theme).toMatchObject({ cursor: "#333333", accent: "cyan", blocked: "" });
  writeFileSync(ctx.paths.config, '[theme]\ncursour = "#333333"\n');
  expect(() => loadConfig(ctx.paths)).toThrow("theme.cursour");
});

test("a misspelt config key is an error, and configured roots replace the defaults", () => {
  mkdirSync(join(home, ".config/keeper"), { recursive: true });
  writeFileSync(ctx.paths.config, 'worktreeRoot = ["~/w"]\n');
  expect(() => loadConfig(ctx.paths)).toThrow("unknown keys");
  writeFileSync(ctx.paths.config, 'worktreeRoots = ["~/w"]\naurClones = ["/opt/aur"]\n');
  const { paths } = context(7, 90, ctx.paths);
  expect(paths.worktrees).toEqual([join(home, "w")]);
  expect(paths.aurClones).toEqual(["/opt/aur"]);
});

test("emptied transcript folders go too, and everything else stays", async () => {
  const session = join(home, ".claude/projects/p/s");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(home, ".claude/projects/keep"), "x");
  writeFileSync(join(session, "t.jsonl"), "x");
  writeFileSync(join(home, ".claude/projects/keep2"), "x");
  age(join(session, "t.jsonl"));
  const { findings } = await scan(ctx, ["transcripts"]);
  await applyPlan(createPlan(ctx.paths, findings, 7), ctx);
  expect(existsSync(join(home, ".claude/projects/p"))).toBe(false);
  expect(existsSync(join(home, ".claude/projects/keep"))).toBe(true);
});

async function behindCheckout(name: string): Promise<{ main: string; other: string }> {
  await worktree(name);
  const main = join(home, `${name}-main`);
  await git(main, "remote", "set-head", "origin", "main");
  const other = join(home, `${name}-other`);
  await git(home, "clone", "-q", join(home, `${name}.git`), other);
  await git(other, "commit", "-qm", "upstream", "--allow-empty");
  await git(other, "push", "-q", "origin", "HEAD:main");
  return { main, other };
}

test("freshen fast-forwards a clean checkout and returns it from a pushed branch", async () => {
  const { main } = await behindCheckout("ff");
  await git(main, "checkout", "-q", "-b", "side");
  await git(main, "push", "-q", "-u", "origin", "side");
  expect(await freshen(main)).toContain("fast-forwarded 1");
  expect(await git(main, "branch", "--show-current")).toBe("main");
  expect(await git(main, "rev-parse", "HEAD")).toBe(await git(main, "rev-parse", "origin/main"));
});

test("freshen leaves modified files and unpushed commits alone", async () => {
  const { main } = await behindCheckout("guarded");
  writeFileSync(join(main, "file"), "changed");
  await freshen(main);
  expect(await git(main, "rev-parse", "HEAD")).not.toBe(await git(main, "rev-parse", "origin/main"));
  await git(main, "checkout", "--", "file");
  await git(main, "checkout", "-q", "-b", "local");
  await git(main, "commit", "-qm", "only here", "--allow-empty");
  await freshen(main);
  expect(await git(main, "branch", "--show-current")).toBe("local");
});

test("every keeper command the docs name exists in the CLI", async () => {
  const help = schema().help;
  for (const file of ["README.md", "skills/keeper/SKILL.md"]) {
    const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
    for (const [, command] of text.matchAll(/`keeper ([a-z]+)/g)) expect(help).toContain(`keeper ${command}`);
  }
});

test("package caches: prunable ones always offered, cleared-whole ones only once large", async () => {
  mkdirSync(join(home, ".npm/_cacache"), { recursive: true });
  // du -b counts apparent size, so a sparse file stands in for gigabytes of downloads.
  writeFileSync(join(home, ".npm/_cacache/blob"), "");
  truncateSync(join(home, ".npm/_cacache/blob"), 3 * 1024 ** 3);
  mkdirSync(join(home, ".bun/install/cache"), { recursive: true });
  writeFileSync(join(home, ".bun/install/cache/small"), "x");
  mkdirSync(join(home, ".local/share/pnpm/store"), { recursive: true });
  const { findings } = await scan(ctx, ["package-cache"]);
  const byTitle = Object.fromEntries(findings.map((finding) => [finding.title, finding]));
  expect(byTitle["npm cache"]).toMatchObject({ action: "npm-clean", bytes: 3 * 1024 ** 3, risk: "low" });
  expect(byTitle["pnpm cache"]).toMatchObject({ action: "pnpm-prune", bytes: 0 });
  expect(byTitle["bun cache"]).toBeUndefined();
});

test("docker: dangling images and build cache are prunable, unused volumes are only reported", () => {
  const volume = (name: string, links: string, project?: string) => ({
    Name: name,
    Links: links,
    Size: "1.5GB",
    Labels: project ? `com.docker.compose.project=${project},com.docker.compose.volume=db` : "",
  });
  const findings = dockerFindings(
    {
      Images: [
        { Repository: "<none>", Containers: "0", Size: "200MB" },
        { Repository: "postgres", Containers: "1", Size: "400MB" },
      ],
      Volumes: [volume("a_db", "0", "app-wt1"), volume("b_db", "0", "app-wt2"), volume("live", "1", "app")],
    },
    2e9,
  );
  expect(findings.map((finding) => [finding.action, finding.risk])).toEqual([
    ["docker-image-prune", "low"],
    ["docker-builder-prune", "low"],
    ["report", "high"],
  ]);
  expect(findings[0]?.bytes).toBe(200e6);
  expect(findings[2]).toMatchObject({ title: "2 unused docker volumes", bytes: 3e9 });
  expect(findings[2]?.reason).toContain("app-wt1, app-wt2");
  expect(dockerFindings({ Images: null, Volumes: null }, 0)).toEqual([]);
});

test("health names each reason the nightly runs cannot be trusted, and nothing when they can", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const run = { at: "2026-11-10T00:30:00Z", summary: "ok" };
  expect(health("systemd", run, "success", now)).toEqual([]);
  expect(health("none", run, undefined, now)).toEqual(["no schedule, so nothing runs nightly"]);
  expect(health("systemd", undefined, undefined, now)).toEqual(["no nightly run recorded yet"]);
  expect(health("systemd", { ...run, at: "2026-11-08T00:30:00Z" }, "success", now)).toEqual([
    "the last nightly run was 59 hours ago",
  ]);
  expect(health("systemd", { ...run, incomplete: true, warnings: ["docker: down"] }, "exit-code", now)).toEqual([
    "the last nightly run ended in exit-code",
    "the last nightly run could not apply or purge everything",
    "the last nightly scan warned: docker: down",
  ]);
});

test("a plan counts a worktree's own build output once, inside the worktree", () => {
  const finding = (id: string, path: string, bytes: number): Finding => ({
    id,
    category: id === "tree" ? "worktree" : "build",
    title: id,
    paths: [path],
    packages: [],
    bytes,
    risk: "low",
    action: "trash",
    reason: "",
    blockers: [],
  });
  const tree = finding("tree", "/w/feature", 4);
  const output = finding("output", "/w/feature/node_modules", 3);
  const sibling = finding("sibling", "/w/feature-two", 1);
  const plan = createPlan(ctx.paths, [output, tree, sibling], 7);
  expect(plan.findingIds).toEqual(["tree", "sibling"]);
  expect(plan.bytes).toBe(5);
});

test("a bulk plan never takes apps or personal files, whatever the risk ceiling", () => {
  const finding = (id: string, category: Finding["category"], risk: Finding["risk"]): Finding => ({
    id,
    category,
    title: id,
    paths: [`/${id}`],
    packages: [],
    bytes: 1,
    risk,
    action: category === "apps" ? "remove-packages" : "trash",
    reason: "",
    blockers: [],
    ...(category === "apps" || category === "large" || category === "duplicates" ? { explicit: true as const } : {}),
  });
  const chosen = bulkPlan(
    [
      finding("orphan", "orphans", "medium"),
      finding("app", "apps", "medium"),
      finding("large", "large", "low"),
      finding("duplicate", "duplicates", "medium"),
      finding("low", "agent", "low"),
    ],
    "medium",
  );
  expect(chosen.map((item) => item.id)).toEqual(["orphan", "low"]);
  expect(schema().explicit).toContain("keeper plan");
});
