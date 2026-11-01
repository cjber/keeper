import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dangerous, runCli } from "./cli";
import { BusyError, withLock, writeLedger } from "./ledger";
import { applyPlan, createPlan, purge, undo } from "./ops";
import { type Context, scan, worktreeDirs } from "./scanners";
import { defaultPaths, holders, run } from "./system";
import { units } from "./timer";

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
    paths: defaultPaths(home),
    config: { agentRoots: ["~/batch"], agentCachePatterns: ["^pr\\d+-venv$"], repoRoots: [] },
    live: [],
    now: Date.now(),
    staleDays: 7,
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
  undo(ctx.paths, applied.transaction as string);
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
