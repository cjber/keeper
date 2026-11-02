import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import { freshen, primaryCheckouts } from "./freshen";
import { actor, audit, BusyError, type Claim, type Hold, readAudit, readLedger, writeLedger } from "./ledger";
import { applyPlan, context, createPlan, freeBytes, purge, readPlan, transactions, undo, withinRisk } from "./ops";
import { defaultStaleDays, scan } from "./scanners";
import { defaultPaths, run } from "./system";
import { installCron, installSystemd, removeSchedule, scheduleStatus } from "./timer";
import { type Category, categories, eligible, type Finding, type Risk, risks, schemaVersion } from "./types";

/** Each code past 2 tells the caller one thing to do next. */
export const exit = { ok: 0, error: 1, usage: 2, needsConfirmation: 3, stalePlan: 4, partial: 5, busy: 6 } as const;

const trashDays = 14;
const holdDays = 7;
/** Each adds evidence or an action, and keeper works without it. */
const optionalTools = ["gh", "paccache", "expac", "notify-send", "uv"];

const help = `keeper keeps an Arch machine clean. Output is JSON when stdout is not a terminal or with --json.

  keeper                         open the wizard (terminal only)
  keeper scan [--category C] [--stale-days N]
                                 list findings
  keeper plan [ID...] [--category C] [--max-risk low|medium] [--stale-days N]
                                 save a plan of eligible findings
  keeper apply PLAN --yes        rescan, then apply what is unchanged
  keeper undo TX                 restore a transaction from trash
  keeper purge [--older-days N]  delete trash for good (default ${trashDays})
  keeper hold PATH --reason R [--days N]
                                 protect a path you will return to (default ${holdDays} days)
  keeper claim PATH              declare your own scratch as disposable once stale
  keeper release PATH            drop your hold or claim on a path
  keeper status                  trash, holds, schedule, last run and what needs attention
  keeper log                     recent mutations and who made them
  keeper schema                  machine-readable description of this CLI
  keeper auto                    apply low-risk findings, purge old trash, notify
  keeper --version               print the version
  keeper timer install [--cron]  schedule keeper auto daily
  keeper timer remove            remove the schedule

Sizes are uncompressed, so btrfs with compression frees less than they show. Space returns at purge, which reports what it freed.
Worktrees are low risk only with proof: a merged PR with the same commit, or every commit on the default branch.
Exit codes: 0 ok, 1 error, 2 usage, 3 needs --yes, 4 plan is entirely stale, 5 partly applied, so scan again, 6 another run holds the lock, so retry.
Set KEEPER_ACTOR to name yourself in holds, claims and the log.
A load finding appears only while the machine is oversubscribed, and renicing needs --max-risk medium.
Categories: ${categories.join(", ")}.`;

interface Flags {
  positional: string[];
  json: boolean;
  yes: boolean;
  cron: boolean;
  category?: Category[];
  maxRisk: Risk;
  olderDays: number;
  staleDays: number;
  holdDays: number;
  reason?: string;
}

class UsageError extends Error {}

function parse(args: readonly string[]): Flags {
  const flags: Flags = {
    positional: [],
    json: false,
    yes: false,
    cron: false,
    maxRisk: "low",
    olderDays: trashDays,
    staleDays: defaultStaleDays,
    holdDays,
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
        throw new UsageError("--stale-days must be a number");
    } else if (arg === "--days") {
      flags.holdDays = Number(value());
      if (!Number.isFinite(flags.holdDays) || flags.holdDays <= 0) throw new UsageError("--days must be positive");
    } else if (arg === "--reason") flags.reason = value();
    else if (arg === "--older-days") {
      flags.olderDays = Number(value());
      if (!Number.isFinite(flags.olderDays) || flags.olderDays < 0)
        throw new UsageError("--older-days must be a number");
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

/** Short size for a table column: 512K, 340M, 2.3G. */
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
    finding: "id, category, risk, action, title, paths, packages, bytes, reason, blockers",
    bytes: "uncompressed size, so a compressing filesystem frees less. Only purge's freed field is measured",
    eligible: "blockers is empty and action is not report",
    environment: { KEEPER_ACTOR: "name recorded in holds, claims and the log" },
    help,
  };
}

