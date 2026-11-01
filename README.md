# keeper

keeper finds disposable data on an Arch Linux machine: stale worktrees, AUR clones, old package versions, orphaned packages, build output and agent leftovers. It also says when the machine is too loaded or too starved of memory to use. Nothing is removed until a plan is applied, and removed paths stay in trash until they are purged.

## Set up with your agent

Link `skills/keeper` into your agent's skills directory, then give it this prompt:

```text
Use keeper to free disk space on this machine. Scan, show me what is ready and what is blocked, and apply only what I approve.
```

## Use

```sh
keeper                            # open the wizard
keeper scan --stale-days 3        # list findings
keeper plan --max-risk medium     # save a plan of what is ready
keeper apply PLAN --yes           # rescan, then apply what is unchanged
keeper undo TX                    # restore a transaction
keeper purge --older-days 0       # free the space now
keeper timer install              # run keeper auto daily
```

Output is JSON when stdout is not a terminal. Run `keeper --help` for every option and exit code.

## For agents

`keeper hold PATH --reason R` protects work an agent will come back to, and `keeper claim PATH` declares its scratch as disposable. Mutations take a lock and land in `keeper log` with the actor's name. `keeper schema` describes the CLI, and JSON results carry a `next` command. `skills/keeper` holds the agent skill.

## Machine health

Two categories answer "why is this machine unusable" rather than "what can I delete". Both stay silent on a healthy machine and neither ever runs from `keeper auto`.

- `load` appears when load is above 1.25 per core. It groups processes by command, so a build storm shows up as `rustc` rather than as one anonymous pile, and its `renice` action hands the CPU back without killing anything. It is medium risk, so `keeper plan` needs `--max-risk medium`, and your desktop session is always a blocker.
- `memory` names the cgroups pinned against their `memory.high` cap and reports stall time from `/proc/pressure/memory`. It is `report` only: keeper cannot decide whose working set to drop, and the cap that is thrashing was usually set on purpose. Its size column is memory held, not space a cleanup would free.

Renicing is a one-way trip without root: raising a priority back needs privileges, so `keeper undo` tries an unprivileged `renice` and then `sudo -n`, and names any process it could not restore.

## Daily runs

`keeper auto` applies low-risk findings, purges trash over 14 days old, and sends a desktop notification when free space is low or over 10G waits for approval. Worktrees and packages are never removed unattended.

## Configuration

`~/.config/keeper/config.toml`:

```toml
agentRoots = ["~/.pr-audit"]
agentCachePatterns = ["^pr\\d+-venv$"]
repoRoots = ["~/code"]
```

`agentRoots` and `agentCachePatterns` name directories that hold only disposable output. `repoRoots` adds checkouts for the build output scan.
