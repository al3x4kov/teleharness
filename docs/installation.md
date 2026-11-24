# Full Installation Guide

This guide walks through setting up **Teleharness** with **every feature enabled** — from the core
mobile-first web portal to all four coding agent engine families, MCP & Skills, Git worktrees,
client-side Office/PPTX preview, HTTPS/PWA & Web Push, GitHub Background Agents, Temporal durable
pipelines, Obsidian memory, local CPU voice, and multi-user isolation.

> **Want to preview the UI first without installing any engine?** Run `npm run demo` (or
> `npx teleharness` for a quick local single-user start). Come back here when you are ready for
> a full permanent setup.

---

## Feature-to-requirement matrix

Everything in the first block works out of the box once Node.js, Git, and at least one agent CLI are installed.
Optional subsystems turn on automatically when configured and stay cleanly hidden when not installed.

| Capability | Requirements | Supported OS |
|---|---|---|
| **Core portal, chats, files, built-in preview** (`.pptx`, `.docx`, `.xlsx`, `.csv`, `.pdf`, `.md`, `.html`, code, media) | Node.js ≥ 22.5 + 1 agent CLI | Linux, macOS, Windows |
| **Full-text chat search, Attention Board, Costs ledger** | Node.js ≥ 22.5 (built-in `node:sqlite` FTS5 — no native compile) | Linux, macOS, Windows |
| **Git tab, mobile diff review, Git worktrees** | Git ≥ 2.20 in `PATH` | Linux, macOS, Windows |
| **Engine: Claude Code CLI** | `claude` CLI + Anthropic subscription (`claude setup-token` / `claude login`) | Linux, macOS, Windows |
| **Engine: OpenCode 2.x** (any provider + slim subagents) | `opencode` 2.x (`serve-v2.sh` / `serve-v2.cmd`) + provider key (`opencode auth login`) | Linux, macOS, Windows |
| **Engine: OpenAI Codex CLI** | `@openai/codex` + ChatGPT subscription (`codex login`) | Linux, macOS, Windows |
| **Engine: ACP Agents** (Gemini CLI, Antigravity, GitHub Copilot CLI) | Installed & signed in from **Settings → ACP Agents** | Linux, macOS, Windows |
| **Right panel: MCP servers, Skills (`SKILL.md`), live plan** | Configured MCP / skills in OpenCode or `TELEHARNESS_CLAUDE_MCP_CONFIG` | Linux, macOS, Windows |
| **Phone PWA, QR pairing, Clipboard/Share download, Web Push** | HTTPS reverse proxy (Tailscale Serve / Caddy / nginx / `ops/portal-server.js`) + `TELEHARNESS_PUBLIC_URL` | Any (iOS Safari 16.4+, Android Chrome, Desktop) |
| **Obsidian active cache & cross-engine handoff journal** | Folder path in `TELEHARNESS_KB_ROOT` | Linux, macOS, Windows |
| **GitHub Background Agents** | GitHub Fine-grained PAT in **Settings → Background Agents** (webhook needs HTTPS; polling works behind NAT) | Linux, macOS, Windows |
| **Durable pipelines (Temporal)** | Temporal server + `temporal` CLI + PostgreSQL + Python 3.11+ worker | Linux, macOS |
| **Local voice mode (Piper TTS + GigaAM v2 STT)** | Python 3.11+ venv + offline models (~CPU only) | Linux, macOS, Windows |
| **Multi-user tenant shell isolation** | Linux per-user runner (`ops/sandbox/linux/`) or Windows AppContainer (`ops/sandbox/`) | Linux, Windows (macOS: fail-closed non-admin shell) |
| **Optional server-side PDF/Office conversion** | LibreOffice + Playwright Chromium (`ops/render/`) | Linux, Windows |

---

## 1. Prerequisites

1. **Node.js ≥ 22.5** (Node.js 24 LTS recommended).
   Teleharness has **zero runtime npm dependencies** and uses Node's built-in `node:sqlite` for
   FTS5 full-text search, Attention Board, Costs ledger, and GitHub triggers.
2. **Git ≥ 2.20** in `PATH` (required for the Git screen, inline diff review, and isolated `git worktree` runs).
3. **Build tools:** only `npm ci` (for `esbuild` frontend bundling) — no C++ compiler needed.

Verify both on your host:

