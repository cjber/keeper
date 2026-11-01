/** Prepare release metadata on a PR branch, then tag the merged main commit separately. */
import packageJson from "../package.json";

const action = process.argv[2];
if (!["patch", "minor", "major", "tag"].includes(action ?? "") || process.argv.length !== 3) {
  console.error("usage: bun scripts/release.ts patch|minor|major|tag");
  process.exit(2);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function checkNotes(version: string): void {
  const notes = Bun.spawnSync(["bun", "scripts/changelog.ts", version], { stdout: "ignore", stderr: "inherit" });
  if (notes.exitCode !== 0) throw new Error(`CHANGELOG.md needs an entry for ${version}`);
}

if (git("status", "--porcelain")) throw new Error("the working tree has uncommitted changes");
if (action === "tag") {
  git("fetch", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
    throw new Error("tag the merged origin/main commit from a clean worktree");
  checkNotes(packageJson.version);
  git("tag", "-s", `v${packageJson.version}`, "-m", `keeper v${packageJson.version}`);
  console.log(`Tagged v${packageJson.version}. Run the gate, then git push origin v${packageJson.version}`);
  process.exit(0);
}

const branch = git("branch", "--show-current");
if (!branch || branch === "main") throw new Error("prepare a release on a PR branch");
const [major = 0, minor = 0, patch = 0] = packageJson.version.split(".").map(Number);
const next =
  action === "major"
    ? `${major + 1}.0.0`
    : action === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
const changelog = await Bun.file("CHANGELOG.md").text();
const released = changelog.replace(
  /^## \[Unreleased\]$/m,
  `## [Unreleased]\n\n## [${next}] - ${new Date().toISOString().slice(0, 10)}`,
);
if (released === changelog) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
await Bun.write("package.json", `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", released);
try {
  checkNotes(next);
} catch (error) {
  git("checkout", "--", "package.json", "CHANGELOG.md");
  throw error;
}
git("commit", "-S", "-m", `chore(release): prepare ${next}`, "package.json", "CHANGELOG.md");
console.log(`Prepared ${next}. Open a PR, then run bun scripts/release.ts tag from the merged commit.`);
