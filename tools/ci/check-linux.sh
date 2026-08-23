#!/bin/bash
# Run the CI check on Linux from a Windows development machine, via WSL.
#
# WHY THIS EXISTS
#
# `corepack pnpm check` passing locally is not evidence that CI will pass. This repository has
# been caught by that twice: CI was red on `ubuntu-latest` from the day it was added, because
# every test that pinned a platform-shaped value was written on Windows and only ever run
# there. Development happens on Windows; the Linux leg has no local instrument unless one is
# built. This is that instrument, committed so it stops being rediscovered.
#
# WHAT IT PROVES, AND WHAT IT DOES NOT
#
# It proves the Linux leg. It does NOT reproduce the GitHub *Windows* runner, which differs
# from a developer's Windows box in ways that matter for anything timing-sensitive -- a
# virtualised disk, a scanner in the path, and a loaded host all change `fs.watch` delivery.
# Green here plus green on Windows is the strongest signal available locally, and it is still
# not the same as CI.
#
# SETUP (once)
#
#   wsl --install -d Ubuntu
#   # inside WSL, no sudo required:
#   curl -fsSL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz \
#     | tar -xJ && mv node-v24.15.0-linux-x64 ~/node24
#   git clone /mnt/<drive>/<path-to-repo> ~/pm
#
# The clone matters. Running `pnpm install` against `/mnt/...` directly would overwrite the
# Windows `node_modules` with Linux binaries and break the Windows checkout.
#
# USAGE
#
#   bash tools/ci/check-linux.sh
#
# It tests whatever this checkout has at HEAD, so commit first (a branch is fine).

set -uo pipefail

WSL_DISTRO="${WSL_DISTRO:-Ubuntu}"
WSL_CLONE="${WSL_CLONE:-pm}"
WSL_NODE_BIN="${WSL_NODE_BIN:-node24/bin}"

# `D:\patchmesh` or `D:/patchmesh` -> `/mnt/d/patchmesh`. Git inside WSL reads `d:/...` as an
# ssh host and tries to resolve it, which fails with a name-resolution error rather than
# anything that points at the real problem.
windows_path="$(pwd -W 2>/dev/null || pwd)"
drive="$(printf '%s' "$windows_path" | sed -n 's|^\([A-Za-z]\):.*|\1|p' | tr '[:upper:]' '[:lower:]')"
if [ -n "$drive" ]; then
  rest="$(printf '%s' "$windows_path" | sed 's|^[A-Za-z]:||' | tr '\\' '/')"
  SOURCE_PATH="/mnt/$drive$rest"
else
  SOURCE_PATH="$windows_path"
fi

echo "source:  $SOURCE_PATH"
echo "distro:  $WSL_DISTRO"

# The script is piped to `bash -s` on stdin rather than embedded in a `-c` string. Nesting
# heredocs through `wsl.exe -- bash -lc "..."` mangles `$?` and `$(...)`, which silently
# produced an empty exit status and a script that always looked like it had passed.
# The Windows PATH also leaks into WSL and contains spaces and parentheses, so PATH is set
# explicitly below rather than inherited.
# Git Bash rewrites any argument that looks like a POSIX path into a Windows one, so
# `/mnt/d/patchmesh` reaches WSL as `C:/Program Files/Git/mnt/d/patchmesh`. Git inside WSL then
# reads the `C:` as an ssh host and fails on name resolution, which points nowhere near the
# real cause. Both variables are set because Git Bash and MSYS2 read different ones.
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
wsl.exe -d "$WSL_DISTRO" -- bash -s -- "$WSL_CLONE" "$WSL_NODE_BIN" "$SOURCE_PATH" <<'INNER'
set -uo pipefail
# Relative paths are resolved against WSL's HOME, not the Windows one the caller has.
case "$1" in /*) CLONE="$1";; *) CLONE="$HOME/$1";; esac
case "$2" in /*) NODE_BIN="$2";; *) NODE_BIN="$HOME/$2";; esac
SOURCE="$3"
export PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

cd "$CLONE" || { echo "clone not found at $CLONE; see SETUP in tools/ci/check-linux.sh"; exit 1; }

# Discard whatever the last run left behind, so what is tested is the commit and nothing else.
git checkout -- . && git clean -fdq
git fetch -q "$SOURCE" HEAD || { echo "could not fetch from $SOURCE"; exit 1; }
git checkout -q FETCH_HEAD || exit 1

echo "commit:  $(git log --oneline -1)"
echo "node:    $(node --version)"

if ! corepack pnpm install --frozen-lockfile > /tmp/patchmesh-install.log 2>&1; then
  echo "install failed:"; tail -20 /tmp/patchmesh-install.log; exit 1
fi

corepack pnpm check > /tmp/patchmesh-check.log 2>&1
STATUS=$?
grep -E 'ℹ (pass|fail)|✖' /tmp/patchmesh-check.log || true
echo "EXIT=$STATUS"

# `pnpm --recursive` stops at the first failing project, so one failure hides every project
# after it. Never read a single red result as a single problem.
if [ "$STATUS" -ne 0 ]; then
  echo "--- tail of failing output ---"
  tail -40 /tmp/patchmesh-check.log
fi
exit "$STATUS"
INNER