```bash
node --version    # v22.5.0 or newer (v24.x LTS recommended)
git --version     # 2.20 or newer
```

---

## 2. Install & build the portal

Clone the latest release tag (`v2.8.1`), install dev build dependencies, build the production frontend
bundle, and create `.env`:

```bash
git clone --branch v2.8.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
TELEHARNESS_BUILD_PROD=1 npm run build
cp .env.example .env
```

On Windows PowerShell:

```powershell
git clone --branch v2.8.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
$env:TELEHARNESS_BUILD_PROD = "1"; npm run build
Copy-Item .env.example .env
```

> **Note on `.env` booleans:** every boolean flag in `.env` uses `1` (enabled) or `0` (disabled).
> `lib/config.js` validates all variables at startup and exits with a clear message on typos.

---

## 3. Install & connect the coding agent engines

You only need **at least one** engine to start chatting, and you can connect all four families side by
side and even switch engines mid-conversation.

### 3.1 Claude Code CLI

1. Install Claude Code using the official installer (<https://docs.anthropic.com/en/docs/claude-code>).
   The native installer puts `claude` in `~/.local/bin/claude` (or `%USERPROFILE%\.local\bin\claude.exe`).
2. Authenticate using your Claude subscription:
   ```bash
   claude setup-token
   ```
   Copy the generated token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...` (or sign in interactively once with `claude`).
3. Optional `.env` settings:
   - `TELEHARNESS_CLAUDE_BIN=/custom/path/to/claude` (if not in `~/.local/bin` or `PATH`)
   - `TELEHARNESS_CLAUDE_MCP_CONFIG=/path/to/claude-mcp.json` (enables MCP servers for admin Claude chats)
   - `TELEHARNESS_TITLE_LLM=1` & `TELEHARNESS_TITLE_MODEL=claude-haiku-4-5` (automatic chat titles)

### 3.2 OpenCode 2.x (recommended `v2` API)

OpenCode gives you access to any model provider (Z.ai GLM, OpenRouter, Anthropic, OpenAI, Google, local Ollama/LM Studio) plus `oh-my-opencode-slim` subagents and skills.

1. Install **OpenCode 2.x** (<https://opencode.ai>, tested with `2.2.6`) and connect your providers:
   ```bash
   opencode --version
   opencode auth login
   ```
2. Start OpenCode in secure loopback mode with HTTP Basic authentication using the bundled launcher:
   - **Linux / macOS:**
     ```bash
     ./ops/opencode/serve-v2.sh
     ```
   - **Windows:**
     ```cmd
     ops\opencode\serve-v2.cmd
     ```
   On first run, `serve-v2` generates a 48-char random password in `~/.teleharness/oc2-password` (`0600`),
   binds strictly to `127.0.0.1:4196`, sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` (prevents untrusted chat
   folders from overriding OpenCode config), and raises `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536`.
3. Start the portal with the matching `web-v2` launcher so it reads the same password file and enables `TELEHARNESS_OC_API=v2`:
   - **Linux / macOS:** `./ops/web-v2.sh`
   - **Windows:** `ops\web-v2.cmd`
4. **Optional OpenCode plugin & document skills:**
   Reference skills (`teleharness-docx`, `teleharness-pdf`, `teleharness-pptx`, `teleharness-xlsx`, `teleharness-html`)
   and the `vault-cache.ts` plugin live under `ops/opencode/`. Copy the skills you want into your
   OpenCode skills directory (`~/.config/opencode/skills/`) so agents can create polished Office files
   and so they appear in the Right Panel's **Skills** tab.

### 3.3 OpenAI Codex CLI

1. Install Codex CLI globally and sign in with your ChatGPT subscription:
   ```bash
   npm install -g @openai/codex
   codex login
   ```
2. Restart Teleharness. Codex is auto-detected once signed in (no extra `.env` config required).
   Use `TELEHARNESS_CODEX_BIN` if `codex` lives outside `PATH`, or `TELEHARNESS_CODEX=off` to hide it.

### 3.4 ACP Agents (Gemini CLI, Google Antigravity, GitHub Copilot CLI)

Teleharness includes a built-in **Agent Client Protocol (ACP)** manager — no manual config editing required:

1. Sign in to the portal as **admin**.
2. Open **Settings → ACP Agents**.
3. Pick an agent from the registry (e.g. **Gemini CLI**, **Google Antigravity**, **GitHub Copilot CLI**) and click **Install**.
4. Click **Sign in** and follow the guided web wizard (OAuth link, Device Flow code, or API key).
5. Once connected, the agent's models appear automatically in the model picker alongside Claude, OpenCode, and Codex.

To disable ACP completely, set `TELEHARNESS_ACP=off` in `.env`.

---

## 4. First launch & admin sign-in

If you use OpenCode 2.x, run both launchers (or just `node server.js` if using Claude/Codex/ACP only):

```bash
# Terminal 1 (only needed if using OpenCode 2.x)
./ops/opencode/serve-v2.sh

# Terminal 2
./ops/web-v2.sh
```

On first start, Teleharness initializes `data/users.json` with an `admin` account and writes the
initial login token to **`data/admin-token.txt`**.

1. Open <http://127.0.0.1:4170/teleharness/> in your browser.
2. Paste the token from `data/admin-token.txt`.
3. Verify the health endpoint:
   ```bash
   curl -s http://127.0.0.1:4170/teleharness/healthz
   ```
   Expected response includes `"ok":true` and `"version":"2.8.1"`.

---

## 5. HTTPS, mobile PWA, QR pairing & Web Push

For local testing `http://127.0.0.1:4170/teleharness/` works immediately. For **full mobile
functionality** (iOS/Android "Add to Home Screen" standalone PWA, native Clipboard API, Web Share
downloads, Web Push notifications, and microphone capture), serve Teleharness over **HTTPS**.

### Option A: Tailscale Serve (easiest for private access)

```bash
tailscale serve --bg 4170
```

Tailscale provisions a valid Let's Encrypt certificate for `https://<machine>.<tailnet>.ts.net` and
proxies directly to `127.0.0.1:4170`.

### Option B: Caddy or nginx reverse proxy

**Caddy (`Caddyfile`):**

```caddy
agents.example.com {
    reverse_proxy 127.0.0.1:4170 {
        flush_interval -1
    }
}
```

**nginx (critical: disable buffering for SSE `/teleharness/api/event`):**

```nginx
location /teleharness/ {
    proxy_pass http://127.0.0.1:4170;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    client_max_body_size 512M;
}
```

### Option C: Bundled edge server (`ops/portal-server.js`)

Set `TELEHARNESS_TLS_CERT`, `TELEHARNESS_TLS_KEY`, `TELEHARNESS_EDGE_ALLOWED_HOSTS`, and
`TELEHARNESS_HTTPS_ONLY=1` in `.env`, then run `node ops/portal-server.js`.

### Connect your phone with one QR scan

1. Add your public HTTPS URL to `.env` (must end with `/teleharness/`):
   ```dotenv
   TELEHARNESS_PUBLIC_URL=https://agents.example.com/teleharness/
   TELEHARNESS_PUSH=1
   TELEHARNESS_PUSH_SUBJECT=https://agents.example.com/teleharness/
   ```
2. Restart Teleharness.
3. On desktop, open **Settings → Connect phone** → generate a one-time QR code.
4. Scan it on your phone: you are signed in immediately.
5. **Install as PWA:**
   - **iOS Safari (16.4+):** Share button → **Add to Home Screen** (required by Apple for Web Push).
   - **Android Chrome:** Menu `⋮` → **Install app**.
6. Open **Settings → Notifications** on the phone and toggle **Push notifications** on (VAPID keys are auto-generated in `data/`).

---

## 6. Right panel: MCP servers, Skills & live plan

On desktop (≥ 1120 px) and tablet/mobile (via the right-panel toggle in the chat header), Teleharness
shows connected **MCP servers**, available **Skills** (click any skill to read its full `SKILL.md`),
and the agent's live **Plan** checklist.

- **OpenCode MCP servers:** defined in `~/.config/opencode/opencode.json` under `"mcp"`.
- **Claude Code MCP servers (admin only):** point `TELEHARNESS_CLAUDE_MCP_CONFIG=/path/to/mcp.json` in `.env`.
- **Tenant visibility:** non-admin users only see MCP servers and skills prefixed with `teleharness-`.
- **Skills directory:** place `<skill-name>/SKILL.md` folders in `~/.config/opencode/skills/` (reference office skills are in `ops/opencode/skills/`).

---

## 7. Files, built-in Office/PPTX preview & optional LibreOffice render

**Works out of the box with zero extra software:**

- Opening any file card in a chat previews `.pptx` (slides, headings, bullets, tables, embedded images, speaker notes), `.docx`, `.xlsx`/`.xlsm`, `.csv`/`.tsv`, `.pdf`, `.md`, `.html` (sandboxed iframe), syntax-highlighted source code, images, audio, and video directly in the browser.
- On iOS/Android standalone PWA, tapping **Download** fetches the binary via authenticated `fetch` and hands it to the native Share sheet / Blob download cleanly.
- Configure `TELEHARNESS_FILE_ROOTS` in `.env` (semicolon-separated paths, default: your home directory) to control which folders are browsable in projects.

**Optional server-side renderer (`ops/render/`):** only needed if you want agents to convert HTML/Office documents to PDF/PNG on the server. See [`ops/render/README-linux.md`](../ops/render/README-linux.md) (Linux) or `ops/render/setup-render.ps1` (Windows).

---

## 8. Obsidian active cache (agent memory & cross-engine handoff)

Point `TELEHARNESS_KB_ROOT` to a folder inside your Obsidian vault:

```dotenv
TELEHARNESS_KB_ROOT=/home/you/Obsidian/agents
```

Teleharness creates and maintains:
- `journal/` — per-chat handoff journals so switching from Claude to Codex/OpenCode/ACP mid-chat preserves context cleanly;
- `sessions/` — turn digests written by the OpenCode plugin;
- `_index.md`, `lessons/`, `decisions/`, `tasks/` — active cache read on the first turn of new chats.

---

## 9. GitHub Background Agents

Trigger automated reviews, issue triage, or Temporal pipelines from GitHub events:

1. Create a GitHub **Fine-grained Personal Access Token** scoped to the repositories you want (e.g. `Issues: Read/Write`, `Pull requests: Read/Write`, `Contents: Read`).
2. In Teleharness (as admin), open **Settings → Background Agents**.
3. Paste the PAT (encrypted at rest in `data/github-triggers.sqlite` with a `0600` key in `data/secrets.key`), select repositories, and add trigger rules.
4. Choose **Polling** (works behind NAT with no open ports) or configure a **GitHub Webhook** pointing to `https://<your-host>/teleharness/api/github/webhook` with the generated HMAC secret.
5. For GitHub Enterprise Server, set `TELEHARNESS_GITHUB_API=https://github.corp.example/api/v3` in `.env`.

---

## 10. Durable pipelines (Temporal — Linux & macOS)

Multi-step pipelines with human approval gates, timers, joins, conditional branches, schedules, and
resume-from-checkpoint run on top of Temporal. Full reference: [`docs/temporal.md`](temporal.md).

1. **Install Temporal server & CLI** (<https://docs.temporal.io/cli>):
   - For a quick trial: `temporal server start-dev --db-filename ~/.teleharness/temporal.db`
   - For production: self-hosted Temporal Server backed by PostgreSQL (or Temporal Cloud).
2. **Initialize the PostgreSQL worker ledger:**
   ```bash
   createdb teleharness_temporal
   psql -d teleharness_temporal -f lib/temporal/ledger.sql
   psql -d teleharness_temporal -f lib/temporal/permits.sql
   ```
   Configure concurrency slots in `temporal_limits` (`scope='provider'` for `claude` / `codex` / `acp` / `opencode`, `scope='tenant'` for users or `'*'`).
3. **Install and start the Python worker** (must run as the **same OS user** as the portal so it can connect to `<data>/temporal-private/worker.sock`):
   ```bash
   python3 -m venv ~/.teleharness/temporal-venv
   ~/.teleharness/temporal-venv/bin/pip install -r worker/temporal/requirements.txt
   PGHOST=127.0.0.1 PGDATABASE=teleharness_temporal PGUSER=teleharness \
   TELEHARNESS_TEMPORAL_MODEL_SOCKET="$(pwd)/data/temporal-private/worker.sock" \
   ~/.teleharness/temporal-venv/bin/python3 worker/temporal/pipeline_worker.py
   ```
   > Keep the checkout/data directory path short: Unix socket paths must fit in **103 bytes on macOS** and **107 bytes on Linux**.
4. **Enable in `.env`** and restart Teleharness:
   ```dotenv
   TELEHARNESS_TEMPORAL_PIPELINES=1
   TELEHARNESS_TEMPORAL_MODELS=claude,codex,acp,opencode
   TELEHARNESS_TEMPORAL_SUBSCRIPTION_ATTESTED=1
   ```

---

## 11. Local voice mode (Piper TTS + GigaAM v2 STT, optional)

Runs 100% locally on CPU — no cloud speech APIs. Full details in [`ops/voice/README.md`](../ops/voice/README.md).

```bash
mkdir -p ~/.teleharness/voice/models
python3 -m venv ~/.teleharness/voice/venv
~/.teleharness/voice/venv/bin/pip install piper-tts sherpa-onnx numpy
```

Download Piper `.onnx` + `.onnx.json` voice files into `~/.teleharness/voice/models/piper/` and
GigaAM v2 (`model.int8.onnx`, `tokens.txt`) into
`~/.teleharness/voice/models/gigaam/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19/`.
Restart Teleharness — the voice wave icon appears automatically in empty composers.

---

## 12. Multi-user tenants & command isolation (optional)

Create additional user accounts in **Settings → Users**. Every regular user gets an isolated home
folder under `TELEHARNESS_TENANT_HOME` (`~/.teleharness-tenants/<name>`), isolated vault zone under
`TELEHARNESS_TENANT_VAULT`, and configurable upload/prompt/rate quotas (`TELEHARNESS_TENANT_*`).

To allow regular users to run agent shell commands safely inside their folder:
- **Linux:** set up the per-user runner in [`ops/sandbox/README.md`](../ops/sandbox/README.md) (`ops/sandbox/linux/teleharness-tenant-run`).
- **Windows:** build the AppContainer jail (`ops/sandbox/build.ps1`, see [`ops/sandbox/README.md`](../ops/sandbox/README.md)).
- **macOS:** non-admin shell commands remain fail-closed by design; non-admin users can still chat and edit files inside their own folder.

---

## 13. Run in the background (autostart)

### Linux (`systemd`)

1. Copy [`ops/linux/teleharness.service`](../ops/linux/teleharness.service) to `/etc/systemd/system/teleharness.service`, update `User`, `Group`, `WorkingDirectory`, and `ExecStart` (use `/opt/teleharness/ops/web-v2.sh` if using OpenCode 2.x).
2. Keep **`OOMPolicy=continue`** so an out-of-memory build/test spawned by an agent cannot terminate the portal.
3. If using OpenCode 2.x, create a companion `teleharness-opencode.service` running `/opt/teleharness/ops/opencode/serve-v2.sh` and add `After=teleharness-opencode.service`.
4. Enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now teleharness
   ```

### macOS (`launchd`)

See the ready-to-use `~/Library/LaunchAgents/*.plist` templates in [`docs/macos.md`](macos.md#5-keep-it-running).

### Windows (Task Scheduler)

Register scheduled tasks (LogonType `S4U` or at startup) running:
- `ops\opencode\serve-v2.cmd` (if using OpenCode 2.x)
- `ops\web-v2.cmd` (portal)
- Optionally `ops\watchdog-teleharness.ps1` every 2 minutes to restart stopped tasks automatically.

---

## 14. Post-install verification checklist

Run through this quick checklist after installation:

- [ ] **Health:** `curl -s http://127.0.0.1:4170/teleharness/healthz` returns `{"ok":true,"version":"2.8.1",...}`.
- [ ] **Engines:** open **New chat → Model picker** and confirm every engine you installed (Claude / OpenCode / Codex / ACP) lists models.
- [ ] **Search:** type a keyword in the Home search bar (confirms Node ≥ 22.5 `node:sqlite` FTS5 is active).
- [ ] **Git & Worktrees:** open a git repository project → **Git** tab shows status/diffs; **Worktrees** tab creates a clean isolated branch.
- [ ] **Files & PPTX:** open a `.pptx` or `.docx` file card → slides/document render immediately; test **Download** on mobile PWA.
- [ ] **Right panel:** open a chat → toggle the right panel → MCP servers and Skills load; click a skill to preview `SKILL.md`.
- [ ] **HTTPS & Phone:** open `TELEHARNESS_PUBLIC_URL` on your phone, pair via QR, install to Home Screen, and send a test Web Push notification from **Settings → Notifications**.
- [ ] **Optional subsystems:** if enabled, verify **Temporal** shows connected worker status, **Background Agents** validates your GitHub PAT, and **Voice** icon appears in empty chat input.
