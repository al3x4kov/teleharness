#!/usr/bin/env bash
# Copies the Claude Code and opencode configs from this repo into place
# (macOS / Linux counterpart of install.ps1).
#
#   config/claude/*   -> ~/.claude/
#   config/opencode/* -> ~/.config/opencode/
#
# Secrets come only from the environment: CLAUDE_CODE_OAUTH_TOKEN, OPENCODE_SERVER_PASSWORD.
# Existing files are kept next to the new ones as <name>.bak-<timestamp>.
#
# Usage:
#   export CLAUDE_CODE_OAUTH_TOKEN=...   # optional
#   export OPENCODE_SERVER_PASSWORD=...  # optional
#   ./config/install.sh [--dry-run]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
opencode_home="${OPENCODE_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
stamp="$(date +%Y%m%d-%H%M%S)"
dry=0
[[ "${1:-}" == "--dry-run" ]] && dry=1

run() { if (( dry )); then echo "+ $*"; else "$@"; fi; }

copy_tree() {
  local from="$1" to="$2"
  run mkdir -p "$to"
  for src in "$from"/* "$from"/.[!.]*; do
    [[ -e "$src" ]] || continue
    local name; name="$(basename "$src")"
    [[ "$name" == *.example.json ]] && continue
    local dst="$to/$name"
    if [[ -f "$dst" ]]; then run cp "$dst" "$dst.bak-$stamp"; fi
    run cp -R "$src" "$to/"
  done
}

copy_tree "$here/claude" "$claude_home"
copy_tree "$here/opencode" "$opencode_home"

if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  run node -e '
    const fs = require("fs"); const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.env = { ...(j.env || {}), CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$claude_home/settings.json"
else
  echo "warning: CLAUDE_CODE_OAUTH_TOKEN is not set — the claude CLI will ask you to log in (claude /login)." >&2
fi

if [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
  run node -e '
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ password: process.env.OPENCODE_SERVER_PASSWORD }, null, 2) + "\n");
  ' "$opencode_home/service.json"
else
  echo "warning: OPENCODE_SERVER_PASSWORD is not set — service.json was not created." >&2
fi

echo "Done."
echo "Claude MCP servers: see config/claude/mcp-servers.json (claude mcp add-json ...)."
echo "opencode plugin deps: (cd \"$opencode_home\" && npm install)"
echo "Note: the configs contain the author's absolute paths — review opencode.json and settings.json."
