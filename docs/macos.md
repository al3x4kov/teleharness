# Running Teleharness on macOS and Linux

> For the complete step-by-step setup of **every** Teleharness feature (all 4 engine families,
> MCP/Skills, Git worktrees, GitHub Background Agents, Temporal pipelines, Obsidian, Voice,
> HTTPS/PWA on iOS & Android, and multi-user isolation), see the full
> [Installation Guide](installation.md) ([на русском](installation.ru.md)).
>
> **Note on testing:** the server and unit test suite run in GitHub Actions CI on `macos-latest`,
> `ubuntu-latest`, and `windows-latest`. The live end-to-end launchd workflow below is community-tested;
> if any step differs on your macOS version, please open an issue.

## 1. Prerequisites

```bash
brew install node git        # Node.js >= 22.5 (for built-in SQLite FTS5 search) and Git >= 2.20
# Install at least one coding agent CLI:
# - Claude Code:  https://docs.anthropic.com/en/docs/claude-code (native installer -> ~/.local/bin/claude)
# - OpenCode 2.x: https://opencode.ai (tested with 2.2.6)
# - Codex CLI:    npm i -g @openai/codex
# - ACP agents (Gemini CLI, Antigravity, GitHub Copilot CLI): installable later from Settings -> ACP Agents
```

Verify your toolchain:

```bash
node --version               # v22.5 or newer (Node 24 LTS recommended)
git --version                # 2.20 or newer
opencode --version           # 2.x (if using OpenCode)
claude --version             # (if using Claude Code)
codex --version              # (if using Codex)
```

## 2. Clone and build

```bash
git clone --branch v2.8.0 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
TELEHARNESS_BUILD_PROD=1 npm run build
cp .env.example .env         # all values are optional; defaults live under ~/.teleharness
```

## 3. Sign in to the engines you installed

```bash
opencode auth login          # connect providers (Z.ai Coding Plan, OpenRouter, Anthropic, OpenAI, local...)
claude setup-token           # prints a token -> add CLAUDE_CODE_OAUTH_TOKEN=... to .env (or run `claude` once)
codex login                  # ChatGPT subscription login for Codex CLI
```

## 4. Start the portal

If you use OpenCode 2.x, run two processes (each in its own terminal tab on first run):

```bash
./ops/opencode/serve-v2.sh   # opencode serve on 127.0.0.1:4196 (HTTP Basic, password in ~/.teleharness/oc2-password)
./ops/web-v2.sh              # the portal on http://127.0.0.1:4170/teleharness/
```

`serve-v2.sh` creates the serve password on first run; `web-v2.sh` reads the same file, loads `.env`,
and starts `server.js` with `TELEHARNESS_OC_API=v2`. If you only use Claude Code, Codex, or ACP agents,
skip `serve-v2.sh` and run `node server.js` directly (or `npx teleharness`).

On first start, Teleharness creates the admin account and prints the path to `data/admin-token.txt`.
Open <http://127.0.0.1:4170/teleharness/> and paste the token to sign in.

## 5. Keep it running

### macOS (`launchd`)

Create one agent per process in `~/Library/LaunchAgents/`. Replace `/Users/you/teleharness` with your
checkout and ensure `PATH` includes `node`, `git`, `opencode`, `claude`, and `codex`
(`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel).

`~/Library/LaunchAgents/dev.teleharness.opencode.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.teleharness.opencode</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/teleharness/ops/opencode/serve-v2.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/Users/you/.local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.teleharness/opencode.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.teleharness/opencode.log</string>
</dict>
</plist>
```

`~/Library/LaunchAgents/dev.teleharness.web.plist` is the same with label `dev.teleharness.web`,
program `/Users/you/teleharness/ops/web-v2.sh`, and log `/Users/you/.teleharness/web.log`.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.teleharness.opencode.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.teleharness.web.plist
launchctl kickstart -k gui/$(id -u)/dev.teleharness.web      # restart after an update
```

### Linux (`systemd`)

Use [`ops/linux/teleharness.service`](../ops/linux/teleharness.service) as a starting point: copy it to
`/etc/systemd/system/`, update the user and checkout path, then run
`sudo systemctl daemon-reload && sudo systemctl enable --now teleharness`.
Keep `OOMPolicy=continue` so an out-of-memory child process (browser/tests spawned by an agent)
cannot stop the whole portal.

## 6. Reach it from your phone (HTTPS & PWA)

The portal listens on loopback (`127.0.0.1:4170`) by default. Put it behind HTTPS so iOS/Android
PWA install, Clipboard API, Web Push, and microphone access work smoothly:

- **[Tailscale Serve](https://tailscale.com/kb/1312/serve):** `tailscale serve --bg 4170` — zero-config TLS inside your tailnet;
- **Caddy or nginx** reverse proxy to `http://127.0.0.1:4170` (disable response buffering for `/teleharness/api/event` SSE!);
- **Bundled edge proxy:** `ops/portal-server.js` with TLS certificate paths in `.env`.

Set `TELEHARNESS_PUBLIC_URL=https://<your-host>/teleharness/` in `.env` to enable one-scan QR phone pairing
under **Settings → Connect phone**.

## 7. Optional features

- **ACP agents (Gemini CLI, Antigravity, GitHub Copilot CLI)** — install and sign in directly from **Settings → ACP Agents**.
- **Built-in document preview** — `.pptx`, `.docx`, `.xlsx`, `.csv`, `.pdf`, `.md`, `.html`, images, audio, and video preview directly in the browser with no extra server software.
- **Temporal durable pipelines** — supported natively on macOS and Linux; see [`docs/temporal.md`](temporal.md) and [`docs/installation.md`](installation.md).
- **Obsidian active cache & cross-engine journal** — set `TELEHARNESS_KB_ROOT=/path/to/vault/agents` in `.env`.
- **Local voice (Piper TTS + GigaAM STT)** — set up `~/.teleharness/voice/venv`; see [`ops/voice/README.md`](../ops/voice/README.md).
- **Multi-user Linux sandbox** — see [`ops/sandbox/README.md`](../ops/sandbox/README.md) and [`ops/render/README-linux.md`](../ops/render/README-linux.md).

## Platform notes

- **macOS regular (non-admin) users:** non-admin shell commands are refused (fail-closed) until container-per-user isolation lands. Regular users can still chat and read/write files inside their own folder; admin is unaffected.
- **Server-side LibreOffice rendering (`ops/render`):** optional; built-in browser preview already handles modern Office (`.pptx`, `.docx`, `.xlsx`), PDF, Markdown, HTML, CSV, and media on every OS.
