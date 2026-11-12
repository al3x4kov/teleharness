# Running Teleharness on macOS

This guide takes a clean Mac to a portal you can open from your phone. Linux differs only in the
service manager (systemd instead of launchd).

> [!IMPORTANT]
> The macOS path is covered by the automated test suite on GitHub's macOS runners, and the launch
> scripts below are tested with stand-in binaries. The full setup on real hardware — opencode 2.x,
> the Claude CLI, launchd — has **not** been walked through end to end yet. If a step does not match
> what you see, please open an issue.

## 1. Prerequisites

```bash
brew install node            # Node.js 22 or newer
# opencode 2.x — see https://opencode.ai for the current installer; tested with 2.2.6
# Claude Code — see https://docs.anthropic.com/en/docs/claude-code; the native installer puts it in ~/.local/bin
```

You need at least one of the two engines. Check what you have:

```bash
node --version               # v22 or newer
opencode --version           # 2.x
claude --version
```

## 2. Get the portal

```bash
git clone --branch v1.19.2 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci && npm run build
cp .env.example .env         # every value is optional; the defaults live under your home folder
```

## 3. Sign the engines in

```bash
opencode auth login          # add the providers you want (z.ai Coding Plan, OpenRouter, …)
claude setup-token           # prints a token: put it into .env as CLAUDE_CODE_OAUTH_TOKEN
```

## 4. Start

Two processes, each in its own terminal tab for the first run:

```bash
./ops/opencode/serve-v2.sh   # opencode serve on 127.0.0.1:4196 (HTTP Basic, password in ~/.zai/oc2-password)
./ops/web-v2.sh              # the portal on http://127.0.0.1:4170/zai/
```

`serve-v2.sh` creates the serve password on first run; `web-v2.sh` reads the same file, loads `.env`
and starts `server.js` in opencode 2.x mode (`ZAI_OC_API=v2`). If you only use Claude Code, skip the
first script and run `node server.js`.

On first start the portal creates the admin and writes the login token to `data/admin-token.txt`.
Open <http://127.0.0.1:4170/zai/> and paste it.

## 5. Keep it running (launchd)

Create one agent per process in `~/Library/LaunchAgents/`. Replace `/Users/you/teleharness` with your
checkout and make sure `PATH` contains the folders of `node`, `opencode` and `claude`
(`/opt/homebrew/bin` on Apple silicon, `/usr/local/bin` on Intel).

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
  <key>StandardOutPath</key><string>/Users/you/.zai/opencode.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.zai/opencode.log</string>
</dict>
</plist>
```

`~/Library/LaunchAgents/dev.teleharness.web.plist` is the same with the label `dev.teleharness.web`,
the program `/Users/you/teleharness/ops/web-v2.sh` and the log `/Users/you/.zai/web.log`.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.teleharness.opencode.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.teleharness.web.plist
launchctl kickstart -k gui/$(id -u)/dev.teleharness.web      # restart after an update
```

A launch agent runs while you are logged in. For a headless Mac, enable automatic login or turn the
agents into daemons in `/Library/LaunchDaemons` with a `UserName` key.

## 6. Reach it from your phone

The portal listens on loopback only. Put it behind TLS with whatever you already use:

- [Tailscale Serve](https://tailscale.com/kb/1312/serve): `tailscale serve --bg 4170` — the simplest way inside your tailnet;
- Caddy or nginx as a reverse proxy to `127.0.0.1:4170`;
- the bundled edge server `ops/portal-server.js` (TLS certificate paths in `.env`).

## 7. Optional pieces

- **Obsidian as agent memory** — set `ZAI_KB_ROOT` in `.env` to a folder of your vault, e.g. `~/Obsidian/agents`.
  The chat journal (one file per chat, read by agents after a handoff between engines) is written to
  `<that folder>/journal/`.
- **Agent configs** — `./config/install.sh` copies the example Claude Code and opencode configs into place.
  They contain absolute paths of the author's machine: review them first.
- **Voice** — a Python 3.11+ venv in `~/.zai/voice/venv` (see `ops/voice/`).

## Known limits on macOS

- **Other users' shell commands are refused.** Isolation between users is being moved to one container per
  user with the full agent runtime, the same on every host OS; the Windows-only AppContainer sandbox is
  not ported to macOS on purpose. Until then a regular (non-admin) user on macOS or Linux can chat,
  read and write files in their own folder, but agents cannot run shell commands for them. The admin
  is not affected.
- **Document rendering** (`ops/render`, LibreOffice previews) is tested on Windows only.
