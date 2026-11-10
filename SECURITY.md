# Security policy

## Supported versions

Only the [latest release](https://github.com/al3x4kov/teleharness/releases/latest) receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/al3x4kov/teleharness/security/advisories/new),
not in public issues. Include steps to reproduce and the affected version.
You will get a reply within a few days.

## Scope notes

- The tenant sandbox (`zai-jail`, Windows AppContainer) exists only on Windows.
  On macOS and Linux command execution for tenants is disabled.
- The portal is meant to run behind TLS (`ops/portal-server.js` or your own reverse proxy).
