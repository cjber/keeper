# keeper

Finds disposable data on an Arch machine and removes it through a reviewable plan. The CLI is the primary surface. The wizard is a thin layer over the same functions.

## Commands

```sh
bun install --frozen-lockfile
bun run gate
bunx biome ci .
bunx tsc --noEmit
bun test
bun scripts/changelog.ts --check
bun install --frozen-lockfile --os linux --cpu "*" --libc "*" && bun scripts/build.ts
bun scripts/smoke-binary.ts dist/keeper-linux-x64
```

`bun run gate` runs the first group in one command. Building needs the second install, because a compiled binary embeds
every platform's native package. CI also runs actionlint, zizmor, gitleaks and the binary package install on Arch.
Every version needs a `CHANGELOG.md` entry. `python3 scripts/wordmark.py` regenerates `assets/` from Liberation Sans.

## Layout

- `src/scanners.ts`: read-only findings and their blockers
- `src/ops.ts`: plans, apply, trash, undo, purge
- `src/ledger.ts`: holds, claims, audit log, lock
- `src/usage.ts`: last-seen ledger of running executables, folded to packages; written by `keeper sample`, read by `apps`
- `src/cli.ts`: argument parsing, output, exit codes
- `src/freshen.ts`: returns main checkouts to the default branch and fast-forwards them
- `src/timer.ts`: systemd and cron schedules
- `src/wizard.tsx`: selection UI, with no safety rules of its own

## Rules

- Scanners never write. Run git with `--no-optional-locks`, because `git status` otherwise refreshes the index and destroys the activity signal.
- A safety rule belongs in a scanner as a blocker, so agents, the timer and the wizard all get it.
- Do not treat atime, or the git index mtime, as evidence of use.
- `apply` rescans and matches ids. Never add a path that skips that check.
- Only low-risk findings may run unattended. A worktree is low risk only with proof, and packages stay behind approval.
- A merged PR proves a worktree only when its head is the local commit, or holds it as an ancestor while the checkout has unpushed commits, because branch names get reused. Only that proof outruns the age window: a branch just cut from main is contained in main too.
- keeper never starts an LLM. The calling agent judges, and a hold is the only verdict it can give, so judgement can add a blocker but never clear one.
- An agent's hold beats every scanner. Mutations go through `withLock` and write to the audit log.
- Delete through trash. Only `purge` is final, so branch deletion and `purgeHook` run there.
- Tests pass an empty environment to `defaultPaths`, so `XDG_*` cannot point them at real config.
