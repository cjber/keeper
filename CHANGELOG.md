# Changelog

What changed in each release, in the terms someone using keeper would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version's entry is also its GitHub release notes.

## [Unreleased]

- **Finds what tests and agents leave in the temp dir.** The new `tmp` category offers your entries in `$TMPDIR` or
  `/tmp` once nothing in them has changed for a day and no process has a file, working directory or listening socket
  there. Claude Code's temp dir is judged per session, and a session that is still running is left alone. Each finding
  reports `inodes` as well as bytes, because a tmpfs quota often runs out of inodes first, and thousands of leaked
  `mkdtemp` directories are one finding per name pattern. `keeper auto` applies it, since it is low risk.
- **Large plans move faster.** Apply and undo move paths in batches, so a finding with thousands of paths takes seconds
  rather than minutes.
- **`keeper --help` points agents to the skill.** It names `npx skills add cjber/keeper`, and keeper.cjber.dev serves
  an `llms.txt` for agents.

## [0.2.1] - 2026-11-02

- **AUR publishes before npm.** The release workflow renders and pushes the AUR packages before it publishes to npm, so
  a npm trusted-publisher problem can no longer skip them.
- **On npm.** `npx @cillianb/keeper` and `npm i -g @cillianb/keeper` install this release, with the same
  features as 0.2.0.

## [0.2.0] - 2026-11-02

- **The wizard groups long scans.** Findings are listed under their category with a count and size, a category with
  many rows starts folded, `h`/`l` folds or expands it, `pgup`/`pgdn` pages through the list, and the header shows the
  position. `space` on a category header selects the whole section.

## [0.1.0] - 2026-11-02

First release.

- **Finds what agents leave behind.** Stale worktrees, AUR clones, the pacman cache, orphaned packages, agent output,
  git-ignored build output, old transcripts, package manager caches, Docker leftovers, Timeshift snapshots and
  oversized logs, plus CPU load and memory pressure.
- **Google Files style cleanup, kept off the bulk sweep.** Unused apps, large stale files, old downloads and installer
  leftovers, screenshots and duplicate files are each their own scan category. Apps are only packages with a
  `.desktop` launcher, judged from a last-seen ledger that `keeper sample` records hourly from running processes,
  never from atime. The ledger keeps each hour it sampled, so a timer that stopped or a machine that was off leaves a
  gap and extends the window rather than counting as watched. Until the window is covered the first run shows only the
  largest unseen apps as candidates, quiet and still removable by id, so a big app can go before 90 days. Large files
  and duplicates skip application trees such as Wine prefixes, game libraries, flatpak data and VM stores, and
  duplicates are offered only across different personal document folders. All five categories need an explicit id, so
  `keeper plan --max-risk medium` never takes them in bulk.
- **Proves a worktree finished before it counts as low risk.** A merged pull request that holds every local commit, or
  every commit on the default branch. Repositories with more than 1000 pull requests are covered too. Uncommitted files, unpushed commits, an open pull request, a running process or an
  unfinished rebase, merge, bisect or cherry-pick blocks it.
- **Undoable by default.** Paths move to a trash, `keeper undo` restores them, and `keeper purge` deletes them for good
  and reports the space it measured as freed. Purge deletes a worktree's local branch only if it has not moved, and
  runs an optional `purgeHook`.
- **Leaves data it cannot recreate to a person.** Unused Docker volumes are reported with their Compose projects, never
  removed.
- **Agent first.** JSON output when piped, one error shape, exit codes that name the next step, `keeper hold` and
  `keeper claim` for declaring intent, and `keeper schema` for the whole interface.
- **A terminal wizard** that lists what you can act on first, colours risk and category with your terminal theme's
  palette, and opens in about a second by rescanning only the categories that are due. `g` switches to the disk each
  category holds, with why the rest waits, and to a line of free space over time marked with each apply, purge and
  undo. `r` rescans all.
- **Says how to unblock.** Every blocker names its next step: push the commits, merge or close the PR, wait out the
  age window, or `keeper release` the hold.
- **Free space history.** keeper records free space whenever it runs and hourly with the timer, and
  `keeper history` returns the readings and events as JSON.
- **Light on a busy machine.** Scans run a few processes at a time and walk large directories outside the process, so
  the wizard stays responsive under heavy load. Each category is kept for as long as it stays useful, from never for
  load to six hours for package caches, and `keeper scan --cached` reuses them. Applying rescans only its plan's
  categories.
- **Runs nightly** with `keeper timer install`, applying only low-risk findings. A failed run raises a desktop
  notification, and `keeper status` says whether the nightly runs are healthy and, if not, why.
- **Install from the AUR, npm or as an agent skill**: `paru -S keeper-bin`, `npm i -g @cillianb/keeper`, or
  `npx skills add cjber/keeper`.
