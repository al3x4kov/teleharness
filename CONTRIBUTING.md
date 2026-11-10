# Contributing to Teleharness

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
npm run demo        # UI on synthetic data, no engines or API keys needed
```

To work with real engines, see [Quick start](README.md#quick-start) in the README.

## Before you open a pull request

1. **Tests.** `npm test` must pass. Add or update a test for any behaviour change
   (`tests/*.test.js` — unit and server, `tests/components/` — UI on happy-dom).
   Server tests start real processes on free ports and run sequentially.
2. **Both engines.** If the change touches chats, check it with opencode and with the claude CLI.
3. **No secrets.** Tokens, keys and personal data never go into code, tests, fixtures or screenshots —
   configuration comes from environment variables (`.env.example`).
4. **Small, focused PRs.** One change per PR is much easier to review.

## Project layout

| Path | What |
|---|---|
| `server.js`, `lib/`, `routes/` | backend (Node, no runtime dependencies) |
| `src/` → `public/` | frontend (Preact + signals, built by `build.mjs`) |
| `shared/` | code shared by server and client |
| `ops/` | edge server, sandbox, voice worker, document rendering |
| `config/` | Claude Code and opencode user configs |
| `openspec/specs/` | requirements (OpenSpec format) |
| `docs/` | architecture and ADRs |

## Requirements and specs

Behaviour is described in `openspec/specs/<domain>/spec.md` as requirements with scenarios.
If your change alters behaviour, update the matching scenario in the same PR.

## Reporting security issues

Please do not open public issues for vulnerabilities — use
[private advisories](https://github.com/al3x4kov/teleharness/security/advisories/new).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
