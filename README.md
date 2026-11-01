# keeper

keeper finds disposable data on an Arch Linux machine: stale worktrees, AUR clones, old package versions, orphaned packages, build output and agent leftovers. Nothing is removed until a plan is applied, and removed paths stay in trash until they are purged.

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
