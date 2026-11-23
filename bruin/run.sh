#!/usr/bin/env bash
# Rebuild the candidate weakness profile (data/profile.json) from data/*.jsonl with Bruin.
# Works from any cwd. Exits nonzero if any asset or quality check fails.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
BRUIN="${BRUIN_BIN:-$ROOT/.tools/bruin}"
if [ ! -x "$BRUIN" ]; then
  BRUIN="$(command -v bruin || true)"
fi
if [ -z "$BRUIN" ]; then
  echo "bruin binary not found (set BRUIN_BIN)" >&2
  exit 1
fi

# All relative paths in .bruin.yml and the SQL assets resolve against the repo root.
cd "$ROOT"
for f in data/turns.jsonl data/sessions.jsonl; do
  if [ ! -s "$f" ]; then
    echo "missing or empty $f" >&2
    exit 1
  fi
done

rm -f data/profile.json.tmp
TELEMETRY_OPTOUT=1 "$BRUIN" run \
  --config-file "$HERE/.bruin.yml" \
  --env default \
  --no-log-file \
  --no-color \
  --full-refresh \
  "$HERE/hotseat" "$@"

if [ ! -s data/profile.json.tmp ]; then
  echo "pipeline finished but data/profile.json.tmp was not written" >&2
  exit 1
fi
mv -f data/profile.json.tmp data/profile.json
echo "profile written: $ROOT/data/profile.json"
