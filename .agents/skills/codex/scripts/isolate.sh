#!/usr/bin/env bash
# Give another agent its own copy of a repository's current state.
#
# Saves tracked changes and untracked files outside the repository, then
# creates a detached worktree at <dest> and applies them there, so builds,
# tests and cleanups in the copy cannot touch the original checkout.
#
# Usage: isolate.sh <repo> <dest>
# Prints the worktree path and the backup directory.
set -euo pipefail

repo=$(cd "${1:?usage: isolate.sh <repo> <dest>}" && git rev-parse --show-toplevel)
dest=${2:?usage: isolate.sh <repo> <dest>}
backup="$dest.backup"

if [ -e "$dest" ]; then
  echo "isolate: $dest already exists" >&2
  exit 1
fi
mkdir -p "$backup"

git -C "$repo" diff --binary HEAD >"$backup/tracked.patch"
git -C "$repo" ls-files --others --exclude-standard -z >"$backup/untracked.list"
if [ -s "$backup/untracked.list" ]; then
  (cd "$repo" && xargs -0 tar -cf "$backup/untracked.tar" <"$backup/untracked.list")
fi

git -C "$repo" worktree add --detach "$dest" HEAD >/dev/null
if [ -s "$backup/tracked.patch" ]; then
  git -C "$dest" apply --binary "$backup/tracked.patch"
fi
if [ -f "$backup/untracked.tar" ]; then
  tar -xf "$backup/untracked.tar" -C "$dest"
fi

echo "worktree: $dest"
echo "backup:   $backup"
echo "remove:   git -C $repo worktree remove --force $dest"
