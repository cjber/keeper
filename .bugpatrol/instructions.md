# About the app

keeper is a disk cleanup CLI for Arch Linux, built for coding agents first and people second. It finds what
agents leave behind (stale git worktrees, build output, package caches, AUR clones and more), proves each item is
safe, and deletes it for good. Agents use the subcommands, which print JSON when piped. People use the
terminal wizard, which opens when `keeper` runs with no arguments in a terminal.

Every command here runs against a sandbox home at `$KEEPER_PATROL_ROOT/home`, which `app.setup` rebuilds for each
session. Stubs stand in for sudo, docker, systemctl, crontab, renice and the package managers, and log their calls to
`$KEEPER_PATROL_ROOT/stub-calls.log`. The `load` category lists the real machine's busy processes; renicing them only
calls the stub.

## Sign in

There is no sign-in.

## How to run it

Run keeper only through the sandbox wrappers, from the project root:

- `.bugpatrol/sandbox/keeper <args>` runs the CLI, for example `.bugpatrol/sandbox/keeper scan --json`.
- `.bugpatrol/sandbox/tui` drives the wizard in a private tmux terminal:
  - `.bugpatrol/sandbox/tui start 100 30` opens it at 100 columns by 30 rows and prints the first frame.
  - `.bugpatrol/sandbox/tui keys j` presses keys (tmux names: `j k space a b t q Enter Escape Down Up`) and prints
    the frame after them. A scan takes a few seconds: call `.bugpatrol/sandbox/tui show` again to see it finish.
  - `.bugpatrol/sandbox/tui show` prints the frame with its colours as ANSI escapes; `tui text` prints plain text.
  - `.bugpatrol/sandbox/tui resize 60 20` tests a narrow terminal.
  - `.bugpatrol/sandbox/tui stop` closes it.
- `.bugpatrol/sandbox/setup.sh` resets the sandbox, for example after applying everything.

## Important flows

1. **Wizard:** open it, watch the scan line at the bottom finish, move with j and k, select with space or a, apply
   with Enter, show blocked rows with b, read the explanation under the list, and quit with q. Close and reopen it:
   the second open reuses recent categories and says so, and r rescans everything.
2. **Graphs:** press g for disk by category and why it waits, then g for free space over time. The sandbox seeds a
   week of readings with nightly runs, an apply and a purge, so the chart has events to mark. g again returns to the list.
3. **Agent CLI:** `scan` (and `scan --cached`), `plan`, `apply`, `hold`, `claim`, `release`, `status`,
   `log`, `history`, `sample` and `schema`.
   Check that piped output is valid JSON, that errors share one shape with a code, a message and a next step, and
   that the exit codes match `keeper schema`.
4. **Apply:** apply a plan, then check every planned path is gone and the `deleted` list in the output and `keeper log`
   names each path with its size.

## What to check, UX first

A UX defect is a bug. For the wizard, judge each frame the way a first-time user would:

- Can you tell what each row is, what its numbers mean, and why it is blocked or offered?
- Do columns line up, and do long titles truncate cleanly at 100, 80 and 60 columns?
- Do risk colours match their words (low green, medium yellow, high red), and is the cursor row easy to find?
- Is every key the wizard reacts to shown in the key line, and does every key shown do something?
- Do the empty state, the scanning state and the messages after an action say what happened and what to do next?
- Does anything flicker, jump or leave stale text behind after a rescan, a resize or switching views with g? The key
  line must stay on the same row in every view.
- Does each blocker say what would resolve it?
- Does the chart's scale, its dates and each event mark agree with `keeper history`?

For the agent CLI, a message that leaves an agent unsure of its next step is a bug, as is JSON that differs from
`keeper schema`, or text output on a pipe.

## Never do these things

- Never run `keeper` directly, `bun src/index.tsx`, or any command outside the sandbox wrappers: the real keeper
  acts on this machine's files.
- Never change files outside the selected `KEEPER_PATROL_ROOT`.
Independent sandbox roots are isolated. Set `KEEPER_PATROL_ROOT` to a unique absolute directory for each concurrent run; it defaults to `$XDG_CACHE_HOME/keeper/patrol`. The setup resets only that named, marked directory and its `tmux.sock`, and rejects `/`, `$HOME`, symlinks, and unmarked nonempty roots.
