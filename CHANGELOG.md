# Changelog

What changed in each release, in the terms someone using keeper would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version's entry is also its GitHub release notes.

## [Unreleased]

- **`keeper scan`, `plan` and `apply` are much faster.** The agent and build scans no longer measure output that is
  inside its idle window or held, which was most of a scan's time: on a machine with about 300G of recent agent
  scratch and build output, those two categories went from over a minute to under a second. A blocked agent or build
  row now shows its size as `?`, as a blocked worktree already did. The wizard still measures everything, so its
  space bars keep showing what is waiting.

## [0.4.2] - 2026-11-09

- **An abandoned process that keeps logging is offered for stopping.** The memory scan used to count writes to a
  process's own stdout and stderr as work, so a detached child that retries forever, such as a tunnel whose app quit,
  looked busy as long as it kept appending to the log its supervisor opened. Only writes to other files now keep a
  process from being offered.

## [0.4.1] - 2026-11-08

- **A worktree scan no longer measures every worktree.** Only worktrees that could be planned are sized, and at most
  two `du` walks run at once. Sizing all of several hundred worktrees, eight at a time, kept the machine at a load of
  45 even at idle priority, because the walking happens in the kernel. A blocked worktree now shows its size as `?`.
## [0.4.0] - 2026-11-08

- **A hold lasts one day.** `keeper hold` protects a path for 1 day, and `--days` can only shorten that. Holds made
  by older versions lapse a day after the audit log says they were made, so the week-long holds left by finished agent
  sessions no longer keep most worktrees from ever being offered. An older hold missing from the audit log keeps its
  end date, and the scan warns about it.

## [0.3.2] - 2026-11-08

- **keeper no longer slows down the apps you are using.** Every command now runs at the lowest CPU priority and idle
  disk priority, and the du and git calls a scan starts inherit both. Several agents scanning at once on a busy
  machine used to push the load past 60 on 16 cores; now keeper only uses time the rest of the machine leaves free.

## [0.3.1] - 2026-11-05

- **Finding ids stay the same between scans.** An id now names the thing, such as a worktree's path, rather than its
  state, so ids collected from one scan still work in `keeper plan` minutes later. Each finding also carries a `state`,
  and `apply` still refuses anything whose state moved since it was planned. Plans saved by older versions apply
  nothing, so plan again after upgrading.
- **One bad id no longer aborts a plan.** `keeper plan ID...` skips an id that is gone or blocked, lists each one under
  `skipped` with its reason, plans the rest and exits 5. It fails only when no id could be planned.
- **A failed pull request lookup is reported, not read as "no pull requests".** On a busy machine one failed
  `gh pr list` used to drop the merged proof of every worktree in that repo without a word. The lookup is now retried
  twice, then the scan warns once naming the repo, its worktrees get a blocker saying their pull requests could not be
  listed, and that incomplete result is never reused from the cache. A repo gh cannot serve at all (gh missing, not
  logged in, no GitHub remote) still has no proof and no warning.

## [0.3.0] - 2026-11-04

- **Abandoned processes holding memory are offered for stopping.** The memory scan now names long-lived idle processes
  nobody can reach, such as a test fixture whose runner was killed before its cleanup ran, with the RAM and swap each
  holds. Every signal is required: detached (reparented to init, or to a multiplexer server after its pane closed),
  no CPU over the sample, over 6 hours old, and its script deleted or no file written for 6 hours. Each is a `stop`
  finding (SIGTERM, then SIGKILL), medium risk and planned only by its id. Shells, editors, multiplexer servers,
  systemd services, desktop autostarts and held paths are never offered.
- **Scratch clones can be claimed.** `keeper claim` accepts a git clone under `~/.cache/agent-scratch` or a configured
  agent root, and it is cleaned like any claimed scratch: trashed once stale, restorable with `keeper undo`. A
  repository anywhere else is still refused, now with a message that says it is a repository rather than "too broad".
- **Planning load findings by id is fast.** Load and memory findings are now remembered, though never reused, so
  `keeper plan LOAD-ID...` rescans only the load category instead of every category on the machine. Apply still rescans
  every id it runs.
- **New children stay deprioritised with autogroup off.** A load finding also lowers the session process its work
  hangs from, such as an agent or a pane's shell, so the test runners and linters it starts next inherit the low
  priority. The desktop session and the session that ran keeper are never lowered.
- **Orphans whose terminal closed are offered for stopping.** A process reparented to init, whose stdin is a terminal
  that no longer exists, and that has kept a quarter of a core busy for 30 minutes is a `stop` finding (SIGTERM, then
  SIGKILL), on a quiet machine too. It is medium risk and planned only by its id, and it no longer hides in a renice row.
- **Renice works under autogroup.** With `/proc/sys/kernel/sched_autogroup_enabled` on, the scheduler shares CPU
  between sessions first, so a process's own nice barely moved CPU. A load finding now also lowers its session's
  autogroup, never the desktop's or the caller's, and undo puts the autogroup back.
- **The temp scan leaves a running display alone.** X and session files such as `/tmp/.X1-lock` and `/tmp/.X11-unix`
  are never offered, and any lock file whose PID is still alive is blocked until that process exits.
- **Load findings name the right work.** A group is one command within one process tree, so a dev server in one pane
  and a test run in another, or two agent sessions, are separate rows that renice separately. The session that ran
  keeper is blocked, as keeper itself already was.
- **Busy builds are named even when every worker is young.** A group also counts once its members have used two
  core-minutes, so a build that keeps starting fresh workers is no longer missed.
- **No kernel threads in load findings.** `[kswapd0]` and `[kworker/...]` are left out instead of showing as blocked.
- **Steadier CPU readings.** Load is sampled over a second rather than 200 ms, and `keeper scan --cached` says when
  load or memory were scanned now because they are never cached.
- **Commands refuse options they do not take.** `keeper claim PATH --reason R` used to succeed and drop the reason; it
  now exits with a usage error, as does any option a command does not read.

## [0.2.2] - 2026-11-04

- **A worktree whose PR a bot rebased before merging is proven.** When the merged PR's head is not the local commit,
  keeper compares content: if every file the local commits changed is identical in the PR's merge commit, the
  worktree is finished, so it no longer stays blocked as commits on no remote.
- **Planning by id rescans only what it needs.** `keeper plan ID` rescans just the categories that held those ids in
  the last scan, so a single finding plans in the time its own category takes, without `--category`.
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
