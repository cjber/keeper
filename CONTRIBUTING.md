# Contributing

Bug reports and pull requests are welcome. [AGENTS.md](AGENTS.md) has the layout and the rules a change must keep.

## Before you start

- **Bugs:** open an issue with the `keeper scan --json` finding involved, what you expected, and your `keeper --version`.
  A path removed that should have stayed is the most serious kind of bug, so say so in the title.
- **New scanners and larger changes:** open an issue first, so we can agree on the risk level and blockers.
- **Security issues:** report them privately, as [SECURITY.md](SECURITY.md) describes.

## Making a change

```sh
bun install --frozen-lockfile
bun run gate
```

A change needs:

- a passing gate
- a test for each new blocker, including the case that must refuse
- a line under Unreleased in `CHANGELOG.md` if a user would notice it
- matching updates to `README.md` and `skills/keeper/SKILL.md` if a command or flag changed

Tests must never touch real data. Build a scratch home as `src/keeper.test.ts` does, and pass an empty environment to
`defaultPaths`.

## Releasing

Maintainers run `bun scripts/release.ts patch|minor|major` on a branch, merge it, then run `bun scripts/release.ts tag`
on the merged commit and push the tag. The tag publishes the binaries, the GitHub release, the npm packages and both AUR
packages.

npm publishes through trusted publishing, which can only be configured on a package that exists. Before the first tag,
run `bun run npm:first-publish` while logged in to npm, then add this repository's `release.yml` as the trusted
publisher in each of the three packages' settings. The tag then skips the versions already on npm.
