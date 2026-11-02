import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppPackage,
  appCandidates,
  appFindings,
  type Context,
  defaultConfig,
  insideAppTree,
  launcherOwners,
  scan,
} from "./scanners";
import { defaultPaths } from "./system";
import { bulkEligible, eligible } from "./types";
import { coveredDays, readUsage, recordUsage, type UsageLedger } from "./usage";

let home: string;
let ctx: Context;
const day = 86_400_000;
const old = new Date(Date.now() - 30 * day);

const pkg = (name: string, overrides: Partial<AppPackage> = {}): AppPackage => ({
  name,
  bytes: 1024 ** 2,
  requiredBy: [],
  groups: [],
  paths: [`/usr/share/applications/${name}.desktop`],
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

/** A ledger with one sample on each of the last `days` days, so coverage is exactly those days. */
function usageWithDays(days: number, missing: readonly number[] = [], now = Date.now()): UsageLedger {
  const samples: Record<string, string> = {};
  for (let back = 0; back < days; back++) {
    if (missing.includes(back)) continue;
    const at = new Date(now - back * day).toISOString();
    samples[at.slice(0, 13)] = at;
  }
  const first = Object.values(samples).sort()[0] ?? new Date(now).toISOString();
  return { since: first, sampledAt: new Date(now).toISOString(), samples, packages: {} };
}

const coveredUsage = (): UsageLedger => usageWithDays(100);

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
  expect(findings[0]).toMatchObject({
    category: "apps",
    action: "remove-packages",
    risk: "medium",
    blockers: [],
    explicit: true,
  });
  expect(findings[0]?.title).toBe("firefox");
  expect(findings[0] && eligible(findings[0])).toBe(true);
  expect(findings[0] && bulkEligible(findings[0])).toBe(false);
});

test("apps: use is judged from the ledger, never atime, so a package seen running is left alone", () => {
  const usage = coveredUsage();
  usage.packages.firefox = new Date(Date.now() - 1 * day).toISOString();
  expect(appFindings([pkg("firefox")], usage, Date.now(), 90)).toEqual([]);
});

test("apps: with no samples yet, nothing is offered, so a first run is quiet", () => {
  expect(appFindings([pkg("firefox")], undefined, Date.now(), 90)).toEqual([]);
});

test("apps: before the window is covered the largest unseen apps are quiet candidates, not blocked", () => {
  const tiny = pkg("tiny", { bytes: 10 * 1024 ** 2 });
  const big = pkg("big", { bytes: 2 * 1024 ** 3 });
  const findings = appFindings([tiny, big], usageWithDays(3), Date.now(), 90);
  expect(findings.map((finding) => finding.title)).toEqual(["big", "tiny"]);
  expect(findings[0]).toMatchObject({ explicit: true, blockers: [] });
  expect(findings[0] && eligible(findings[0])).toBe(true);
  expect(findings[0] && bulkEligible(findings[0])).toBe(false);
  expect(findings[0]?.reason).toContain("Candidate");
  expect(findings[0]?.reason).toContain("3 days");
});

test("apps: the learning list is capped, so a first run stays short", () => {
  const many = Array.from({ length: 30 }, (_, index) => pkg(`app${index}`, { bytes: (index + 1) * 1024 ** 2 }));
  const findings = appFindings(many, usageWithDays(3), Date.now(), 90);
  expect(findings).toHaveLength(15);
  expect(findings[0]?.title).toBe("app29");
});

test("apps: a gap in samples extends the window instead of counting as watched", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const usage = usageWithDays(10, [3, 4], now); // Ten days of samples with two days missing in the middle.
  expect(coveredDays(usage, now)).toBe(3);
  const [finding] = appFindings([pkg("firefox")], usage, now, 90);
  expect(finding?.reason).toContain("3 days");
  expect(finding && eligible(finding)).toBe(true);
});

test("apps: only a .desktop launcher makes a package an app", () => {
  const metadata = new Map([
    ["firefox", { bytes: 1, requiredBy: [], groups: [] }],
    ["git", { bytes: 1, requiredBy: [], groups: [] }],
  ]);
  const files = new Map([
    ["firefox", ["/usr/share/applications/firefox.desktop", "/usr/bin/firefox"]],
    ["git", ["/usr/bin/git"]],
  ]);
  expect(appCandidates(["firefox", "git"], metadata, files).map((app) => app.name)).toEqual(["firefox"]);
});

test("apps: launcherOwners maps only .desktop files to their package", () => {
  const owners = launcherOwners([
    "/usr/share/applications/firefox.desktop is owned by firefox 1.0-1",
    "/usr/bin/firefox is owned by firefox 1.0-1",
    "/usr/share/applications/kde/foo.desktop is owned by foo 2.0-1",
  ]);
  expect([...owners.keys()].sort()).toEqual(["firefox", "foo"]);
  expect(owners.get("firefox")).toEqual(["/usr/share/applications/firefox.desktop"]);
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
  expect(Object.keys(ledger?.samples ?? {})).toHaveLength(1);
});

