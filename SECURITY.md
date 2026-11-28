# Security policy

## Supported versions

Only the [latest release](https://github.com/al3x4kov/teleharness/releases/latest) receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/al3x4kov/teleharness/security/advisories/new),
not in public issues. Include steps to reproduce and the affected version.
You will get a reply within a few days.

## Scope & deployment model

- **Single-user on `localhost` / Tailscale (most common):** Teleharness runs as a local web UI over your own CLI tools (`claude`, `codex`, `opencode`, ACP) under your OS user. No tenant sandbox is needed for single-user mode, and it works identically on macOS, Linux, and Windows.
- **Multi-user / shared server:** Non-admin tenants are restricted to their own folders, quotas, and MCP sets. Tenant shell execution is fail-closed by default: on Windows it runs inside a Windows AppContainer (`teleharness-jail`); on Linux an optional per-user runner (`ops/sandbox/linux`) can be enabled; on macOS tenant shell commands stay disabled.
- **TLS:** When exposing Teleharness beyond `127.0.0.1`, run it behind TLS — either via `ops/portal-server.js` or your own reverse proxy (Caddy, nginx, Tailscale Serve).
