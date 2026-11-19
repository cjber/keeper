# keeper

Finds disposable data on an Arch machine and removes it through a reviewable plan. The CLI is the primary surface. The wizard is a thin layer over the same functions.

## Commands

- `bun install --frozen-lockfile`, then `bun run gate`: biome, tsc, tests and the changelog check.
- `bun run gate:changed`: the same, linting only files changed against `origin/main` and running the tests they reach.
- Build: `bun install --frozen-lockfile --os linux --cpu "*" --libc "*" && bun scripts/build.ts`, because a compiled
  binary embeds every platform's native package. Then `bun scripts/smoke-binary.ts dist/keeper-linux-x64`.
- Every version needs a `CHANGELOG.md` entry. `python3 scripts/wordmark.py` regenerates `assets/`.
- CI also runs actionlint, zizmor, gitleaks and the binary package install on Arch.

## Layout

- `src/scanners.ts`: read-only findings and their blockers
- `src/ops.ts`: plans, apply and deletion, and emptying the trash older versions kept
- `src/ledger.ts`: holds, claims, audit log, lock
- `src/usage.ts`: last-seen ledger of running executables, folded to packages; written by `keeper sample`, read by `apps`; coverage comes from the hours actually sampled, never from `since`
- `src/cli.ts`: argument parsing, output, exit codes
- `src/freshen.ts`: returns main checkouts to the default branch and fast-forwards them
- `src/timer.ts`: systemd and cron schedules
- `src/wizard.tsx`: selection UI, with no safety rules of its own

## Rules

- Scanners never write. Run git with `--no-optional-locks`, because `git status` otherwise refreshes the index and destroys the activity signal.
- A safety rule belongs in a scanner as a blocker, so agents, the timer and the wizard all get it.
- Do not treat atime, or the git index mtime, as evidence of use.
- A finding's id is its category and target; its `state` is what was judged. `apply` rescans and matches both id and
  state. Never add a path that skips that check.
- A failed lookup is a warning and a blocker, never an empty answer: a missing PR list must not read as "no PRs".
- Only low-risk findings may run unattended. A worktree is low risk only with proof, and packages stay behind approval.
- Apps and personal files (`apps`, `large`, `downloads`, `screenshots`, `duplicates`) carry `explicit`, so a plan with no ids never takes them, whatever `--max-risk` says. Only an explicit id selects them.
- `large` and `duplicates` skip application trees: Wine prefixes, Steam, Lutris, Heroic, GOG, `~/Games` style libraries, flatpak data, VM stores, and any directory holding an install marker. A duplicate is offered only across different top-level personal document folders.
- Apps are only packages with a `.desktop` launcher. A CLI-only package is out of scope, because the hourly sample rarely catches short-lived tools and daemons run as other users.
- A merged PR proves a worktree only when its head is the local commit, or holds it as an ancestor while the checkout has unpushed commits, because branch names get reused. A PR rebased before merging proves it instead when every file the local commits changed is identical in its merge commit. Only that proof outruns the age window: a branch just cut from main is contained in main too.
- keeper never starts an LLM. The calling agent judges, and a hold is the only verdict it can give, so judgement can add a blocker but never clear one.
- An agent's hold beats every scanner. Mutations go through `withLock` and write to the audit log.
- `apply` deletes for good, with no trash. Right before each deletion it re-checks for a live process and a mount
  inside the path, and runs `deleteHook` for a worktree. Every deleted path and its bytes go to the audit log.
- Tests pass an empty environment to `defaultPaths`, so `XDG_*` cannot point them at real config.

## Standards

- `repo-standards`: the RS-* requirements every cjber and agent-labs-dev repo meets; its `audit.py` checks this repo.
