import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Paths, run } from "./system";

const service = "keeper.service";
const timer = "keeper.timer";
const sampleService = "keeper-sample.service";
const sampleTimer = "keeper-sample.timer";
const cronMark = "# keeper";

/** systemd splits on whitespace and expands `%` and `$`, so every argument is quoted and escaped. */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function keeperCommand(): string[] {
  return process.execPath.endsWith("bun") ? [process.execPath, join(import.meta.dir, "index.tsx")] : [process.execPath];
}

export function units(command: readonly string[], paths: Paths, path: string): Record<string, string> {
  return {
    [service]: `[Unit]
Description=keeper: apply low-risk cleanup and report the rest

[Service]
Type=oneshot
Nice=10
Environment=${quote(`PATH=${path}`)}
ExecStart=${[...command, "auto"].map(quote).join(" ")}
StandardOutput=append:${paths.state}/keeper.log
StandardError=append:${paths.state}/keeper.log
ExecStopPost=${[
      "/bin/sh",
      "-c",
      '[ "$SERVICE_RESULT" = success ] || notify-send -u critical keeper "The nightly run failed. See keeper status"',
    ]
      .map(quote)
      .join(" ")}
`,
    [timer]: `[Unit]
Description=Daily keeper run

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
`,
    // Separate from the nightly run, so status health still means the cleanup ran, not that a reading did.
    [sampleService]: `[Unit]
Description=keeper: record free space for keeper history

[Service]
Type=oneshot
Nice=19
ExecStart=${[...command, "sample"].map(quote).join(" ")}
`,
    [sampleTimer]: `[Unit]
Description=Hourly keeper free space reading

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
`,
  };
}

export async function installSystemd(paths: Paths): Promise<void> {
  mkdirSync(paths.units, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  for (const [name, text] of Object.entries(units(keeperCommand(), paths, process.env.PATH ?? "/usr/bin"))) {
    const target = join(paths.units, name);
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) writeFileSync(target, text);
  }
  await systemctl("daemon-reload");
  await systemctl("enable", "--now", timer, sampleTimer);
}

export async function installCron(): Promise<void> {
  const command = keeperCommand().join(" ");
  const current = (await run(["crontab", "-l"])).stdout;
  const kept = current.split("\n").filter((entry) => entry && !entry.endsWith(cronMark));
  await writeCrontab([...kept, `17 3 * * * ${command} auto ${cronMark}`, `7 * * * * ${command} sample ${cronMark}`]);
}

export async function removeSchedule(paths: Paths): Promise<void> {
  await run(["systemctl", "--user", "disable", "--now", timer, sampleTimer]);
  for (const name of [service, timer, sampleService, sampleTimer]) {
    const target = join(paths.units, name);
    if (existsSync(target)) unlinkSync(target);
  }
  await run(["systemctl", "--user", "daemon-reload"]);
  const current = (await run(["crontab", "-l"])).stdout;
  if (current.includes(cronMark)) await writeCrontab(current.split("\n").filter((entry) => !entry.endsWith(cronMark)));
}

/** How the last nightly run ended under systemd: success, exit-code, signal and so on. Undefined before any run. */
export async function lastServiceResult(): Promise<string | undefined> {
  const shown = await run([
    "systemctl",
    "--user",
    "show",
    service,
    "--property=Result,ExecMainStartTimestampMonotonic",
  ]);
  const fields = Object.fromEntries(shown.stdout.split("\n").map((line) => line.split("=", 2)));
  return fields.ExecMainStartTimestampMonotonic && fields.ExecMainStartTimestampMonotonic !== "0"
    ? fields.Result
    : undefined;
}

export async function scheduleStatus(): Promise<string> {
  const systemd = await run(["systemctl", "--user", "is-enabled", timer]);
  if (systemd.stdout === "enabled") return "systemd";
  return (await run(["crontab", "-l"])).stdout.includes(cronMark) ? "cron" : "none";
}

async function systemctl(...args: string[]): Promise<void> {
  const result = await run(["systemctl", "--user", ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
}

async function writeCrontab(lines: string[]): Promise<void> {
  const child = Bun.spawn(["crontab", "-"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  child.stdin.write(`${lines.join("\n")}\n`);
  await child.stdin.end();
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}
