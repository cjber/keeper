# keeper

Finds disposable data on an Arch machine and removes it through a reviewable plan. The CLI is the primary surface. The wizard is a thin layer over the same functions.

## Commands

```sh
bun install --frozen-lockfile
bun run gate
```

## Layout

- `src/scanners.ts`: read-only findings and their blockers
- `src/ops.ts`: plans, apply, trash, undo, purge
- `src/ledger.ts`: holds, claims, audit log, lock
- `src/cli.ts`: argument parsing, output, exit codes
- `src/timer.ts`: systemd and cron schedules
- `src/wizard.tsx`: selection UI, with no safety rules of its own

## Rules

- Scanners never write. Run git with `--no-optional-locks`, because `git status` otherwise refreshes the index and destroys the activity signal.
- A safety rule belongs in a scanner as a blocker, so agents, the timer and the wizard all get it.
- Do not treat atime, or the git index mtime, as evidence of use.
- `apply` rescans and matches ids. Never add a path that skips that check.
- Only low-risk findings may run unattended. Worktrees and packages stay behind approval.
- An agent's hold beats every scanner. Mutations go through `withLock` and write to the audit log.
- Delete through trash. Only `purge` is final.
