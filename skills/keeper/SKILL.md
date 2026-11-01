---
name: keeper
description: Free disk space or clean up an Arch machine with the keeper CLI, covering stale worktrees, AUR clones, package caches, orphans, build output and agent leftovers. Use for 'disk full', 'clean up my machine', or removing leftover agent files.
---

# keeper

Run `keeper --help` for the command list. Output is JSON when piped.

1. Run `keeper scan`. Findings with empty `blockers` and an action other than `report` are eligible.
2. Run `keeper plan`, adding `--max-risk medium` only when the user approved worktree or package removal.
3. Show the user the plan's size and items, then run `keeper apply PLAN --yes`.
4. Done when exit code is 0. On 5, scan again and report what changed. On 4, make a new plan.

Treat a blocker as final: never remove a blocked path by hand. Exit code 3 means `--yes` is missing, and that needs the user's approval when the plan includes medium-risk items.
