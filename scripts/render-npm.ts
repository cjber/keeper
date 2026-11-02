/**
 * Renders the npm packages from the compiled binaries in dist/: @cjber/keeper holds a small Node launcher, and one
 * package per CPU holds its binary. npm installs only the package matching the machine through optionalDependencies,
 * so `npx @cjber/keeper` needs neither Bun nor a build step.
 */
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "dist/npm";
const pkg = await Bun.file("package.json").json();
const arches = ["x64", "arm64"] as const;
const common = {
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  repository: { type: "git", url: "git+https://github.com/cjber/keeper.git" },
  homepage: "https://keeper.cjber.dev",
  os: ["linux"],
};

const launcher = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const name = "@cjber/keeper-linux-" + process.arch;
let binary;
try {
  binary = require.resolve(name + "/bin/keeper");
} catch {
  console.error("keeper: no binary for linux " + process.arch + ". Supported: ${arches.join(", ")}.");
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

rmSync(out, { recursive: true, force: true });
const main = join(out, "keeper");
mkdirSync(join(main, "bin"), { recursive: true });
writeFileSync(join(main, "bin/keeper.js"), launcher, { mode: 0o755 });
copyFileSync("README.md", join(main, "README.md"));
copyFileSync("LICENSE", join(main, "LICENSE"));
writeFileSync(
  join(main, "package.json"),
  `${JSON.stringify(
    {
      name: "@cjber/keeper",
      ...common,
      bin: { keeper: "bin/keeper.js" },
      optionalDependencies: Object.fromEntries(arches.map((a) => [`@cjber/keeper-linux-${a}`, pkg.version])),
    },
    null,
    2,
  )}\n`,
);

for (const arch of arches) {
  const dir = join(out, `keeper-linux-${arch}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(`dist/keeper-linux-${arch}`, join(dir, "bin/keeper"));
  chmodSync(join(dir, "bin/keeper"), 0o755);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `@cjber/keeper-linux-${arch}`, ...common, cpu: [arch], preferUnplugged: true }, null, 2)}\n`,
  );
}
