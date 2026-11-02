import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AppPackage, appFindings, type Context, defaultConfig, scan } from "./scanners";
import { defaultPaths } from "./system";
import { eligible } from "./types";
import { readUsage, recordUsage, type UsageLedger } from "./usage";

let home: string;
let ctx: Context;
const day = 86_400_000;
const old = new Date(Date.now() - 30 * day);

const pkg = (name: string, overrides: Partial<AppPackage> = {}): AppPackage => ({
  name,
  bytes: 1024 ** 2,
  requiredBy: [],
  groups: [],
  paths: [`/usr/bin/${name}`],
  ...overrides,
});

function age(path: string, when: Date = old) {
  utimesSync(path, when, when);
}

/** A sparse file of the given apparent size, aged so it is past every idle window. */
function bigFile(path: string, bytes: number, when: Date = old) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  truncateSync(path, bytes);
  age(path, when);
}

const coveredUsage = (): UsageLedger => {
  const since = new Date(Date.now() - 100 * day).toISOString();
  return { since, sampledAt: since, packages: {} };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-clean-"));
  ctx = {
    paths: { ...defaultPaths(home, {}), state: join(home, "state") },
    config: { ...defaultConfig },
    live: [],
    now: Date.now(),
    staleDays: 7,
    appStaleDays: 90,
    downloadDir: join(home, "Downloads"),
    picturesDir: join(home, "Pictures"),
    docker: async () => undefined,
  };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("apps: a package never seen for the whole window is unused", () => {
  const findings = appFindings([pkg("firefox")], coveredUsage(), Date.now(), 90);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ category: "apps", action: "remove-packages", risk: "medium", blockers: [] });
  expect(findings[0]?.title).toBe("firefox");
  expect(findings[0] && eligible(findings[0])).toBe(true);
});

test("apps: use is judged from the ledger, never atime, so a package seen running is left alone", () => {
  const usage = coveredUsage();
  usage.packages.firefox = new Date(Date.now() - 1 * day).toISOString();
  expect(appFindings([pkg("firefox")], usage, Date.now(), 90)).toEqual([]);
});

test("apps: before the ledger covers the window every candidate says so", () => {
  const since = new Date(Date.now() - 3 * day).toISOString();
  const usage: UsageLedger = { since, sampledAt: since, packages: {} };
  const [finding] = appFindings([pkg("firefox")], usage, Date.now(), 90);
  expect(finding?.blockers.join()).toContain("tracked for 3 of 90 days");
  expect(finding && eligible(finding)).toBe(false);
});

test("apps: dependants, base members and system parts are blocked", () => {
  const findings = appFindings(
    [
      pkg("bash", { requiredBy: ["other"] }),
      pkg("base", { groups: ["base"] }),
      pkg("linux"),
      pkg("linux-firmware"),
      pkg("nvidia"),
      pkg("hyprland"),
    ],
    coveredUsage(),
    Date.now(),
    90,
  );
  expect(findings).toHaveLength(6);
  expect(findings.every((finding) => finding.blockers.length > 0)).toBe(true);
  expect(findings.find((finding) => finding.title === "bash")?.blockers.join()).toContain("depends on it");
  expect(findings.find((finding) => finding.title === "linux")?.blockers.join()).toContain("kernel");
});

test("recordUsage folds running executables to their owning package and keeps the start", async () => {
  await recordUsage(ctx.paths, {
    executables: ["/usr/bin/firefox", "/usr/bin/not-owned"],
    ownerOf: async (path) => (path === "/usr/bin/firefox" ? "firefox" : undefined),
    now: Date.now(),
  });
  const ledger = readUsage(ctx.paths);
  expect(ledger?.packages.firefox).toBeDefined();
  expect(ledger?.packages["not-owned"]).toBeUndefined();
  expect(ledger?.since).toBeDefined();
});

test("large: stale files are offered, while recent, hidden, repo and download files are not", async () => {
  const stale = join(home, "videos", "movie.mkv");
  const recent = join(home, "videos", "new.mkv");
  const hidden = join(home, ".cache", "big.bin");
  const repo = join(home, "code", "repo", "big.bin");
  const download = join(home, "Downloads", "iso.iso");
  for (const path of [stale, recent, hidden, repo, download]) bigFile(path, 600 * 1024 ** 2);
  age(recent, new Date());
  mkdirSync(join(home, "code", "repo", ".git"), { recursive: true });
  const { findings } = await scan(ctx, ["large"]);
  expect(findings.map((finding) => finding.paths[0])).toEqual([stale]);
  expect(findings[0]).toMatchObject({ risk: "medium", action: "trash" });
});

