<div align="center">

<img src="docs/screenshots/social-preview.png" alt="Teleharness: one web control room for Claude Code, Codex, Gemini (ACP) and opencode, with optional mobile PWA" width="100%">

## One web control room for your AI coding CLIs

**Run Claude Code, Codex, Gemini (ACP) and opencode from one self-hosted desktop web UI — on the subscriptions you already pay for. Review diffs in isolated git worktrees, switch CLIs mid-task when a usage limit hits, and chain agents into durable Temporal pipelines. Need access away from your desk? The same app works as an optional mobile PWA.**

**Chat** · **Attention Board** · **Diff Review & Worktrees** · **Cross-CLI Relay** · **Temporal Pipelines** · **Self-Hosted**

[![Release](https://img.shields.io/github/v/release/al3x4kov/teleharness?style=flat-square&color=6366f1)](https://github.com/al3x4kov/teleharness/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/al3x4kov/teleharness/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/al3x4kov/teleharness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-0ea5e9?style=flat-square)](#platform-support)

[Try in 10s](#try-it-in-10-seconds) •
[Why Teleharness](#how-teleharness-compares) •
[What it does](#what-it-does) •
[Visual tour](docs/tour.md) •
[Quick start](#quick-start) •
[Security](#security-model) •
[Architecture](#architecture) •
[Configuration](#configuration) •
[Русский](README.ru.md)

<img src="docs/screenshots/desktop-demo.gif" alt="Teleharness desktop walkthrough: Multi-CLI Chat, Attention Board, Diff Review, Git Worktrees, Cross-CLI Relay, Temporal Pipelines" width="880">

</div>

---

## Try it in 10 seconds

No engines, no API keys, nothing written to your home folder — opens the full UI on synthetic chats:

**Option 1 — One command (Node.js ≥ 22):**
```bash
npx teleharness --demo
# or directly from GitHub before npm publish:
npx github:al3x4kov/teleharness --demo
# → http://127.0.0.1:4180/teleharness/  (login token: demo-demo-demo-demo)
```

**Option 2 — Docker Compose:**
```bash
git clone https://github.com/al3x4kov/teleharness.git && cd teleharness
docker compose up
# → http://127.0.0.1:4180/teleharness/  (login token: demo-demo-demo-demo)
```

**Option 3 — One-click cloud sandbox (free tier, read-only demo):**
Deploy your own throwaway demo instance directly from [`render.yaml`](render.yaml):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/al3x4kov/teleharness)

---

## How Teleharness compares

Teleharness wraps the **real local CLIs** (with all their skills, MCP servers, hooks, and project context) instead of calling a metered API directly.

| Capability | Teleharness | Claude Code Web | OpenCode Web | Cursor | Vibe Kanban |
|---|:---:|:---:|:---:|:---:|:---:|
| Uses your existing CLI subscriptions (no metered API) | **Yes** | Claude only | BYO API / OAuth | Own plan | Yes |
| Claude Code + Codex + Gemini/ACP + opencode in one UI | **Yes (4 families)** | No | opencode only | IDE models | Partial |
| Switch CLI mid-chat on usage limit (manual & Auto-Relay) | **Yes** | No | No | No | No |
| Attention Board + inline Diff Review + Plan-First | **Yes** | Partial | Partial | IDE | Partial |
| Isolated Git Worktrees with live overlap & conflict check | **Yes** | No | No | Background | Yes |
| Durable multi-agent pipelines surviving restarts (Temporal) | **Yes** | No | No | No | No |
| Self-hosted, zero backend deps, optional mobile PWA | **Yes** | Cloud | Local | Desktop | Local |

---

## What it does

- **Unified Multi-CLI Workspace** — run **Claude Code**, **Codex**, **Gemini / Copilot (ACP)** and **opencode** side by side with live tool steps, subagent cards, an MCP/Skills/Plan desktop right panel, full-text SQLite FTS5 search, Office/PPTX preview, Obsidian active cache, and local CPU voice.
- **Attention Board, Diff Review & Plan-First** — one inbox across all chats and pipelines (*Waiting for you*, *Working*, *Done*, *Failed*) with a side preview pane, line-range inline diff comments, and read-only Plan-First approval before any file is edited.
- **Isolated Git Worktrees & Cost Payback** — run parallel chats on separate branches with live overlap and dry-run merge conflict checks, plus API-equivalent spend tracking against your flat monthly subscriptions.
- **Cross-CLI Relay (Manual & Auto)** — hit a Claude or Codex quota limit mid-task? Continue the same chat in the same folder on another CLI or model in one click — or automatically via backup models. ([Details](docs/cross-cli-handoff.md))
- **Durable Pipelines on Temporal & GitHub Background Agents** *(optional)* — chain Claude, Codex, Gemini (ACP), opencode, allowlisted local commands, and human approvals into multi-step runs that survive restarts, resume from any step, and trigger from GitHub issues/CI. ([Details](docs/temporal.md))

> **Want to see every screen?** Open the full **[Visual Tour & Feature Catalog (`docs/tour.md`)](docs/tour.md)** — desktop & optional mobile PWA screenshots, animated walkthroughs, and the complete feature table.

---

## Quick start

> [!TIP]
> **Full step-by-step setup for Linux, macOS, and Windows** (all 4 engine families, Worktrees, Obsidian cache, Temporal pipelines, GitHub Background Agents, HTTPS + QR mobile PWA, autostart services): **[`docs/installation.md`](docs/installation.md)** ([по-русски](docs/installation.ru.md)).

### Requirements

| | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 22.5 (22 LTS / 24 LTS) | portal server & built-in SQLite FTS5 search/costs/board |
| [Git](https://git-scm.com) | ≥ 2.20 | Git screen, diff review, isolated Worktrees |
| [opencode](https://opencode.ai) | 2.x (tested with 2.2.6) | opencode engine |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 2.x | Claude engine |
| [Codex CLI](https://github.com/openai/codex) | 0.169+ | optional, Codex engine |
| ACP CLI (`gemini` / `copilot` / custom) | latest | optional, configured in Settings → ACP Agents |
| Python | 3.11+ | optional, local CPU voice & Temporal pipeline worker |

You only need **at least one** engine installed (or zero for `--demo`).

### One command

```bash
npx teleharness                                # → http://127.0.0.1:4180/teleharness/
# or directly from GitHub:
npx github:al3x4kov/teleharness
```

Checks Node, stores data in `~/.teleharness`, uses the prebuilt UI bundle (or builds on demand), detects installed engines, and prints your admin login token. Flags: `--demo`, `--port N`, `--host 0.0.0.0`, `--rebuild`.

### Install from source

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci && npm run build

cp .env.example .env               # every value is optional

# engines (you need at least one)
opencode auth login                # add the providers you want
claude setup-token                 # put token into .env as CLAUDE_CODE_OAUTH_TOKEN

./ops/opencode/serve-v2.sh &       # opencode 2.x on 127.0.0.1:4196
./ops/web-v2.sh                    # → http://127.0.0.1:4170/teleharness/
```
</details>

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci; npm run build

Copy-Item .env.example .env        # every value is optional

opencode auth login
claude setup-token

$env:OPENCODE_SERVER_PASSWORD = [guid]::NewGuid().ToString('N')
Start-Process opencode -ArgumentList 'serve','--hostname','127.0.0.1','--port','4196'

$env:TELEHARNESS_OC_API = 'v2'; $env:TELEHARNESS_UPSTREAM = 'http://127.0.0.1:4196'; $env:TELEHARNESS_OC_PASSWORD = $env:OPENCODE_SERVER_PASSWORD
node server.js                     # → http://127.0.0.1:4170/teleharness/
```
</details>

<details>
<summary><b>Docker (self-hosted profile)</b></summary>

```bash
docker compose --profile selfhosted up -d teleharness
```
</details>

> [!NOTE]
> The portal is served under `/teleharness/`; every option is a `TELEHARNESS_*` environment variable ([`.env.example`](.env.example)). Mac launchd checklist: [`docs/macos.md`](docs/macos.md). Linux systemd service: [`ops/linux/teleharness.service`](ops/linux/teleharness.service).

### Platform support

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Portal, opencode, Claude, Codex, ACP, diff review, worktrees, push | yes | yes | yes |
| Temporal pipelines & GitHub Background Agents (optional) | yes | yes | — |
| Obsidian active cache, local CPU voice | yes | yes | yes |
| Multi-user non-admin shell sandbox | disabled (fail-closed) | optional per-user runner | AppContainer sandbox |

---

## Security model

- **Single-user on `localhost` / Tailscale (most common):** Teleharness runs as a local web control room over your own CLI tools under your OS user. **No tenant sandbox is needed**, and every engine works identically on macOS, Linux, and Windows.
- **Multi-user / shared server:** Non-admin users get isolated folders, quotas, and MCP sets; shell execution is fail-closed unless you enable the Linux per-user runner (`ops/sandbox/linux`) or Windows AppContainer. See [SECURITY.md](SECURITY.md).

---

## Architecture

<p align="center"><img src="docs/architecture-components.png" alt="Teleharness components: desktop web UI and optional mobile PWA, portal with SQLite FTS5/costs/board, four CLI engine families, Obsidian, voice, sandbox, GitHub and Temporal pipelines" width="880"></p>

- **Portal (`server.js`, `lib/`, `routes/`)** — zero-dependency Node.js stdlib backend: auth, SSE hub with replay, SQLite FTS5 search, attention board, costs, Git/Worktrees, and one adapter per engine family (`lib/oc-client.js`, `claude` CLI runner, `codex-shim.mjs`, `lib/acp-chat.js`).
- **Frontend (`src/` → `public/`)** — Preact + Signals bundled with esbuild, light/dark themes, EN/RU i18n, optional mobile PWA.
- **Optional add-ons** — Obsidian active cache, local Python CPU voice worker (Piper TTS / GigaAM STT), Temporal pipeline worker ([`docs/temporal.md`](docs/temporal.md)).

Layer diagram & search pipeline: [`docs/tour.md#architecture-diagrams`](docs/tour.md#architecture-diagrams). Full architecture notes: [`docs/architecture.md`](docs/architecture.md), specs: [`openspec/specs/`](openspec/specs/).

---

## Configuration

Every setting is validated by schema in [`lib/config.js`](lib/config.js); template in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4170` (`4180` via CLI) | portal port |
| `TELEHARNESS_DEMO` | `0` | set `1` to run instant synthetic demo mode |
| `TELEHARNESS_UPSTREAM` | `http://127.0.0.1:4196` | `opencode serve` 2.x URL |
| `TELEHARNESS_OC_API` | `v1` | `v2` for opencode 2.x |
| `TELEHARNESS_OC_PASSWORD` | — | HTTP Basic password for opencode 2.x |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription token (`claude setup-token`) |
| `TELEHARNESS_ADMIN_TOKEN` | generated | admin login token |
| `TELEHARNESS_PUBLIC_URL` | — | HTTPS URL for optional phone QR pairing |
| `TELEHARNESS_KB_ROOT` | `off` | Obsidian vault path for active cache |

Example agent configs (Claude Code + opencode): [`config/`](config/) (`./config/install.sh` / `./config/install.ps1`).

---

## Development

```bash
npm test                 # unit, UI components (happy-dom), server and edge tests
npm run build            # esbuild → public/app.js, public/app.css
npm run demo             # synthetic demo on fixtures-demo/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Built with

[opencode](https://opencode.ai) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex CLI](https://github.com/openai/codex) · [Temporal](https://temporal.io) ·
[Preact](https://preactjs.com) · [esbuild](https://esbuild.github.io) · [marked](https://marked.js.org) · [DOMPurify](https://github.com/cure53/DOMPurify) · [highlight.js](https://highlightjs.org)

## License

[MIT](LICENSE). Bundled third-party files keep their licenses: `openspec-*` / `opsx-*` — MIT ([OpenSpec](https://github.com/Fission-AI/OpenSpec)), `dogfood` — Apache-2.0.
