import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import { cachedScan, forget, maxAge } from "./cache";
import { freshen, primaryCheckouts } from "./freshen";
import { readEvents, readSamples, sample } from "./history";
import { actor, audit, BusyError, type Claim, type Hold, readAudit, readLedger, updateLedger } from "./ledger";
import { applyPlan, bulkPlan, context, createPlan, freeBytes, purge, readPlan, transactions, undo } from "./ops";
import { defaultAppStaleDays, defaultStaleDays } from "./scanners";
import { defaultPaths, run } from "./system";
import { installCron, installSystemd, lastServiceResult, removeSchedule, scheduleStatus } from "./timer";
import {
  bulkEligible,
  type Category,
  categories,
  count,
  eligible,
  type Finding,
  type Risk,
  risks,
  schemaVersion,
} from "./types";
import { recordUsage } from "./usage";

/** Each code past 2 tells the caller one thing to do next. */
export const exit = { ok: 0, error: 1, usage: 2, needsConfirmation: 3, stalePlan: 4, partial: 5, busy: 6 } as const;

const trashDays = 14;
const holdDays = 7;
/** Each adds evidence or an action, and keeper works without it. */
const optionalTools = ["gh", "paccache", "expac", "notify-send", "uv"];

const help = `keeper keeps an Arch machine clean. Output is JSON when stdout is not a terminal or with --json.

  keeper                         open the wizard (terminal only)
  keeper scan [--category C] [--stale-days N] [--app-stale-days N] [--cached]
                                 list findings; --cached reuses categories scanned recently
  keeper plan [ID...] [--category C] [--max-risk low|medium] [--stale-days N] [--app-stale-days N]
                                 save a plan of eligible findings; apps and personal files need their id
  keeper apply PLAN --yes        rescan, then apply what is unchanged
  keeper undo TX                 restore a transaction from trash
  keeper purge [--older-days N]  delete trash for good (default ${trashDays})
  keeper hold PATH --reason R [--days N]
                                 protect a path you will return to (default ${holdDays} days)
  keeper claim PATH              declare your own scratch as disposable once stale
  keeper release PATH            drop your hold or claim on a path
  keeper status                  trash, holds, schedule, last run and what needs attention
  keeper log                     recent mutations and who made them
  keeper history [--days N]      free space readings and the events that changed it (default 30 days)
  keeper sample                  record free space now, as the hourly timer does
  keeper schema                  machine-readable description of this CLI
  keeper auto                    apply low-risk findings, purge old trash, notify
  keeper --version               print the version
  keeper timer install [--cron]  schedule keeper auto daily and keeper sample hourly
  keeper timer remove            remove the schedule

Sizes are uncompressed, so btrfs with compression frees less than they show. Space returns at purge, which reports what it freed.
Worktrees are low risk only with proof: a merged PR with the same commit, or every commit on the default branch.
Exit codes: 0 ok, 1 error, 2 usage, 3 needs --yes, 4 plan is entirely stale, 5 partly applied, so scan again, 6 another run holds the lock, so retry.
Set KEEPER_ACTOR to name yourself in holds, claims and the log.
A load finding appears only while the machine is oversubscribed, and renicing needs --max-risk medium.
Apps, large files, downloads, screenshots and duplicates are only planned by explicit id. A bare keeper plan never
takes them, even with --max-risk medium, because only you can say which app or personal file may go.
Categories: ${categories.join(", ")}.`;

interface Flags {
  positional: string[];
  json: boolean;
  yes: boolean;
  cron: boolean;
  cached: boolean;
  category?: Category[];
  maxRisk: Risk;
  olderDays: number;
  staleDays: number;
  appStaleDays: number;
  days?: number;
  reason?: string;
}

/** A mistake in how keeper was called. `next` is the command that gets the caller unstuck. */
class UsageError extends Error {
  constructor(
    message: string,
    readonly next = "keeper --help",
  ) {
    super(message);
  }
}

