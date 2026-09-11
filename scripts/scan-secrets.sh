#!/bin/sh
# Credential scan over staged content.
#
# Phase 1 brief, Decision 2. Runs gitleaks when it is installed, and always runs
# the built-in pattern scan below so the check never silently degrades to a
# no-op on a machine that lacks it.
#
# This is the LOCAL half. GitHub secret scanning with push protection is the
# other half, enabled when the remote is created -- it is the backstop for the
# case this hook is bypassed with --no-verify or a fresh clone that never ran
# `npm run hooks:install`.

set -eu

staged=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$staged" ] && exit 0

if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks protect --staged --redact --no-banner; then
    echo "" >&2
    echo "BLOCKED: gitleaks found a secret in staged content." >&2
    exit 1
  fi
else
  echo "note: gitleaks not installed; running built-in scan only." >&2
  echo "      install it for broader coverage:  brew install gitleaks" >&2
fi

# Built-in scan. Credential shapes only -- personal data is covered by the
# repo-hygiene test, which can carry an allowlist without false-positive noise.
added=$(git diff --cached -U0 --diff-filter=ACMR | grep '^+' | grep -v '^+++' || true)
[ -z "$added" ] && exit 0

fail=0
check() {
  pattern=$1
  label=$2
  if printf '%s\n' "$added" | grep -Eq -e "$pattern"; then
    echo "" >&2
    echo "BLOCKED: staged content looks like it contains $label." >&2
    printf '%s\n' "$added" | grep -En -e "$pattern" | sed 's/^/  /' | cut -c1-120 >&2
    fail=1
  fi
}

check '[0-9]{3,6}~[A-Za-z0-9]{20,}'                                   'a Canvas access token'
check 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' 'a JWT (Turso auth token?)'
check '-----BEGIN [A-Z ]*PRIVATE KEY-----'                            'a private key'
check '\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b'                             'a Telegram bot token'
check '\bAKIA[0-9A-Z]{16}\b'                                          'an AWS access key id'
check '(client_secret|refresh_token|authToken|auth_token)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}' 'a hardcoded secret'
check 'TURSO_AUTH_TOKEN[[:space:]]*=[[:space:]]*[A-Za-z0-9]'          'a populated TURSO_AUTH_TOKEN'
check 'CANVAS_TOKEN[[:space:]]*=[[:space:]]*[A-Za-z0-9]'              'a populated CANVAS_TOKEN'

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Secrets belong in .env (gitignored) or the config table, never in a commit." >&2
  echo "" >&2
  exit 1
fi

exit 0