test("recordUsage keeps each hour bucket, and a gap is visible in the coverage", async () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  await recordUsage(ctx.paths, { executables: [], now });
  await recordUsage(ctx.paths, { executables: [], now: now + 2 * day });
  const ledger = readUsage(ctx.paths) as UsageLedger;
  expect(Object.keys(ledger.samples ?? {})).toHaveLength(2);
  expect(coveredDays(ledger, now + 2 * day)).toBe(1);
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
  expect(findings[0]).toMatchObject({ risk: "medium", action: "trash", explicit: true });
  expect(findings[0] && bulkEligible(findings[0])).toBe(false);
});

test("large: game, Wine, Steam, GOG, Heroic, flatpak and VM trees are never offered", async () => {
  const personal = join(home, "Documents", "huge.iso");
  const witcher = join(home, "Games", "GOG", "The Witcher 3", "content", "content0", "texture.cache");
  const movies = join(home, "Games", "GOG", "The Witcher 3", "content", "movies.bundle");
  const speech = join(home, "Games", "GOG", "The Witcher 3", "content", "content0", "audio.w3speech");
  const wine = join(home, "prefixes", "battlenet", "drive_c", "windows", "system32", "big.dll");
  const steam = join(home, "SteamLibrary", "steamapps", "common", "game", "data.pak");
  const heroic = join(home, "Heroic", "Games", "game", "content.toc");
  const flatpak = join(home, "flatpak", "app", "org.example.App", "data.bin");
  const vm = join(home, "VirtualBox VMs", "arch", "disk.vdi");
  const marker = join(home, "installs", "some-game", "archive.bundle");
  for (const path of [personal, witcher, movies, speech, wine, steam, heroic, flatpak, vm, marker]) {
    bigFile(path, 600 * 1024 ** 2);
  }
  const { findings } = await scan(ctx, ["large"]);
  expect(findings.map((finding) => finding.paths[0])).toEqual([personal]);
});

test("insideAppTree recognises a Wine prefix by drive_c or system.reg", () => {
  const prefix = join(home, "battlenet");
  mkdirSync(join(prefix, "drive_c"), { recursive: true });
  expect(insideAppTree(join(prefix, "drive_c", "windows", "a.dll"), home)).toBe(true);
  const other = join(home, "plain");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "system.reg"), "x");
  expect(insideAppTree(join(other, "notes.txt"), home)).toBe(true);
  const documents = join(home, "Documents");
  mkdirSync(documents, { recursive: true });
  writeFileSync(join(documents, "notes.txt"), "x");
  expect(insideAppTree(join(documents, "notes.txt"), home)).toBe(false);
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
  expect(findings[0]).toMatchObject({ risk: "medium", explicit: true });
});

test("duplicates: identical copies are offered once, keeping the newest", async () => {
  const documents = join(home, "Documents");
  const music = join(home, "Music");
  mkdirSync(documents, { recursive: true });
  mkdirSync(music, { recursive: true });
  const older = join(documents, "report.pdf");
  const newer = join(music, "report.pdf");
  writeFileSync(older, "same content");
  writeFileSync(newer, "same content");
  age(older);
  age(newer, new Date(Date.now() - 1 * day));
  const { findings } = await scan(ctx, ["duplicates"]);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.paths[0]).toBe(older);
  expect(findings[0]?.reason).toContain("keeper keeps");
  expect(findings[0]).toMatchObject({ risk: "medium", explicit: true });
});

test("duplicates: every extra copy is a finding, never the kept one", async () => {
  const a = join(home, "Documents", "a.txt");
  const b = join(home, "Music", "b.txt");
  const c = join(home, "Videos", "c.txt");
  for (const path of [a, b, c]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "same");
  }
  age(a, new Date(Date.now() - 1 * day));
  age(b, new Date(Date.now() - 2 * day));
  age(c, new Date(Date.now() - 3 * day));
  const { findings } = await scan(ctx, ["duplicates"]);
  expect(findings.map((finding) => finding.paths[0]).sort()).toEqual([b, c]);
});

test("duplicates: copies stay inside one personal tree, and application trees are skipped", async () => {
  const app = join(home, "Games", "GOG", "game", "data.dll");
  const appCopy = join(home, "Games", "GOG", "game", "system32", "data.dll");
  const sameRootA = join(home, "Documents", "same-root-a.pdf");
  const sameRootB = join(home, "Documents", "backup", "same-root-b.pdf");
  const documents = join(home, "Documents", "report.pdf");
  const downloads = join(home, "Downloads", "report.pdf");
  for (const path of [app, appCopy, sameRootA, sameRootB, documents, downloads]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, path === app || path === appCopy ? "dll" : path.includes("same-root") ? "inside" : "report");
  }
  age(app);
  age(appCopy);
  age(sameRootA);
  age(sameRootB);
  age(documents, new Date(Date.now() - 2 * day));
  age(downloads, new Date(Date.now() - 1 * day));
  const { findings } = await scan(ctx, ["duplicates"]);
  expect(findings.map((finding) => finding.paths[0])).toEqual([documents]);
});

test("duplicates: hard links and files inside git repos are skipped", async () => {
  const linked = join(home, "Documents", "a.bin");
  const link = join(home, "Music", "b.bin");
  mkdirSync(dirname(linked), { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  writeFileSync(linked, "x");
  linkSync(linked, link);
  const repo = join(home, "Documents", "project");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const outside = join(home, "Videos", "outside.bin");
  const inside = join(repo, "inside.bin");
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, "dup");
  writeFileSync(inside, "dup");
  expect((await scan(ctx, ["duplicates"])).findings).toEqual([]);
});
