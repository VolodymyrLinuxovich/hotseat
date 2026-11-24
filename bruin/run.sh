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

# Learning loop: retrain the answer critic on the seed answers plus every logged turn.
# Optional by design. Without Python and scikit-learn it is skipped quietly, and a failed
# retrain leaves the old engine/critic-model.json in place, so the pipeline never breaks.
CRITIC_PY="${CRITIC_PYTHON:-}"
if [ -z "$CRITIC_PY" ] && [ -x "$ROOT/.venv/bin/python" ]; then
  CRITIC_PY="$ROOT/.venv/bin/python"
fi
if [ -z "$CRITIC_PY" ]; then
  CRITIC_PY="$(command -v python3 || true)"
fi
if [ -n "$CRITIC_PY" ] && "$CRITIC_PY" -c "import sklearn" >/dev/null 2>&1; then
  "$CRITIC_PY" "$ROOT/train/critic.py" --quick || echo "critic retrain failed; kept the previous model" >&2
fi

# Then fine-tune the question policy: a short Q-learning round on simulated interviews plus
# a small, anchored update from the logged sessions (train/policy.py --quick, about a second).
# It only needs numpy, and only runs with the repo's .venv; without it the step is skipped
# silently, and a failed run leaves engine/policy-model.json as it was.
POLICY_PY="$ROOT/.venv/bin/python"
if [ -x "$POLICY_PY" ] && "$POLICY_PY" -c "import numpy" >/dev/null 2>&1; then
  "$POLICY_PY" "$ROOT/train/policy.py" --quick || echo "policy fine-tune failed; kept the previous model" >&2
fi
