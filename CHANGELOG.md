# Changelog

What changed in each release, in the terms someone using keeper would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version's entry is also its GitHub release notes.

## [Unreleased]

- **Purge reports what it really freed.** `freed` is the measured change in free space, and sizes elsewhere are labelled
  uncompressed, because on btrfs with compression they can be several times what a removal gives back.

- **Worktrees can be proven finished.** A merged pull request with the same commit, or every commit on the default
  branch, makes a worktree low risk. An open pull request or an unfinished rebase, merge, bisect or cherry-pick blocks it.
- **Purge finishes the job.** It deletes a trashed worktree's local branch if the branch has not moved, and runs an
  optional `purgeHook` first.
- **Roots are configurable.** `worktreeRoots`, `aurClones`, `logs`, `warnFreeGb` and `freshen` join the config file, and
  an unknown key is now an error.
- **Build output is judged by its newest file.** A build still writing deep inside `target` keeps it.
- **`keeper status` says what to do next,** with the last run, active holds and any missing tools.
- **`keeper purge --older-days 0` always purges.** It could skip a transaction applied moments earlier.
- **`keeper undo` can be run again.** It refuses to overwrite a path that exists again, and finishes an interrupted undo.
