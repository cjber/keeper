import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedScan, forget } from "./cache";
import { freeChart, spaceBars } from "./charts";
import { readEvents, readSamples, sample } from "./history";
import { audit, writeLedger } from "./ledger";
import { type Context, defaultConfig } from "./scanners";
import { defaultPaths } from "./system";

let home: string;
let ctx: Context;
const old = new Date(Date.now() - 30 * 86_400_000);
const minute = 60_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-data-"));
  ctx = {
    paths: { ...defaultPaths(home, {}), state: join(home, "state") },
    config: { ...defaultConfig, agentRoots: ["~/batch"], agentCachePatterns: [] },
    live: [],
    now: Date.now(),
    staleDays: 7,
    processes: [],
    docker: async () => undefined,
  };
  mkdirSync(join(home, "batch"));
  writeFileSync(join(home, "batch", "out"), "data");
  utimesSync(join(home, "batch"), old, old);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("a recent category is reused until its max age, a full rescan or a forget", async () => {
  const first = await cachedScan(ctx, { only: ["agent"] });
  expect(first.cached).toEqual([]);
  expect(first.findings).toHaveLength(1);
  rmSync(join(home, "batch"), { recursive: true });
  const reused = await cachedScan({ ...ctx, now: ctx.now + 5 * minute }, { only: ["agent"] });
  expect(reused.cached).toEqual(["agent"]);
  expect(reused.findings).toHaveLength(1);
  expect(reused.categoryScannedAt.agent).toBe(first.scannedAt);
  const expired = await cachedScan({ ...ctx, now: ctx.now + 61 * minute }, { only: ["agent"] });
  expect(expired.findings).toHaveLength(0);
  mkdirSync(join(home, "batch"));
  utimesSync(join(home, "batch"), old, old);
  await cachedScan(ctx, { reuse: false, only: ["agent"] });
  forget(ctx.paths, ["agent"]);
  expect((await cachedScan(ctx, { only: ["agent"] })).cached).toEqual([]);
});

test("a cache from another window, a failed category and load are never reused", async () => {
  await cachedScan(ctx, { only: ["agent", "docker", "load"] });
  expect((await cachedScan({ ...ctx, staleDays: 3 }, { only: ["agent"] })).cached).toEqual([]);
  const failing = { ...ctx, docker: async () => Promise.reject(new Error("daemon down")) };
  await cachedScan(failing, { reuse: false, only: ["docker"] });
  expect((await cachedScan(ctx, { only: ["docker", "load"] })).cached).toEqual([]);
});

test("a hold made after caching still blocks the cached finding", async () => {
  await cachedScan(ctx, { only: ["agent"] });
  writeLedger(ctx.paths, {
    holds: [{ path: join(home, "batch"), until: "2999-01-01T00:00:00Z", reason: "mine", actor: "a" }],
    claims: [],
  });
  const reused = await cachedScan(ctx, { only: ["agent"] });
  expect(reused.cached).toEqual(["agent"]);
  expect(reused.findings[0]?.blockers.join()).toContain("held by a");
});

test("readings are spaced ten minutes apart, skip torn lines and drop past 90 days", async () => {
  const now = Date.now();
  mkdirSync(ctx.paths.state, { recursive: true });
  const file = join(ctx.paths.state, "history.jsonl");
  writeFileSync(file, `${JSON.stringify({ at: new Date(now - 100 * 86_400_000).toISOString(), free: 1, size: 2 })}\n`);
  appendFileSync(file, "{torn\n");
  expect(await sample(ctx.paths, now)).toBeDefined();
  expect(readFileSync(file, "utf8")).not.toContain("torn");
  expect(await sample(ctx.paths, now + 5 * minute)).toBeUndefined();
  expect(await sample(ctx.paths, now + 11 * minute)).toBeDefined();
  expect(readSamples(ctx.paths, 90, now + 11 * minute)).toHaveLength(2);
});

test("events keep what changed free space, and the nightly runs", () => {
  audit(ctx.paths, "apply", { bytes: 5 });
  audit(ctx.paths, "apply", { bytes: 0 });
  audit(ctx.paths, "purge", { bytes: 9, freed: 4 });
  audit(ctx.paths, "hold", { path: "/x" });
  audit(ctx.paths, "auto", { summary: "ran" });
  expect(readEvents(ctx.paths).map((event) => [event.event, event.bytes])).toEqual([
    ["apply", 5],
    ["purge", 4],
    ["auto", undefined],
  ]);
});

test("the free space chart rises with the readings and marks events in their column", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const at = (hoursBack: number) => new Date(now - hoursBack * 3_600_000).toISOString();
  const gig = 1024 ** 3;
  const chart = freeChart(
    [
      { at: at(10), free: 100 * gig, size: 500 * gig },
      { at: at(0), free: 120 * gig, size: 500 * gig },
    ],
    [{ at: at(5), event: "apply", bytes: gig }],
    10,
    4,
    now,
  );
  expect(chart?.rows).toHaveLength(4);
  expect(chart?.rows.every((row) => row.text.length === 10)).toBe(true);
  // Low on the left, reaching the top row at the right once the second reading lands.
  expect(chart?.rows[0]?.text.at(-1)).not.toBe(" ");
  expect(chart?.rows[0]?.text[0]).toBe(" ");
  expect(chart?.markers[5]).toBe("apply");
  expect(freeChart([{ at: at(0), free: gig, size: gig }], [], 10, 4, now)).toBeUndefined();
});

test("each space bar counts its own category, even when another category contains the path", () => {
  const finding = (
    id: string,
    category: "worktree" | "build",
    path: string,
    bytes: number,
    blockers: string[] = [],
  ) => ({
    id,
    category,
    risk: "low" as const,
    action: "trash" as const,
    title: id,
    paths: [path],
    packages: [],
    bytes,
    reason: "",
    blockers,
  });
  const bars = spaceBars([
    finding("tree", "worktree", "/w/a", 10),
    finding("output", "build", "/w/a/node_modules", 4),
    finding("busy", "worktree", "/w/b", 3, ["in use"]),
  ]);
  expect(bars).toEqual([
    { category: "worktree", ready: 10, blocked: 3 },
    { category: "build", ready: 4, blocked: 0 },
  ]);
});
