<div align="center">

<img src="docs/screenshots/social-preview.png" alt="Teleharness: your coding-agent CLIs — with their whole harness — on your phone" width="100%">

Run **Claude Code** and **opencode** on your own machine and drive them from any browser.
You don't chat with a bare model: every message goes through a real agent CLI, with its agents,
skills, MCP servers, hooks and an Obsidian vault as long-term memory.

[![Release](https://img.shields.io/github/v/release/al3x4kov/teleharness?style=flat-square&color=6366f1)](https://github.com/al3x4kov/teleharness/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/al3x4kov/teleharness/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/al3x4kov/teleharness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-0ea5e9?style=flat-square)](#platform-support)

[Try the demo](#try-it-in-30-seconds) •
[Features](#features) •
[Quick start](#quick-start) •
[Architecture](#architecture) •
[Configuration](#configuration) •
[Contributing](CONTRIBUTING.md) •
[Русский](README.ru.md)

<img src="docs/screenshots/demo.gif" alt="Teleharness on a phone: chat list, an agent turn with steps and file cards" width="300">

</div>

---

## Why Teleharness

Chat apps give you a model. Agent CLIs give you much more — tools, file access, subagents, skills,
MCP servers, hooks, project memory — but they live in a terminal on your desk.

Teleharness puts a mobile-first web UI in front of those CLIs, so the full harness is one tap away:

- **CLIs, not models.** Each chat runs through `opencode serve` or the `claude` CLI. Whatever you have
  configured there — agents, skills, plugins, MCP — works from your phone.
- **Many providers through one portal.** opencode talks to Z.ai GLM, OpenAI, Google Gemini, Anthropic,
  OpenRouter, local models and more; Claude Code brings your Claude subscription. Pick the engine and
  model per chat.
- **Memory that outlives a chat.** An Obsidian vault works as an active cache: agents get a snapshot
  of your notes at the start of a chat and leave a digest after each turn.
- **Your machine, your data.** Files, tools and history stay on your server. Providers only see the
  prompts and tool results needed for inference.
- **Share it safely.** Multiple users with their own folders, quotas and system prompts; on Windows
  their commands run in an AppContainer sandbox.

## Try it in 30 seconds

No engines, no API keys — the UI on synthetic chats:

```bash
git clone https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
npm run demo     # → http://127.0.0.1:4171/zai/
```

<p align="center">
  <img src="docs/screenshots/phone-light-home.png" alt="Chat list" width="240">
  <img src="docs/screenshots/phone-light-landing.png" alt="Agent turn with steps" width="240">
  <img src="docs/screenshots/phone-dark-landing-mid.png" alt="Tool steps and file cards, dark theme" width="240">
</p>

<p align="center">
  <img src="docs/screenshots/desktop-light-auth.png" alt="Desktop layout with a Claude Code chat" width="760">
</p>

## Features

| | | |
|---|---|---|
| 💬 | **Two engines, one UI** | opencode (any provider) and Claude Code side by side; a chat stays bound to its engine, model and agent. |
| 🧠 | **Agent steps** | Live turn progress: reasoning, tool calls with output, subagents, background tasks. Undo a turn and its file edits. |
| 📡 | **Reliable streaming** | One SSE hub for every engine with replay, stall detection and loop protection — survives flaky mobile networks. |
| 📎 | **Files** | Attach files and images, get result files as cards, browse allowed folders. A folder per chat. |
| 🗂️ | **Obsidian as active cache** | Vault snapshot in context, turn digests written back, an isolated zone per user. |
| 🎙️ | **Voice** | Local speech-to-text and text-to-speech (Python worker, CPU only) and a hands-free voice mode. |
| 🔔 | **Push notifications** | Get notified when a long turn is done (Web Push, VAPID). |
| 👥 | **Multi-user** | Admin and users with own folders, system prompts, MCP sets, upload and voice quotas, rate limits. |
| 📱 | **Mobile-first** | Built for iOS Safari: keyboard-aware layout, safe areas, light and dark themes, English and Russian UI. |
| 🪶 | **Zero runtime dependencies** | The backend is plain Node.js stdlib. |

## Quick start

### Requirements

| | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 22 | the portal |
| [opencode](https://opencode.ai) | 1.19.5 | the opencode engine |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 2.x | the Claude engine |
| Python | 3.11+ | optional, voice |

You need at least one of the two engines.

### Install and run

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
git clone --branch v1.15.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci && npm run build

cp .env.example .env               # fill in what you need, then: set -a; . ./.env; set +a

# engines
opencode auth login                # add the providers you want
opencode serve --port 4096 &       # opencode engine
claude setup-token                 # Claude engine (token → CLAUDE_CODE_OAUTH_TOKEN)

node server.js                     # → http://127.0.0.1:4170/zai/
```
</details>

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
git clone --branch v1.15.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci; npm run build

Copy-Item .env.example .env        # fill in what you need

opencode auth login
Start-Process opencode -ArgumentList 'serve','--port','4096'
claude setup-token

node server.js                     # → http://127.0.0.1:4170/zai/
```
</details>

On first start the portal creates an admin and writes the login token to `data/admin-token.txt`
(or uses `ZAI_ADMIN_TOKEN`). To reach it from your phone, put it behind TLS — the bundled edge server
(`ops/portal-server.js`) or any reverse proxy (Caddy, nginx, Tailscale Serve).

> [!NOTE]
> `zai` is the project's original codename. It stays in the URL path (`/zai/`), environment variables
> (`ZAI_*`) and storage keys so existing installs keep working.

### Platform support

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Portal, both engines, files, push | ✅ | ✅ | ✅ |
| Obsidian cache, voice | ✅ | ✅ | ✅ |
| Command execution for non-admin users | — | — | ✅ (AppContainer sandbox) |

Without a sandbox, shell access for regular users is refused (fail-closed); admins are not affected.

## Architecture

<p align="center"><img src="docs/architecture-components.png" alt="Teleharness components: client, portal, harness of two CLIs, Obsidian, voice, sandbox, model providers" width="900"></p>

- **Portal** (`server.js`) — API, auth and users, the event hub, chat-to-engine binding. One adapter per
  engine: a proxy to `opencode serve` and a runner that starts `claude` per turn.
- **Harness** — everything around the CLI: agents and orchestration (oh-my-opencode-slim), the
  `vault-cache.ts` plugin, Claude Code hooks, skills, MCP servers. This decides what an agent can do and
  what it knows.
- **Obsidian** — long-term memory for agents, one zone per user.
- **Voice** — a separate local Python process (Piper TTS, GigaAM STT).
- **Sandbox** — Windows AppContainer for other users' commands.

More: [`docs/architecture.md`](docs/architecture.md) (in Russian), requirements in [`openspec/specs/`](openspec/specs/).

## Configuration

Everything is configured with environment variables; the schema with types, defaults and validation is
[`lib/config.js`](lib/config.js), the template is [`.env.example`](.env.example).

| Variable | Default | |
|---|---|---|
| `PORT` | `4170` | portal port |
| `ZAI_UPSTREAM` | `http://127.0.0.1:4096` | `opencode serve` address |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription token (`claude setup-token`) |
| `ZAI_ADMIN_TOKEN` | generated | admin login token |
| `ZAI_DATA_DIR` | `./data` | users, sessions, logs |
| `ZAI_FILE_ROOTS` | home folder | folders available in the file browser |
| `ZAI_KB_ROOT` | `off` | Obsidian vault folder for agents, e.g. `~/Obsidian/agents` |
| `ZAI_TENANT_HOME` | `~/.zai-tenants` | users' folders |
| `ZAI_VOICE_PYTHON`, `ZAI_VOICE_MODELS` | `~/.zai/voice/…` | local voice worker |

### Agent configs

[`config/`](config/) holds the author's Claude Code and opencode setup as a working example —
agents, prompts, the vault-cache plugin, document skills. Install with `./config/install.sh`
(macOS/Linux) or `./config/install.ps1` (Windows); secrets are taken from the environment.
The configs contain absolute paths — review them before use.

Third-party skills are not bundled; install them from their sources:
[agent-skills](https://github.com/addyosmani/agent-skills) (`/plugin marketplace add addyosmani/agent-skills`),
[OpenSpec](https://github.com/Fission-AI/OpenSpec) (`npm i -g @fission-ai/openspec`).

## Development

```bash
npm test                 # unit, UI components (happy-dom), server and edge tests
npm run build            # esbuild → public/app.js, public/app.css
npm run demo             # mock mode on fixtures-demo/
```

| Path | |
|---|---|
| `server.js`, `lib/`, `routes/` | backend |
| `src/` → `public/` | frontend (Preact + signals) |
| `shared/` | code shared by server and client |
| `ops/` | edge server, sandbox, voice worker, document rendering |
| `config/` | Claude Code and opencode configs |
| `tests/`, `fixtures/`, `fixtures-demo/` | tests and synthetic fixtures |
| `openspec/specs/`, `docs/` | requirements, architecture, ADRs |

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Built with

[opencode](https://opencode.ai) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ·
[oh-my-opencode-slim](https://www.npmjs.com/package/oh-my-opencode-slim) · [Preact](https://preactjs.com) ·
[esbuild](https://esbuild.github.io) · [marked](https://marked.js.org) · [DOMPurify](https://github.com/cure53/DOMPurify) ·
[highlight.js](https://highlightjs.org) · [Piper](https://github.com/rhasspy/piper) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

## License

[MIT](LICENSE). Bundled third-party files keep their licenses: `openspec-*` / `opsx-*` skills and
commands — MIT ([OpenSpec](https://github.com/Fission-AI/OpenSpec)), the `dogfood` skill — Apache-2.0.
