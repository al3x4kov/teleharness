#!/usr/bin/env bash
# The portal (server.js) against opencode 2.x — macOS / Linux counterpart of web-v2.cmd.
#
# Loads .env from the repo root if present, then points the portal at the opencode 2.x serve
# started by ops/opencode/serve-v2.sh (same port, same password file).
#
# Environment (all optional):
#   OC2_PORT              opencode serve port                 (default: 4196)
#   ZAI_UPSTREAM          full serve address, overrides OC2_PORT
#   ZAI_STATE_DIR         where the password file lives       (default: ~/.zai)
#   ZAI_OC_PASSWORD_FILE  the password file itself            (default: $ZAI_STATE_DIR/oc2-password)
#   NODE_BIN              node binary                         (default: node from PATH)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
state="${ZAI_STATE_DIR:-$HOME/.zai}"
pwfile="${ZAI_OC_PASSWORD_FILE:-$state/oc2-password}"
node_bin="${NODE_BIN:-node}"

if [ -f "$root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
fi

# serve-v2.sh creates the password on its first run; started side by side, give it a moment
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$pwfile" ] && break
  sleep 1
done
if [ ! -s "$pwfile" ]; then
  echo "[web-v2] password file missing or empty: $pwfile — start ops/opencode/serve-v2.sh first" >&2
  exit 2
fi

export ZAI_OC_API=v2
export ZAI_UPSTREAM="${ZAI_UPSTREAM_V2:-http://127.0.0.1:${OC2_PORT:-4196}}"
ZAI_OC_PASSWORD="$(cat "$pwfile")"
export ZAI_OC_PASSWORD

echo "[web-v2] starting server.js (upstream $ZAI_UPSTREAM, api $ZAI_OC_API)" >&2
cd "$root"
exec "$node_bin" server.js
