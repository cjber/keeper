import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
const warnFreeBytes = 60 * 1024 ** 3;

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
  keeper status                  trash, holds, schedule and free space
  keeper log                     recent mutations and who made them
  keeper schema                  machine-readable description of this CLI
  keeper auto                    apply low-risk findings, purge old trash, notify
  keeper timer install [--cron]  schedule keeper auto daily
  keeper timer remove            remove the schedule

Exit codes: 0 ok, 1 error, 2 usage, 3 needs --yes, 4 plan is entirely stale, 5 partly applied, so scan again, 6 another run holds the lock, so retry.
Set KEEPER_ACTOR to name yourself in holds, claims and the log.
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

/** Claims become deletable, so a slip here must not be able to take a home directory or a repo with it. */
export function dangerous(path: string, home: string): boolean {
  return path === "/" || home === path || home.startsWith(`${path}/`) || existsSync(join(path, ".git/HEAD"));
}

function schema() {
  return {
    schemaVersion,
    exitCodes: exit,
    categories,
    risks,
    finding: "id, category, risk, action, title, paths, packages, bytes, reason, blockers",
    eligible: "blockers is empty and action is not report",
    environment: { KEEPER_ACTOR: "name recorded in holds, claims and the log" },
    help,
  };
}

function line(finding: Finding): string {
  const state = finding.action === "report" ? "report" : finding.blockers.length ? "blocked" : "ready";
  const why = finding.blockers.length ? finding.blockers.join("; ") : finding.reason;
  return `${finding.id}  ${gib(finding.bytes).padStart(7)}  ${finding.risk.padEnd(6)} ${state.padEnd(7)} ${finding.title}\n    ${why}`;
}

async function auto(flags: Flags): Promise<{ value: unknown; code: number }> {
  const ctx = context();
  const report = await scan(ctx);
  const ready = report.findings.filter((finding) => eligible(finding) && finding.risk === "low");
  const paths = ctx.paths;
  const outcome = ready.length ? await applyPlan(createPlan(paths, ready, ctx.staleDays), ctx) : undefined;
  const purged = await purge(paths, flags.olderDays);
  const waiting = report.findings.filter((finding) => eligible(finding) && finding.risk !== "low");
  const free = await freeBytes(paths.home);
  const waitingBytes = waiting.reduce((sum, finding) => sum + finding.bytes, 0);
  const summary = `Moved ${gib(outcome?.bytes ?? 0)} to trash, purged ${gib(purged.bytes)}, ${gib(free)} free. ${gib(waitingBytes)} waits for approval.`;
  if (waitingBytes > 10 * 1024 ** 3 || free < warnFreeBytes) {
    await run(["notify-send", ...(free < warnFreeBytes ? ["-u", "critical"] : []), "keeper", summary]);
  }
  const incomplete = (outcome?.failed.length ?? 0) > 0;
  return {
    value: {
      at: new Date().toISOString(),
      summary,
      free,
      outcome,
      purged,
      waiting: waiting.length,
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
        text: `${report.findings.map(line).join("\n")}\n\n${gib(total)} eligible`,
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
      return {
        value: { ...outcome, next: partial ? "keeper scan" : next },
        text: `applied ${outcome.applied.length}, stale ${outcome.stale.length}, failed ${outcome.failed.length}, ${gib(outcome.bytes)} moved. undo: ${outcome.transaction ?? "none"}`,
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
      const result = undo(paths, id);
      const reinstall = result.removedPackages.length
        ? `\nreinstall with: sudo pacman -S --asdeps ${result.removedPackages.join(" ")}`
        : "";
      return { value: result, text: `restored ${result.restored.length} paths${reinstall}` };
    }
    case "purge": {
      const result = await purge(paths, flags.olderDays);
      return { value: result, text: `purged ${result.purged.length} transactions, ${gib(result.bytes)}` };
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
      const value = {
        free: await freeBytes(paths.home),
        schedule: await scheduleStatus(),
        holds: readLedger(paths).holds,
        trash: trash.map((tx) => ({ id: tx.id, appliedAt: tx.appliedAt, paths: tx.entries.length })),
      };
      return {
        value,
        text: `${gib(value.free)} free, schedule ${value.schedule}, ${trash.length} transactions in trash`,
      };
    }
    case "auto": {
      const result = await auto(flags);
      return { value: result.value, text: JSON.stringify(result.value), code: result.code };
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
