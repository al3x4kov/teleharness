#!/usr/bin/env bash
# opencode 2.x `serve` for Teleharness — macOS / Linux counterpart of serve-v2.cmd.
#
# Starts `opencode serve` on 127.0.0.1:4196 with HTTP Basic auth (user `opencode`). The password
# is read from a file and created on first run; ops/web-v2.sh hands the same file to the portal.
#
# Environment (all optional):
#   OC2_BIN               opencode binary                     (default: opencode from PATH)
#   OC2_PORT              serve port                          (default: 4196)
#   ZAI_STATE_DIR         where the password file lives       (default: ~/.zai)
#   ZAI_OC_PASSWORD_FILE  the password file itself            (default: $ZAI_STATE_DIR/oc2-password)
#
# opencode reads its usual config (~/.config/opencode, or $XDG_CONFIG_HOME/opencode if you set it).
set -euo pipefail

state="${ZAI_STATE_DIR:-$HOME/.zai}"
pwfile="${ZAI_OC_PASSWORD_FILE:-$state/oc2-password}"
port="${OC2_PORT:-4196}"
bin="${OC2_BIN:-opencode}"

if ! command -v "$bin" >/dev/null 2>&1; then
  echo "[serve-v2] opencode binary not found: $bin (install opencode 2.x or set OC2_BIN)" >&2
  exit 2
fi

mkdir -p "$(dirname "$pwfile")"
if [ ! -s "$pwfile" ]; then
  # 48 hex chars from the kernel RNG; the file is readable by the owner only.
  # (head reads a fixed block first, so no stage of the pipe dies of SIGPIPE under pipefail)
  (umask 077 && head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-48 > "$pwfile")
  echo "[serve-v2] created the serve password file: $pwfile" >&2
fi

OPENCODE_SERVER_PASSWORD="$(cat "$pwfile")"
export OPENCODE_SERVER_PASSWORD
# opencode must not load project config from chat folders: other users can write there.
export OPENCODE_DISABLE_PROJECT_CONFIG=1
# opencode caps max_tokens at min(model output, 32000); long reasoning plus a large file write can hit it.
export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX="${OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX:-65536}"

echo "[serve-v2] starting $bin serve on 127.0.0.1:$port" >&2
exec "$bin" serve --hostname 127.0.0.1 --port "$port"