function parse(args: readonly string[]): Flags {
  const flags: Flags = {
    positional: [],
    json: false,
    yes: false,
    cron: false,
    cached: false,
    maxRisk: "low",
    olderDays: trashDays,
    staleDays: defaultStaleDays,
    appStaleDays: defaultAppStaleDays,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--json") flags.json = true;
    else if (arg === "--yes") flags.yes = true;
    else if (arg === "--cron") flags.cron = true;
    else if (arg === "--cached") flags.cached = true;
    else if (arg === "--category") {
      const category = value() as Category;
      if (!categories.includes(category)) throw new UsageError(`unknown category ${category}`);
      flags.category = [...(flags.category ?? []), category];
    } else if (arg === "--max-risk") {
      const risk = value() as Risk;
      if (!risks.includes(risk) || risk === "high") throw new UsageError("--max-risk must be low or medium");
      flags.maxRisk = risk;
    } else if (arg === "--stale-days") {
      flags.staleDays = Number(value());
      if (!Number.isFinite(flags.staleDays) || flags.staleDays < 0)
        throw new UsageError("--stale-days must be a number of days, 0 or more");
    } else if (arg === "--app-stale-days") {
      flags.appStaleDays = Number(value());
      if (!Number.isFinite(flags.appStaleDays) || flags.appStaleDays < 0)
        throw new UsageError("--app-stale-days must be a number of days, 0 or more");
    } else if (arg === "--days") {
      flags.days = Number(value());
      if (!Number.isFinite(flags.days) || flags.days <= 0) throw new UsageError("--days must be positive");
    } else if (arg === "--reason") flags.reason = value();
    else if (arg === "--older-days") {
      flags.olderDays = Number(value());
      if (!Number.isFinite(flags.olderDays) || flags.olderDays < 0)
        throw new UsageError("--older-days must be a number of days, 0 or more");
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

/** Short size: 512K, 340M, 2.3G. */
export function size(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  const power = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${power >= 3 ? value.toFixed(1) : Math.round(value)}${units[power]}`;
}

/** A `load` finding frees no space, so it shows the CPU it gives back. A prune frees an amount unknown until it runs. */
export function measure(finding: Finding): string {
  if (finding.bytes > 0) return size(finding.bytes);
  if (finding.cpu !== undefined) return `${Math.round(finding.cpu)}% cpu`;
  return "?";
}

/** Claims become deletable, so a slip here must not be able to take a home directory or a repo with it. */
export function dangerous(path: string, home: string): boolean {
  return path === "/" || home === path || home.startsWith(`${path}/`) || existsSync(join(path, ".git/HEAD"));
}

export function schema() {
  return {
    schemaVersion,
    exitCodes: exit,
    categories,
    risks,
    version: packageJson.version,
    finding:
      "id, category, risk, action, title, paths, packages, bytes, reason, blockers, explicit; worktrees add gitDir, branch and head; load findings add cpu and pids; tmp findings add inodes",
    explicit:
      "true means a person has to name the finding's id in `keeper plan`. A plan with no ids never takes it, whatever --max-risk says",
    bytes: "uncompressed size, so a compressing filesystem frees less. Only purge's freed field is measured",
    eligible: "blockers is empty and action is not report",
    scan: "schemaVersion, scannedAt, categoryScannedAt (when each category was scanned), cached (categories reused), findings, warnings",
    environment: { KEEPER_ACTOR: "name recorded in holds, claims and the log" },
    cacheMinutes: maxAge,
    history:
      "samples are {at, free, size} in bytes, at most one per 10 minutes, kept 90 days; events are apply, purge, undo and auto from the log",
    help,
  };
}

function line(finding: Finding): string {
  const state =
    finding.action === "report" ? "report" : finding.blockers.length ? "blocked" : finding.explicit ? "by id" : "ready";
  const why = finding.blockers.length ? finding.blockers.join("; ") : finding.reason;
  return `${finding.id}  ${measure(finding).padStart(7)}  ${finding.risk.padEnd(6)} ${state.padEnd(7)} ${finding.title}\n    ${why}`;
}

interface AutoRun {
  at: string;
  summary: string;
  incomplete?: boolean;
  warnings?: string[];
}

/** A nightly run is due once a day, so a gap past this means the schedule stopped or the run crashed before logging. */
const overdueHours = 36;

/** What stops the nightly runs from being trusted. Empty means every check passed. */
export function health(schedule: string, last: AutoRun | undefined, result: string | undefined, now: number): string[] {
  if (schedule === "none") return ["no schedule, so nothing runs nightly"];
  const problems: string[] = [];
  if (result && result !== "success") problems.push(`the last nightly run ended in ${result}`);
  if (!last) return [...problems, "no nightly run recorded yet"];
  const hours = (now - Date.parse(last.at)) / 3_600_000;
  if (hours > overdueHours) problems.push(`the last nightly run was ${Math.floor(hours)} hours ago`);
  if (last.incomplete) problems.push("the last nightly run could not apply or purge everything");
  if (last.warnings?.length) problems.push(`the last nightly scan warned: ${last.warnings.join("; ")}`);
  return problems;
}

async function auto(flags: Flags): Promise<{ value: { summary: string } & Record<string, unknown>; code: number }> {
  const ctx = context();
  // Freshen first, so the scan judges worktrees against the default branch as it is now.
  const repos = ctx.config.freshen ? await primaryCheckouts(ctx) : [];
  const freshened = await Promise.all(repos.map(freshen));
  const report = await cachedScan(ctx, { reuse: false });
  const ready = report.findings.filter((finding) => bulkEligible(finding) && finding.risk === "low");
  const paths = ctx.paths;
  const outcome = ready.length
    ? await applyPlan(createPlan(paths, ready, ctx.staleDays, ctx.appStaleDays), ctx)
    : undefined;
  const purged = await purge(paths, flags.olderDays);
  const waiting = report.findings.filter((finding) => eligible(finding) && finding.risk !== "low");
  const free = await freeBytes(paths.home);
  const waitingBytes = waiting.reduce((sum, finding) => sum + finding.bytes, 0);
  const summary = `Moved ${size(outcome?.bytes ?? 0)} to trash, purge freed ${size(purged.freed)}, ${size(free)} free. ${size(waitingBytes)} waits for approval. Sizes before purge are uncompressed.`;
  const low = free < ctx.config.warnFreeGb * 1024 ** 3;
  const warnings = report.warnings;
  if (waitingBytes > 10 * 1024 ** 3 || low || warnings.length) {
    const said = warnings.length ? `${summary} Scan warnings: ${warnings.join("; ")}` : summary;
    await run(["notify-send", ...(low || warnings.length ? ["-u", "critical"] : []), "keeper", said]);
  }
  const incomplete = (outcome?.failed.length ?? 0) > 0 || purged.failed.length > 0;
  audit(paths, "auto", { summary, incomplete, warnings });
  return {
    value: {
      at: new Date().toISOString(),
      summary,
      free,
      outcome,
      purged,
      waiting: waiting.length,
      freshened: freshened.filter((note) => note !== undefined),
      warnings,
    },
    code: incomplete ? exit.partial : exit.ok,
  };
}

async function dispatch(
  flags: Flags,
  command: string | undefined,
  rest: string[],
): Promise<{ value: unknown; text?: string; code?: number }> {
  const paths = defaultPaths();
  switch (command) {
    case "scan": {
      const report = await cachedScan(context(flags.staleDays, flags.appStaleDays), {
        reuse: flags.cached,
        only: flags.category,
      });
      const total = report.findings.filter(eligible).reduce((sum, finding) => sum + finding.bytes, 0);
      return {
        value: { ...report, next: "keeper plan [ID...] [--max-risk medium]" },
        text: `${report.findings.map(line).join("\n")}\n\n${size(total)} eligible, uncompressed${report.cached.length ? `. Reused from the cache: ${report.cached.join(", ")}` : ""}\nApps and personal files show by id and are only planned when you name them.`,
      };
    }
    case "plan": {
      const report = await cachedScan(context(flags.staleDays, flags.appStaleDays), {
        reuse: false,
        only: flags.category,
      });
      const chosen = rest.length
        ? rest.map((id) => {
            const finding = report.findings.find((candidate) => candidate.id === id);
            if (!finding) throw new UsageError(`no finding ${id}`);
            if (!eligible(finding))
              throw new UsageError(`${id} is not eligible: ${finding.blockers.join("; ") || finding.action}`);
            return finding;
          })
        : bulkPlan(report.findings, flags.maxRisk);
      const plan = createPlan(paths, chosen, flags.staleDays, flags.appStaleDays);
      return {
        value: { ...plan, next: `keeper apply ${plan.id} --yes` },
        text: `plan ${plan.id}: ${count(chosen.length, "item")}, ${size(plan.bytes)}`,
      };
    }
    case "apply": {
      const [id] = rest;
      if (!id) throw new UsageError("usage: keeper apply PLAN --yes");
      if (!existsSync(join(paths.state, "plans", `${id}.json`))) throw new UsageError(`no plan ${id}`, "keeper plan");
      const plan = readPlan(paths, id);
      if (!flags.yes) {
        return {
          value: {
            status: "needs_confirmation",
            message: `plan ${id} changes the machine, so it runs only with --yes`,
            plan,
            next: `keeper apply ${id} --yes`,
          },
          text: `plan ${id} would process ${count(plan.findingIds.length, "item")}, ${size(plan.bytes)}. Re-run with --yes.`,
          code: exit.needsConfirmation,
        };
      }
      const outcome = await applyPlan(plan, context(plan.staleDays, plan.appStaleDays));
      const partial = outcome.failed.length > 0 || (outcome.stale.length > 0 && outcome.applied.length > 0);
      const next = outcome.transaction
        ? `keeper undo ${outcome.transaction} to restore, or keeper purge --older-days 0 to free the space`
        : "keeper scan";
      const moved = outcome.bytes > 0 ? `, ${size(outcome.bytes)} moved` : "";
      const lowered = outcome.reniced > 0 ? `, ${count(outcome.reniced, "process", "processes")} deprioritised` : "";
      return {
        value: { ...outcome, next: partial ? "keeper scan" : next },
        text: `applied ${outcome.applied.length}, stale ${outcome.stale.length}, failed ${outcome.failed.length}${moved}${lowered}. undo: ${outcome.transaction ?? "none"}`,
        code: partial
          ? exit.partial
          : outcome.applied.length === 0 && outcome.stale.length > 0
            ? exit.stalePlan
            : exit.ok,
      };
    }
    case "undo": {
      const [id] = rest;
      if (!id) throw new UsageError("usage: keeper undo TX");
      const result = await undo(paths, id);
      const reinstall = result.removedPackages.length
        ? `\nreinstall with: sudo pacman -S --asdeps ${result.removedPackages.join(" ")}`
        : "";
      const reniced = result.reniced
        ? `, ${count(result.reniced, "process", "processes")} back at their old priority`
        : "";
      const stuck = result.stuck.length
        ? `\n${result.stuck.length} still at low priority, which needs root to raise: ${result.stuck
            .map((entry) => `${entry.pid} back to ${entry.nice}`)
            .join(", ")}`
        : "";
      return { value: result, text: `restored ${result.restored.length} paths${reniced}${reinstall}${stuck}` };
    }
    case "purge": {
      const result = await purge(paths, flags.olderDays);
      return {
        value: result,
        text: `purged ${count(result.purged.length, "transaction")}: ${size(result.freed)} freed on disk, ${size(result.bytes)} uncompressed`,
      };
    }
    case "hold": {
      const [target] = rest;
      if (!target || !flags.reason) throw new UsageError("usage: keeper hold PATH --reason R [--days N]");
      const path = resolve(target);
      if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
      const hold: Hold = {
        path,
        until: new Date(Date.now() + (flags.days ?? holdDays) * 86_400_000).toISOString(),
        reason: flags.reason,
        actor: actor(),
      };
      await updateLedger(paths, (ledger) => ({
        ...ledger,
        holds: [...ledger.holds.filter((item) => item.path !== path), hold],
      }));
      audit(paths, "hold", hold);
      return { value: hold, text: `held ${path} until ${hold.until}` };
    }
    case "claim": {
      const [target] = rest;
      if (!target) throw new UsageError("usage: keeper claim PATH");
      const path = resolve(target);
      if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
      if (dangerous(path, paths.home)) throw new UsageError(`${path} is too broad to claim`);
      const claim: Claim = { path, actor: actor(), at: new Date().toISOString() };
      await updateLedger(paths, (ledger) => ({
        ...ledger,
        claims: [...ledger.claims.filter((item) => item.path !== path), claim],
      }));
      forget(paths, ["agent"]); // Claimed paths are scanned as agent output.
      audit(paths, "claim", claim);
      return { value: claim, text: `claimed ${path}` };
    }
    case "release": {
      const [target] = rest;
      if (!target) throw new UsageError("usage: keeper release PATH");
      const path = resolve(target);
      // Idempotent, so an agent can retry it; `released` says whether there was anything to drop.
      const before = await updateLedger(paths, (ledger) => ({
        holds: ledger.holds.filter((item) => item.path !== path),
        claims: ledger.claims.filter((item) => item.path !== path),
      }));
      const released = [...before.holds, ...before.claims].some((item) => item.path === path);
      forget(paths, ["agent"]);
      audit(paths, "release", { path });
      return {
        value: { path, released },
        text: released ? `released ${path}` : `${path} had no hold or claim, so nothing changed`,
      };
    }
    case "log": {
      const entries = readAudit(paths, 50);
      return { value: entries, text: entries.map((entry) => JSON.stringify(entry)).join("\n") };
    }
    case "history": {
      const days = flags.days ?? 30;
      const samples = readSamples(paths, days);
      const events = readEvents(paths, days);
      const first = samples[0];
      const last = samples.at(-1);
      const change =
        first && last
          ? `, ${last.free >= first.free ? "up" : "down"} ${size(Math.abs(last.free - first.free))} since ${first.at}`
          : "";
      return {
        value: { days, samples, events, next: samples.length ? "keeper scan" : "keeper sample" },
        text: last
          ? `${count(samples.length, "reading")} over ${count(days, "day")}: ${size(last.free)} free now${change}\n${events.map((event) => `${event.at} ${event.event}${event.bytes ? ` ${size(event.bytes)}` : ""}`).join("\n")}`
          : "no readings yet. keeper sample records one, and the hourly timer keeps recording",
      };
    }
    case "sample": {
      // The hourly timer runs this, so it also keeps the last-seen ledger the `apps` category judges from.
      await recordUsage(paths).catch(() => undefined);
      const reading = await sample(paths, Date.now(), true);
      return {
        value: reading ?? null,
        text: reading ? `${size(reading.free)} free of ${size(reading.size)}` : "df gave no reading",
      };
    }
    case "schema":
      return { value: schema(), text: JSON.stringify(schema(), null, 2) };
    case "status": {
      const trash = transactions(paths);
      const lastRun = readAudit(paths, 500)
        .filter((entry): entry is AutoRun => (entry as { event?: string }).event === "auto")
        .at(-1);
      const holds = readLedger(paths).holds.filter((hold) => Date.parse(hold.until) > Date.now());
      const schedule = await scheduleStatus();
      const result = schedule === "systemd" ? await lastServiceResult() : undefined;
      const problems = health(schedule, lastRun, result, Date.now());
      const value = {
        version: packageJson.version,
        free: await freeBytes(paths.home),
        schedule,
        healthy: problems.length === 0,
        problems,
        lastRun,
        holds,
        trash: trash.map((tx) => ({ id: tx.id, appliedAt: tx.appliedAt, paths: tx.entries.length })),
        lastSample: readSamples(paths, 1).at(-1)?.at,
        missingTools: optionalTools.filter((tool) => !Bun.which(tool)),
        next: schedule === "none" ? "keeper timer install" : problems.length ? "keeper log" : "keeper scan",
      };
      const last = lastRun ? `\nlast run ${lastRun.at}: ${lastRun.summary}` : "";
      const verdict = problems.length ? `\nunhealthy: ${problems.join("; ")}` : "\nhealthy";
      const missing = value.missingTools.length ? `\nmissing: ${value.missingTools.join(", ")}` : "";
      return {
        value,
        text: `${size(value.free)} free, schedule ${schedule}, ${count(trash.length, "transaction")} in trash, ${count(holds.length, "hold")}${last}${verdict}${missing}\nnext: ${value.next}`,
      };
    }
    case "auto": {
      const result = await auto(flags);
      return { value: result.value, text: result.value.summary, code: result.code };
    }
    case "timer": {
      const [verb] = rest;
      if (verb === "install") {
        await (flags.cron ? installCron() : installSystemd(paths));
        return { value: { schedule: flags.cron ? "cron" : "systemd" }, text: "schedule installed" };
      }
      if (verb === "remove") {
        await removeSchedule(paths);
        return { value: { schedule: "none" }, text: "schedule removed" };
      }
      throw new UsageError("usage: keeper timer install [--cron] | keeper timer remove");
    }
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

const sampled = new Set(["scan", "plan", "apply", "undo", "purge", "status", "auto"]);

/** Returns undefined only when the wizard should open, which callers must never reach without a terminal. */
export async function runCli(args: readonly string[]): Promise<number | undefined> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return exit.ok;
  }
  let json = !process.stdout.isTTY || args.includes("--json");
  if (args.includes("--version")) {
    console.log(json ? JSON.stringify({ version: packageJson.version }) : `keeper ${packageJson.version}`);
    return exit.ok;
  }
  try {
    const flags = parse(args);
    json ||= flags.json;
    const [command, ...rest] = flags.positional;
    if (!command) {
      if (process.stdin.isTTY && process.stdout.isTTY) return undefined;
      throw new UsageError("the wizard needs a terminal. Run keeper --help");
    }
    const result = await dispatch(flags, command, rest);
    // Commands that see or change free space leave a reading, so the history fills in without the timer.
    if (sampled.has(command)) await sample(defaultPaths()).catch(() => undefined);
    console.log(json ? JSON.stringify(result.value) : (result.text ?? JSON.stringify(result.value)));
    return result.code ?? exit.ok;
  } catch (error) {
    const usage = error instanceof UsageError;
    const busy = error instanceof BusyError;
    const message = error instanceof Error ? error.message : String(error);
    const next = usage ? error.next : busy ? "retry once the other keeper run finishes" : "keeper status";
    console.error(
      json
        ? JSON.stringify({ error: { code: usage ? "usage" : busy ? "busy" : "error", message, next } })
        : `keeper: ${message}\nnext: ${next}`,
    );
    return usage ? exit.usage : busy ? exit.busy : exit.error;
  }
}