test("large: the threshold is configurable", async () => {
  const small = join(home, "small.bin");
  bigFile(small, 200 * 1024 ** 2);
  expect((await scan(ctx, ["large"])).findings).toEqual([]);
  const lowered = { ...ctx, config: { ...ctx.config, largeBytes: 100 * 1024 ** 2 } };
  expect((await scan(lowered, ["large"])).findings.map((finding) => finding.paths[0])).toEqual([small]);
});

test("downloads: stale files are medium, and a partial turns low once a day old", async () => {
  const downloads = join(home, "Downloads");
  mkdirSync(downloads, { recursive: true });
  const stale = join(downloads, "old.tar.gz");
  const fresh = join(downloads, "new.zip");
  const oldPartial = join(downloads, "video.crdownload");
  const freshPartial = join(downloads, "dl.part");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "x");
  writeFileSync(oldPartial, "x");
  writeFileSync(freshPartial, "x");
  age(stale);
  age(oldPartial);
  const { findings } = await scan(ctx, ["downloads"]);
  const byName = Object.fromEntries(findings.map((finding) => [finding.paths[0]?.split("/").pop(), finding]));
  expect(byName["old.tar.gz"]).toMatchObject({ risk: "medium" });
  expect(byName["new.zip"]).toBeUndefined();
  expect(byName["video.crdownload"]).toMatchObject({ risk: "low" });
  expect(byName["dl.part"]).toMatchObject({ risk: "medium" });
});

test("screenshots: only stale images in a screenshots folder are offered", async () => {
  const shots = join(home, "Pictures", "Screenshots");
  mkdirSync(shots, { recursive: true });
  const stale = join(shots, "Screenshot.png");
  const fresh = join(shots, "Screenshot2.png");
  const notes = join(shots, "notes.txt");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "x");
  writeFileSync(notes, "x");
  age(stale);
  age(notes);
  const { findings } = await scan(ctx, ["screenshots"]);
  expect(findings.map((finding) => finding.paths[0])).toEqual([stale]);
  expect(findings[0]).toMatchObject({ risk: "medium" });
});

test("duplicates: identical copies are offered once, keeping the newest", async () => {
  const docs = join(home, "docs");
  const backup = join(home, "backup");
  mkdirSync(docs, { recursive: true });
  mkdirSync(backup, { recursive: true });
  const older = join(docs, "report.pdf");
  const newer = join(backup, "report.pdf");
  writeFileSync(older, "same content");
  writeFileSync(newer, "same content");
  age(older);
  age(newer, new Date(Date.now() - 1 * day));
  const { findings } = await scan(ctx, ["duplicates"]);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.paths[0]).toBe(older);
  expect(findings[0]?.reason).toContain("keeper keeps");
  expect(findings[0]).toMatchObject({ risk: "medium" });
});

test("duplicates: every extra copy is a finding, never the kept one", async () => {
  const a = join(home, "a.txt");
  const b = join(home, "b.txt");
  const c = join(home, "c.txt");
  for (const path of [a, b, c]) writeFileSync(path, "same");
  age(a, new Date(Date.now() - 1 * day));
  age(b, new Date(Date.now() - 2 * day));
  age(c, new Date(Date.now() - 3 * day));
  const { findings } = await scan(ctx, ["duplicates"]);
  expect(findings.map((finding) => finding.paths[0]).sort()).toEqual([b, c]);
});

test("duplicates: hard links and files inside git repos are skipped", async () => {
  const linked = join(home, "a.bin");
  const link = join(home, "b.bin");
  writeFileSync(linked, "x");
  linkSync(linked, link);
  const repo = join(home, "project");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const outside = join(home, "outside.bin");
  const inside = join(repo, "inside.bin");
  writeFileSync(outside, "dup");
  writeFileSync(inside, "dup");
  expect((await scan(ctx, ["duplicates"])).findings).toEqual([]);
});
