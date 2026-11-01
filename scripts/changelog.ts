/**
 * Print one version's CHANGELOG.md entry, which becomes that release's notes.
 *
 *   bun scripts/changelog.ts 0.1.0      # the entry (a leading v is fine)
 *   bun scripts/changelog.ts --check    # every reachable v* tag has an entry, and [Unreleased] is there
 *
 * A tag with no entry, or an empty one, fails here rather than publishing notes nobody wrote.
 */
const text = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();
const headings = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)];

function entry(version: string): string {
  const index = headings.findIndex((match) => match[1] === version);
  const heading = headings[index];
  if (!heading) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  const body = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length).trim();
  if (!body) throw new Error(`CHANGELOG.md's entry for ${version} is empty`);
  return body;
}

const [argument] = process.argv.slice(2);
if (argument === "--check") {
  if (!/^## \[Unreleased\]$/m.test(text)) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  const tags = Bun.spawnSync(["git", "tag", "--merged", "HEAD", "--list", "v*"]).stdout.toString().split("\n");
  for (const tag of tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))) entry(tag.slice(1));
} else if (argument) {
  console.log(entry(argument.replace(/^v/, "")));
} else {
  throw new Error("usage: bun scripts/changelog.ts <version> | --check");
}