function line(finding: Finding): string {
  const state = finding.action === "report" ? "report" : finding.blockers.length ? "blocked" : "ready";
  const why = finding.blockers.length ? finding.blockers.join("; ") : finding.reason;
  return `${finding.id}  ${measure(finding).padStart(7)}  ${finding.risk.padEnd(6)} ${state.padEnd(7)} ${finding.title}\n    ${why}`;
}

async function auto(flags: Flags): Promise<{ value: { summary: string } & Record<string, unknown>; code: number }> {
  const ctx = context();
  // Freshen first, so the scan judges worktrees against the default branch as it is now.
  const repos = ctx.config.freshen ? await primaryCheckouts(ctx) : [];
  const freshened = await Promise.all(repos.map(freshen));
  const report = await scan(ctx);
  const ready = report.findings.filter((finding) => eligible(finding) && finding.risk === "low");
  const paths = ctx.paths;
  const outcome = ready.length ? await applyPlan(createPlan(paths, ready, ctx.staleDays), ctx) : undefined;
  const purged = await purge(paths, flags.olderDays);
  const waiting = report.findings.filter((finding) => eligible(finding) && finding.risk !== "low");
  const free = await freeBytes(paths.home);
  const waitingBytes = waiting.reduce((sum, finding) => sum + finding.bytes, 0);
  const summary = `Moved ${gib(outcome?.bytes ?? 0)} to trash, purge freed ${gib(purged.freed)}, ${gib(free)} free. ${gib(waitingBytes)} waits for approval. Sizes before purge are uncompressed.`;
  const low = free < ctx.config.warnFreeGb * 1024 ** 3;
  if (waitingBytes > 10 * 1024 ** 3 || low) {
    await run(["notify-send", ...(low ? ["-u", "critical"] : []), "keeper", summary]);
  }
  const incomplete = (outcome?.failed.length ?? 0) > 0 || purged.failed.length > 0;
  audit(paths, "auto", { summary, incomplete });
  return {
    value: {
      at: new Date().toISOString(),
      summary,
      free,
      outcome,
      purged,
      waiting: waiting.length,
      freshened: freshened.filter((note) => note !== undefined),
      warnings: report.warnings,
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
      const report = await scan(context(flags.staleDays), flags.category);
      const total = report.findings.filter(eligible).reduce((sum, finding) => sum + finding.bytes, 0);
      return {
        value: { ...report, next: "keeper plan [ID...] [--max-risk medium]" },
        text: `${report.findings.map(line).join("\n")}\n\n${gib(total)} eligible, uncompressed`,
      };
    }
    case "plan": {
      const report = await scan(context(flags.staleDays), flags.category);
      const chosen = rest.length
        ? rest.map((id) => {
            const finding = report.findings.find((candidate) => candidate.id === id);
            if (!finding) throw new UsageError(`no finding ${id}`);
            if (!eligible(finding))
              throw new UsageError(`${id} is not eligible: ${finding.blockers.join("; ") || finding.action}`);
            return finding;
          })
        : report.findings.filter((finding) => eligible(finding) && withinRisk(finding, flags.maxRisk));
      const plan = createPlan(paths, chosen, flags.staleDays);
      return {
        value: { ...plan, next: `keeper apply ${plan.id} --yes` },
        text: `plan ${plan.id}: ${chosen.length} items, ${gib(plan.bytes)}`,
      };
    }
    case "apply": {
      const [id] = rest;
      if (!id) throw new UsageError("usage: keeper apply PLAN --yes");
      const plan = readPlan(paths, id);
      if (!flags.yes) {
        return {
          value: { status: "needs_confirmation", plan },
          text: `plan ${id} would process ${plan.findingIds.length} items, ${gib(plan.bytes)}. Re-run with --yes.`,
          code: exit.needsConfirmation,
        };
      }
      const outcome = await applyPlan(plan, context(plan.staleDays));
      const partial = outcome.failed.length > 0 || (outcome.stale.length > 0 && outcome.applied.length > 0);
      const next = outcome.transaction
        ? `keeper undo ${outcome.transaction} to restore, or keeper purge --older-days 0 to free the space`
        : "keeper scan";
      const moved = outcome.bytes > 0 ? `, ${gib(outcome.bytes)} moved` : "";
      const lowered = outcome.reniced > 0 ? `, ${outcome.reniced} processes deprioritised` : "";
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
      const reniced = result.reniced ? `, ${result.reniced} processes back at their old priority` : "";
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
        text: `purged ${result.purged.length} transactions: ${gib(result.freed)} freed on disk, ${gib(result.bytes)} uncompressed`,
      };
    }
    case "hold": {
      const [target] = rest;
      if (!target || !flags.reason) throw new UsageError("usage: keeper hold PATH --reason R [--days N]");
      const path = resolve(target);
      const ledger = readLedger(paths);
      const hold: Hold = {
        path,
        until: new Date(Date.now() + flags.holdDays * 86_400_000).toISOString(),
        reason: flags.reason,
        actor: actor(),
      };
      writeLedger(paths, { ...ledger, holds: [...ledger.holds.filter((item) => item.path !== path), hold] });
      audit(paths, "hold", hold);
      return { value: hold, text: `held ${path} until ${hold.until}` };
    }
    case "claim": {
      const [target] = rest;
      if (!target) throw new UsageError("usage: keeper claim PATH");
      const path = resolve(target);
      if (dangerous(path, paths.home)) throw new UsageError(`${path} is too broad to claim`);
      const ledger = readLedger(paths);
      const claim: Claim = { path, actor: actor(), at: new Date().toISOString() };
      writeLedger(paths, { ...ledger, claims: [...ledger.claims.filter((item) => item.path !== path), claim] });
      audit(paths, "claim", claim);
      return { value: claim, text: `claimed ${path}` };
    }
    case "release": {
      const [target] = rest;
      if (!target) throw new UsageError("usage: keeper release PATH");
      const path = resolve(target);
      const ledger = readLedger(paths);
      writeLedger(paths, {
        holds: ledger.holds.filter((item) => item.path !== path),
        claims: ledger.claims.filter((item) => item.path !== path),
      });
      audit(paths, "release", { path });
      return { value: { released: path }, text: `released ${path}` };
    }
    case "log": {
      const entries = readAudit(paths, 50);
      return { value: entries, text: entries.map((entry) => JSON.stringify(entry)).join("\n") };
    }
    case "schema":
      return { value: schema(), text: JSON.stringify(schema(), null, 2) };
    case "status": {
      const trash = transactions(paths);
      const lastRun = readAudit(paths, 500)
        .filter((entry): entry is { at: string; summary: string } => (entry as { event?: string }).event === "auto")
        .at(-1);
      const holds = readLedger(paths).holds.filter((hold) => Date.parse(hold.until) > Date.now());
      const schedule = await scheduleStatus();
      const value = {
        version: packageJson.version,
        free: await freeBytes(paths.home),
        schedule,
        lastRun,
        holds,
        trash: trash.map((tx) => ({ id: tx.id, appliedAt: tx.appliedAt, paths: tx.entries.length })),
        missingTools: optionalTools.filter((tool) => !Bun.which(tool)),
        next: schedule === "none" ? "keeper timer install" : "keeper scan",
      };
      const last = lastRun ? `\nlast run ${lastRun.at}: ${lastRun.summary}` : "";
      const missing = value.missingTools.length ? `\nmissing: ${value.missingTools.join(", ")}` : "";
      return {
        value,
        text: `${gib(value.free)} free, schedule ${schedule}, ${trash.length} transactions in trash, ${holds.length} holds${last}${missing}\nnext: ${value.next}`,
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

/** Returns undefined only when the wizard should open, which callers must never reach without a terminal. */
export async function runCli(args: readonly string[]): Promise<number | undefined> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return exit.ok;
  }
  if (args.includes("--version")) {
    console.log(`keeper ${packageJson.version}`);
    return exit.ok;
  }
  let json = !process.stdout.isTTY || args.includes("--json");
  try {
    const flags = parse(args);
    json ||= flags.json;
    const [command, ...rest] = flags.positional;
    if (!command) {
      if (process.stdin.isTTY && process.stdout.isTTY) return undefined;
      throw new UsageError("the wizard needs a terminal. Run keeper --help");
    }
    const result = await dispatch(flags, command, rest);
    console.log(json ? JSON.stringify(result.value) : (result.text ?? JSON.stringify(result.value)));
    return result.code ?? exit.ok;
  } catch (error) {
    const usage = error instanceof UsageError;
    const busy = error instanceof BusyError;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      json
        ? JSON.stringify({ error: { code: usage ? "usage" : busy ? "busy" : "error", message } })
        : `keeper: ${message}`,
    );
    return usage ? exit.usage : busy ? exit.busy : exit.error;
  }
}
