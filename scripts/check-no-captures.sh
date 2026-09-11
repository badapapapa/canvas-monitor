#!/bin/sh
# Refuse to commit raw Canvas captures.
#
# DECISIONS.md D-11. var/ holds unredacted-by-intent response shapes and
# third-party personal data. It is gitignored, but a `git add -f`, a stray
# `git add -A` after an .gitignore edit, or a future refactor that moves the
# capture root would all defeat that. Redaction is best-effort; a repository is
# forever. This is the second lock.

set -eu

staged=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^var/' || true)

if [ -n "$staged" ]; then
  echo "" >&2
  echo "BLOCKED: raw Canvas captures are staged for commit." >&2
  echo "" >&2
  echo "$staged" | sed 's/^/  /' >&2
  echo "" >&2
  echo "These files contain other students' names and email addresses." >&2
  echo "Unstage them:  git restore --staged var/" >&2
  echo "" >&2
  exit 1
fi

# Also catch a database being committed, for the same reason.
db=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.db$|\.db-wal$|\.db-shm$' || true)
if [ -n "$db" ]; then
  echo "" >&2
  echo "BLOCKED: a database file is staged. It holds the Canvas token." >&2
  echo "$db" | sed 's/^/  /' >&2
  echo "" >&2
  exit 1
fi

exit 0
