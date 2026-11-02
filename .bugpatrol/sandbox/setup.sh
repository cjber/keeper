#!/bin/sh
# Builds a throwaway home for keeper to scan: worktrees in each state keeper judges, build output,
# caches and leftovers. Everything keeper could change lives under it, and stubs stand in for the
# system commands its actions call, so a patrol can apply, undo and purge without touching the machine.
set -eu
root=/tmp/keeper-patrol
home=$root/home

tmux -L keeper-patrol kill-server 2>/dev/null || true
rm -rf "$root"
mkdir -p "$home/.worktrees" "$root/bin" "$root/remote"

# Stubs: each logs its call and succeeds, so actions report success without changing the machine.
for tool in sudo renice docker uv pnpm npm systemctl crontab notify-send paccache pacman expac paru gh; do
  printf '#!/bin/sh\necho "%s $*" >> %s/stub-calls.log\n' "$tool" "$root" > "$root/bin/$tool"
  chmod +x "$root/bin/$tool"
done

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
echo "sandbox ready at $home"
