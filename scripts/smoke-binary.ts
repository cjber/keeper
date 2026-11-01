/** Runs the compiled binary outside the checkout, with a scratch home, through what a new user does first. */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("usage: bun scripts/smoke-binary.ts <binary>");
const scratch = mkdtempSync(join(tmpdir(), "keeper-binary-"));
const executable = join(scratch, "installed keeper");
const { XDG_CONFIG_HOME: _config, XDG_STATE_HOME: _state, ...inherited } = Bun.env;
const env = { ...inherited, HOME: scratch, KEEPER_ACTOR: "smoke" };
const server = `keeper-smoke-${process.pid}`;

function keeper(...args: string[]): string {
  const result = Bun.spawnSync([executable, ...args], { env, cwd: scratch, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`keeper ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString();
}

const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", server, "-f", "/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });

try {
  copyFileSync(resolve(source), executable);
  chmodSync(executable, 0o755);
  if (!keeper("--version").startsWith("keeper ")) throw new Error("--version failed");
  if (!keeper("--help").includes("keeper scan")) throw new Error("--help failed");
  if (!JSON.parse(keeper("schema")).exitCodes) throw new Error("schema is not JSON");
  if (typeof JSON.parse(keeper("status")).free !== "number") throw new Error("status is not JSON");

  const batch = join(scratch, "batch");
  mkdirSync(batch);
  writeFileSync(join(batch, "out"), "data");
  mkdirSync(join(scratch, ".config/keeper"), { recursive: true });
  writeFileSync(join(scratch, ".config/keeper/config.toml"), 'agentRoots = ["~/batch"]\n');
  const finding = JSON.parse(keeper("scan", "--category", "agent", "--stale-days", "0")).findings[0];
  if (finding?.paths?.[0] !== batch) throw new Error("scan did not report the configured root");
  const plan = JSON.parse(keeper("plan", finding.id, "--stale-days", "0"));
  const applied = JSON.parse(keeper("apply", plan.id, "--yes"));
  if (Bun.spawnSync(["test", "-e", batch]).exitCode === 0) throw new Error("apply left the path in place");
  keeper("undo", applied.transaction);
  if (Bun.spawnSync(["test", "-f", join(batch, "out")]).exitCode !== 0) throw new Error("undo did not restore it");

  tmux("new-session", "-d", "-s", "wizard", "-x", "100", "-y", "24", `'${executable}'`);
  const deadline = Date.now() + 20_000;
  let screen = "";
  while (Date.now() < deadline && !screen.includes("q quit")) {
    await Bun.sleep(200);
    screen = tmux("capture-pane", "-p", "-t", "wizard").stdout.toString();
  }
  if (!screen.includes("q quit")) throw new Error(`the wizard did not start: ${screen}`);
  tmux("send-keys", "-t", "wizard", "q");
  console.log("version, help, schema, status, scan, plan, apply, undo and the wizard passed");
} finally {
  tmux("kill-server");
  rmSync(scratch, { recursive: true, force: true });
}
