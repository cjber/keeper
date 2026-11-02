import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { dangerous, runCli, schema } from "./cli";
import { freshen } from "./freshen";
import { BusyError, withLock, writeLedger } from "./ledger";
import { applyPlan, context, createPlan, loadConfig, purge, undo } from "./ops";
import {
  type Context,
  defaultConfig,
  dockerFindings,
  type ProcessInfo,
  type PullRequest,
  scan,
  worktreeDirs,
} from "./scanners";
import { defaultPaths, holders, niceness, run } from "./system";
import { units } from "./timer";
import { eligible } from "./types";

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
  expect(by(dirty)?.blockers.join()).toContain("uncommitted");
  expect(by(live)?.blockers.join()).toContain("running process");
  expect(by(recent)?.blockers.join()).toContain("touched");
});

test("a commit only on this machine blocks the worktree", async () => {
  const path = await worktree("ahead");
  await git(path, "commit", "-qm", "local", "--allow-empty");
  age(path);
  const report = await scan(ctx, ["worktree"]);
  expect(report.findings[0]?.blockers.join()).toContain("commits on no remote");
});

test("build output is found in a dirty worktree only when ignored and stale", async () => {
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
  };
}

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
    expect(niceness(child.pid)).toBe(0);

    const applied = await applyPlan(createPlan(ctx.paths, findings, 7), hot);
    expect(applied.reniced).toBe(1);
    expect(niceness(child.pid)).toBe(19);

    const restored = await undo(ctx.paths, applied.transaction as string);
    // Raising a nice value back needs root, so the honest contract is that it is either restored or reported.
    expect(restored.reniced + restored.stuck.length).toBe(1);
    expect(niceness(child.pid)).toBe(restored.reniced ? 0 : 19);
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
  expect(unproven.findings[0]?.blockers.join()).toContain("commits on no remote");
  const report = await scan({ ...ctx, pullRequests: pull("MERGED", head, "b-squashed") }, ["worktree"]);
  expect(report.findings[0]).toMatchObject({ risk: "low", blockers: [] });
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
  expect(report.findings[0]?.blockers).toEqual(["PR #7 is open"]);
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
  expect(report.findings[0]?.blockers).toEqual(["rebase-merge is in progress"]);
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

test("a recent file deep in build output keeps it, though everything near the top is old", async () => {
  const path = await worktree("deep");
  mkdirSync(join(path, "target/debug/deps"), { recursive: true });
  writeFileSync(join(path, "target/debug/deps/lib"), "new");
  for (const dir of ["target/debug/deps", "target/debug", "target"]) age(join(path, dir));
  expect((await scan(ctx, ["build"])).findings).toEqual([]);
  age(join(path, "target/debug/deps/lib"));
  expect((await scan(ctx, ["build"])).findings).toHaveLength(1);
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
  expect(loadConfig(ctx.paths).theme).toMatchObject({ cursor: "#333333", accent: "" });
  writeFileSync(ctx.paths.config, '[theme]\ncursour = "#333333"\n');
  expect(() => loadConfig(ctx.paths)).toThrow("theme.cursour");
});

test("a misspelt config key is an error, and configured roots replace the defaults", () => {
  mkdirSync(join(home, ".config/keeper"), { recursive: true });
  writeFileSync(ctx.paths.config, 'worktreeRoot = ["~/w"]\n');
  expect(() => loadConfig(ctx.paths)).toThrow("unknown keys");
  writeFileSync(ctx.paths.config, 'worktreeRoots = ["~/w"]\naurClones = ["/opt/aur"]\n');
  const { paths } = context(7, ctx.paths);
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
