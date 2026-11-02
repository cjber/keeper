<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
  <img src="assets/wordmark.svg" alt="keeper" width="360">
</picture>

**Keeps an Arch machine clean, with your agent doing the deciding.**

Finds what is safe to remove on a machine where coding agents leave worktrees, build output, caches and transcripts
behind, moves it to a trash you can undo, and proves its work before it touches anything.

[![ci](https://img.shields.io/github/actions/workflow/status/cjber/keeper/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/cjber/keeper/actions/workflows/ci.yml)
![platform](https://img.shields.io/badge/platform-arch%20linux-475569?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-475569?style=flat-square)

</div>

---

## Why keeper

- **It proves before it removes.** A worktree counts as finished only when a merged pull request holds every commit
  it has, or when every commit is on the default branch. Anything else waits for approval.
- **Agents are the primary user.** Every command returns JSON when piped, each exit code names the next step, and the
  wizard is a thin layer over the same calls.
- **Agents can protect their work.** `keeper hold` outranks every scanner until it expires, so a session can mark a
  worktree it will return to.
- **Nothing is final until purge.** Paths move to a trash, and `keeper undo` restores them. Local branches are deleted
  only at purge, and only if they have not moved.
- **It renices instead of killing.** When the machine is overloaded, keeper names the commands holding the CPU and can
  lower their priority, so the work survives.

## Install

```sh
paru -S keeper-bin               # standalone binary
# or: paru -S keeper             # Bun source package
# or: npm i -g @cillianb/keeper  # same binary from npm, x64 and arm64
```

`npx @cillianb/keeper scan` runs it once without installing. Install it before `keeper timer install`, so the schedule
points at a path that stays put.

## Set up with your agent

Install the skill for any agent that reads [Agent Skills](https://agentskills.io):

```sh
npx skills add cjber/keeper
```

In Claude Code you can use the plugin instead: `/plugin marketplace add cjber/keeper`, then `/plugin install keeper@keeper`.
If keeper itself is missing, the skill asks before installing it. Then give your agent this prompt:

```text
Run keeper status, then keeper scan. Show me what is eligible and what is blocked, and why.
Plan the low-risk items, then ask me before applying anything else.
```

The skill is at [`skills/keeper/SKILL.md`](skills/keeper/SKILL.md). The source package also installs it to
`/usr/lib/keeper/skills`, and the binary package to `/usr/share/doc/keeper-bin/skills`.

## How it works

```text
keeper scan              Code, no model. Read-only: every finding, with its blockers
     |
     v
agent review             LLM agent, optional. Reads PRs and history, adds keeper hold on unfinished work
     |
     v
keeper plan              Code. Saves the eligible findings you chose
     |
     v
keeper apply PLAN --yes  Code. Rescans, and skips anything that changed since the plan
     |
     v
trash                    keeper undo TX restores. keeper purge deletes for good after 14 days
```

An agent can only add a blocker. It has no way to clear one, so a bad judgement can keep a file but never lose one.
Each finding's id is a hash of the state that was judged, so approval covers that state and nothing newer.

## Sizes and freed space

Sizes in scans and plans are uncompressed. On btrfs with compression, removing a directory can free far less than its
size, and worktree build output often stores in under a third of it. Trash sits on the same disk, so nothing is freed
until `keeper purge`, which reports the measured change in free space as `freed`.

## What it finds

| Category | Finds | Risk |
| --- | --- | --- |
| `worktree` | Clean, pushed worktrees and stray directories in a worktree root | low with proof, otherwise medium |
| `aur` | Clones of uninstalled packages, and build output in the others | low |
| `pacman-cache` | Old package versions, keeping the newest | low |
| `orphans` | Dependencies nothing requires | medium |
| `agent` | Output in configured roots, and paths agents claimed as scratch | low |
| `build` | Git-ignored `target`, `node_modules`, `.next`, `.turbo` and `.venv` with no file written for 3 days | low |
| `transcripts` | Claude Code and Codex transcripts over 14 days old | low |
| `package-cache` | Unreferenced uv and pnpm entries, and npm and bun caches over 2G | low |
| `docker` | Dangling images and build cache unused for 7 days; unused volumes are reported only | low, volumes report only |
| `logs` | Configured logs over 50M, cut to their last 5M | low |
| `snapshots` | Timeshift snapshots, which keep deleted data on disk | report only |
| `apps` | Explicitly installed packages that ship a launcher or `/usr/bin` binary and were not seen running for 90 days | medium |
| `large` | Files over 500M under `$HOME`, stale, outside git repos, dotdirs, downloads and screenshots | medium |
| `downloads` | Stale downloads, finished installers, and partials (partials over a day old are low) | low or medium |
| `screenshots` | Stale images in the Pictures `Screenshots` and grim/hyprshot folders | medium |
| `duplicates` | Identical files under `$HOME`, keeping the newest copy and offering the rest | medium |
| `load` | Commands holding the CPU while the machine is oversubscribed | medium |
| `memory` | Cgroups at their `memory.high` cap, and memory pressure | report only |

These block a worktree whatever its age: uncommitted files, commits on no remote, a running process inside it, an open
pull request, a rebase, merge, bisect or cherry-pick in progress, and any hold.

## Blocked findings

A blocked finding is something keeper found but will not touch yet, because something says the work there may still
matter. Each blocker names what to do about it:

| Blocker | To resolve it |
| --- | --- |
| Touched recently | Wait. It is offered once idle for the age window, 7 days by default, or `--stale-days N` |
| Built recently | Wait. Build output is offered after 3 days without a build. It counts as build, not as its worktree |
| Uncommitted or untracked files | Commit, stash or delete them |
| Commits on no remote | Push them to keep the work. Once every commit is on the default branch it becomes low risk |
| An open pull request | Merge or close it |
| In use by a running process | Quit what runs there |
| A rebase, merge, bisect or cherry-pick | Finish or abort it |
| Held | `keeper release PATH` ends the hold early |
| A tool or package operation running | It is offered once that finishes |

keeper never clears a blocker for you, and a blocked path is never removed by hand on its behalf. Press `b` in the
wizard to list blocked findings, or read `blockers` in `keeper scan`.

## Scans and history

A full scan takes seconds to minutes on a busy machine, so each category's findings are kept for as long as they stay
useful, and `keeper scan --cached` or the wizard reuse them:

| Kept for | Categories |
| --- | --- |
| Never, always scanned | `load`, `memory` |
| 15 minutes | `worktree` |
| 1 hour | `build`, `agent`, `transcripts`, `logs`, `docker`, `downloads`, `screenshots` |
| 6 hours | `aur`, `pacman-cache`, `orphans`, `package-cache`, `snapshots`, `apps`, `large`, `duplicates` |

Applying rescans the categories in its plan first, so a kept finding can never be what decides a removal, and applying,
undoing or claiming drops the categories it changed. Holds are applied on every read. `keeper scan` without `--cached`
always scans everything.

keeper records free space whenever it scans or changes something, at most every 10 minutes, and hourly once the timer
is installed. `keeper history` returns those readings with the applies, purges, undos and nightly runs, and the
wizard draws them.

The `apps` category reads a last-seen ledger that `keeper sample` records hourly: which executables are running, folded
to their owning package. Use is never judged from atime. A package counts as unused only when the ledger has existed
for the whole `--app-stale-days` window (default 90) and it was not seen in it, so a fresh install shows each candidate
as blocked until it has watched long enough.

## Commands

| Command | What it does |
| --- | --- |
| `keeper` | Opens the wizard (terminal only) |
| `keeper status` | Free space, schedule, last run and whether the nightly runs are healthy, holds, trash and missing tools |
| `keeper scan` | Lists findings and their blockers. `--cached` reuses recently scanned categories |
| `keeper plan` | Saves a plan of eligible findings. Add `--max-risk medium` once medium risk is approved |
| `keeper apply PLAN --yes` | Rescans, then applies what is unchanged |
| `keeper undo TX` | Restores a transaction from trash |
| `keeper purge` | Deletes trash over 14 days old for good |
| `keeper hold PATH --reason R` | Protects a path for 7 days, or `--days N` |
| `keeper claim PATH` | Declares your own scratch disposable once stale |
| `keeper release PATH` | Drops a hold or claim |
| `keeper log` | Shows recent mutations and who made them |
| `keeper history` | Free space readings and the events that changed it, over 30 days or `--days N` |
| `keeper sample` | Records free space and which executables are running, as the hourly timer does |
| `keeper schema` | Describes the CLI as JSON |
| `keeper auto` | Applies low-risk findings, purges old trash and notifies |
| `keeper timer install` | Schedules `keeper auto` daily and `keeper sample` hourly with systemd, or `--cron` |
| `keeper timer remove` | Removes the schedule |

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Error |
| 2 | Usage error |
| 3 | Needs `--yes`, which needs someone's approval |
| 4 | The whole plan is stale, so make a new one |
| 5 | Partly applied, so scan again |
| 6 | Another run holds the lock, so retry |

Set `KEEPER_ACTOR` to name yourself in holds, claims and the log.

## Configuration

keeper runs with no configuration. Everything is optional in `~/.config/keeper/config.toml`, and an unknown key is an
error:

```toml
# Directories of git checkouts whose ignored build output may be cleaned.
repoRoots = ["~/code"]
# Directories that hold worktrees. Default: ~/.worktrees
worktreeRoots = ["~/.worktrees"]
# AUR helper clones. Default: the paru and yay caches
aurClones = ["~/.cache/paru/clone"]
# Directories that hold only disposable agent output.
agentRoots = ["~/.cache/agent-runs"]
# Regular expressions matched against entry names directly under ~/.cache.
agentCachePatterns = ["^pr\\d+-venv$"]
# Appended logs that nothing rotates.
logs = ["~/scripts/backup.log"]
# Notify below this much free space. Default: 20
warnFreeGb = 20
# Files under $HOME this large or more are offered by `large` once stale. Default: 524288000 (500M)
largeBytes = 524288000
# Run before a worktree is deleted for good, with its trashed path then its original path.
purgeHook = "~/bin/drop-worktree-db"
# Have keeper auto return main checkouts to the default branch and fast-forward them.
freshen = false

# Wizard colours, as #rrggbb or a palette name such as cyan or brightred. Palette names use
# your terminal theme's own colours. Empty is the terminal foreground: reverse video for the
# cursor and dim text for blocked rows. These are the defaults:
[theme]
cursor = ""
cursorText = ""
selected = "green"
blocked = ""
accent = "cyan"
size = ""
category = "blue"
low = "green"
medium = "yellow"
high = "red"
```

If `purgeHook` exits non-zero, that transaction stays in the trash and purge tries again next time. `freshen` never
resets, rebases or stashes, and leaves a checkout alone when tracked files changed or a branch has unpushed commits.

## Requirements

`git` and `pacman-contrib`. These add evidence or actions, and `keeper status` lists any that are missing:
[`gh`](https://cli.github.com) for pull request proof, `expac` to size orphans, `notify-send` for notifications and
`uv` to prune its cache. Removing packages and running `paccache` use `sudo -n`, so they need passwordless sudo for
those commands.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
