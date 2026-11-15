#!/bin/sh
# Builds a throwaway home for keeper to scan: worktrees in each state keeper judges, build output,
# caches and leftovers. Everything keeper could change lives under it, and stubs stand in for the
# system commands its actions call, so a patrol can apply, undo and purge without touching the machine.
set -eu
root=${KEEPER_PATROL_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/keeper/patrol}
case "$root" in
  /*) ;;
  *) echo "KEEPER_PATROL_ROOT must be an absolute path" >&2; exit 2 ;;
esac
if [ "$root" = / ] || [ "$root" = "$HOME" ]; then
  echo "KEEPER_PATROL_ROOT cannot be / or HOME" >&2
  exit 2
fi
marker="$root/.keeper-patrol-root"
if [ -L "$root" ] || [ -L "$root/.keeper-patrol-root" ]; then
  echo "KEEPER_PATROL_ROOT cannot be a symlink" >&2
  exit 2
fi
if [ -e "$root" ]; then
  if [ ! -d "$root" ] || { [ -e "$marker" ] && [ "$(cat "$marker")" != keeper-patrol-root ]; } || {
    [ ! -e "$marker" ] && [ "$(find "$root" -mindepth 1 -print -quit)" ];
  }; then
    echo "KEEPER_PATROL_ROOT exists without its safety marker; choose an empty directory" >&2
    exit 2
  fi
else
  mkdir -p "$root"
fi
printf '%s\n' keeper-patrol-root > "$marker"
home=$root/home

tmux -S "$root/tmux.sock" kill-server 2>/dev/null || true
command rm -rf -- "$root"
mkdir -p "$home/.worktrees" "$root/bin" "$root/remote"
printf '%s\n' keeper-patrol-root > "$root/.keeper-patrol-root"

# Stubs: each logs its call and succeeds, so actions report success without changing the machine.
for tool in sudo renice docker uv pnpm npm systemctl crontab notify-send paccache pacman expac paru; do
  printf '#!/bin/sh\necho "%s $*" >> %s/stub-calls.log\n' "$tool" "$root" > "$root/bin/$tool"
  chmod +x "$root/bin/$tool"
done

# A successful GitHub list has a JSON array; an empty stdout would make every fixture fail closed.
cat > "$root/bin/gh" <<'SH'
#!/bin/sh
printf '[]\n'
SH
chmod +x "$root/bin/gh"

export HOME="$home" GIT_CONFIG_NOSYSTEM=1
git config --global user.email patrol@example.test
git config --global user.name patrol
git config --global init.defaultBranch main

old() { touch -h -d "20 days ago" "$@"; }

# A repository with an origin, and worktrees that keeper should treat differently.
git init -q --bare "$root/remote/app.git"
git clone -q "$root/remote/app.git" "$home/drive/app" 2>/dev/null
cd "$home/drive/app"
printf "node_modules/\ndist/\n" > .gitignore
echo app > README.md && git add . && git commit -qm init && git push -q origin main
git remote set-head origin main

add() { git worktree add -q -b "$1" "$home/.worktrees/$1" main; }
add merged-feature # every commit on main: low risk once idle
add dirty-work && echo wip > "$home/.worktrees/dirty-work/notes.txt" # uncommitted file: blocked
add unpushed && (cd "$home/.worktrees/unpushed" && echo x > x && git add x && git commit -qm local) # unpushed commit
add fresh-branch # touched today: blocked by the age window
add "a-very-long-branch-name-that-keeps-going-to-test-how-the-wizard-truncates-titles"

# Build output inside an idle worktree, git-ignored and old.
mkdir -p "$home/.worktrees/merged-feature/node_modules/left-pad" "$home/.worktrees/merged-feature/dist"
head -c 3000000 /dev/zero > "$home/.worktrees/merged-feature/node_modules/left-pad/index.js"
head -c 800000 /dev/zero > "$home/.worktrees/merged-feature/dist/bundle.js"
find "$home/.worktrees/merged-feature/node_modules" "$home/.worktrees/merged-feature/dist" -exec touch -h -d "20 days ago" {} +

# Aged last, since adding the build output above touches the worktree.
for name in merged-feature dirty-work unpushed a-very-long-branch-name-that-keeps-going-to-test-how-the-wizard-truncates-titles; do
  old "$home/.worktrees/$name" "$home/drive/app/.git/worktrees/$name/logs/HEAD"
done

# A directory beside the worktrees that git does not track, as a manual removal leaves.
mkdir -p "$home/.worktrees/old-experiment/scratch"
head -c 250000 /dev/zero > "$home/.worktrees/old-experiment/scratch/out.bin"
find "$home/.worktrees/old-experiment" -exec touch -h -d "20 days ago" {} +

# A large npm cache, offered once it passes 2G. Sparse, so it costs no disk.
mkdir -p "$home/.npm/_cacache"
truncate -s 3G "$home/.npm/_cacache/blob"
dd if=/dev/zero of="$home/.npm/_cacache/blob" bs=1M count=1 conv=notrunc status=none

mkdir -p "$home/.config/keeper"

# A week of free space readings and the events that changed it, so the history view has a chart to draw.
state="$home/.local/state/keeper"
mkdir -p "$state"
python3 - "$state" $(df -B1 --output=avail,size "$home" | tail -1) <<'PY'
import json, sys, time
state, now, gig = sys.argv[1], time.time(), 1024 ** 3
real_free, real_size = int(sys.argv[2]), int(sys.argv[3])
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
# Ends at the real reading, so the next one keeper takes continues the line instead of jumping.
step = real_free / 400
free, readings = 0.0, []
with open(f"{state}/history.jsonl", "w") as history, open(f"{state}/audit.jsonl", "w") as log:
    for hour in range(7 * 24, -1, -1):
        at = now - hour * 3600
        free -= step  # builds and caches eat space between cleanups
        if hour % 24 == 3:
            free += 8 * step
            log.write(json.dumps({"at": iso(at), "actor": "keeper.service", "event": "auto", "summary": "nightly"}) + "\n")
        if hour == 50:
            free += 30 * step
            log.write(json.dumps({"at": iso(at), "actor": "patrol", "event": "apply", "bytes": int(30 * step)}) + "\n")
        if hour == 20:
            free += 20 * step
            log.write(json.dumps({"at": iso(at), "actor": "patrol", "event": "purge", "bytes": int(24 * step), "freed": int(20 * step)}) + "\n")
        readings.append((at, free))
    shift = real_free - readings[-1][1]
    for at, value in readings:
        history.write(json.dumps({"at": iso(at), "free": int(max(0, value + shift)), "size": real_size}) + "\n")
PY
echo "sandbox ready at $home"
