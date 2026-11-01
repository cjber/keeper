#!/usr/bin/env bash
# Renders both AUR packages, checks their metadata against makepkg, then installs the binary one on Arch without Bun.
set -euo pipefail

case "${1:-}" in
  x64) image="archlinux:base@sha256:b21322c663be387c0ed9cbc7bbbfe18e41633ad4e7b7c77cfad45f128be20040" ;;
  arm64) image="menci/archlinuxarm:base@sha256:517984e192ff5cd89d0ecfc776da43956151f03b5329d226d0caa0fbdc5d1d98" ;;
  *) printf '%s\n' 'usage: bash scripts/check-binary-package.sh <x64|arm64>' >&2; exit 2 ;;
esac

scratch=$(mktemp -d)
trap 'command rm -rf "$scratch"' EXIT
version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
git archive --format=tar.gz --prefix="keeper-$version/" -o "$scratch/source.tar.gz" HEAD
cp dist/keeper-linux-x64 dist/keeper-linux-arm64 "$scratch/"
bun scripts/render-aur.ts --version "$version" \
  --sha256 "$(sha256sum "$scratch/source.tar.gz" | cut -d' ' -f1)" \
  --bin-x64-sha256 "$(sha256sum dist/keeper-linux-x64 | cut -d' ' -f1)" \
  --bin-arm64-sha256 "$(sha256sum dist/keeper-linux-arm64 | cut -d' ' -f1)" \
  --out "$scratch/aur"

docker run --rm -i -v "$scratch:/work" \
  -e "PACKAGE_UID=$(id -u)" -e "PACKAGE_GID=$(id -g)" "$image" bash -s <<'ARCH'
set -euo pipefail
trap 'chown -R "$PACKAGE_UID:$PACKAGE_GID" /work' EXIT

# Runner kernels may not permit the downloader Landlock sandbox inside Docker.
pacman -Syu --disable-sandbox --noconfirm --needed base-devel git pacman-contrib
useradd -m builder
chown -R builder:builder /work
for directory in /work/aur /work/aur/bin; do
  diff -u <(sed '/^$/d' "$directory/.SRCINFO" | LC_ALL=C sort) \
    <(su builder -c "cd $directory && makepkg --printsrcinfo" | sed '/^$/d' | LC_ALL=C sort)
done

# Substitute only URLs; makepkg still verifies the real source and binary digests.
sed -i \
  -e 's|https://github.com/cjber/keeper/archive/refs/tags/v${pkgver}.tar.gz|file:///work/source.tar.gz|' \
  -e 's|https://github.com/cjber/keeper/releases/download/v${pkgver}/keeper-linux-x64|file:///work/keeper-linux-x64|' \
  -e 's|https://github.com/cjber/keeper/releases/download/v${pkgver}/keeper-linux-arm64|file:///work/keeper-linux-arm64|' \
  /work/aur/bin/PKGBUILD
su builder -c 'cd /work/aur/bin && makepkg --nodeps --force --noconfirm'
mapfile -t packages < <(su builder -c 'cd /work/aur/bin && makepkg --packagelist')
pacman -U --noconfirm "${packages[@]}"
if command -v bun; then printf '%s\n' 'the binary package test must run without Bun' >&2; exit 1; fi
keeper --version
su builder -c 'keeper status'
su builder -c 'keeper scan --category aur'
printf '%s\n' 'rendered metadata, makepkg checksums and the installed binary passed without Bun'
ARCH
