# ops/ — Operations, Launchers, Sandbox & Optional Services

This folder holds the operational scripts and optional sidecar services that accompany Teleharness.
For full end-to-end installation instructions across Linux, macOS, and Windows, see
[`docs/installation.md`](../docs/installation.md) ([`docs/installation.ru.md`](../docs/installation.ru.md)).

## Directory map

| Path | Platform | Purpose |
|---|---|---|
| `web-v2.sh` / `web-v2.cmd` | Linux, macOS / Windows | Loads `.env`, reads the OpenCode 2.x Basic-auth password file, and starts `server.js` with `TELEHARNESS_OC_API=v2`. |
| `opencode/serve-v2.sh` / `serve-v2.cmd` | Linux, macOS / Windows | Starts `opencode serve` 2.x on loopback (`:4196`) with an auto-generated HTTP Basic password (`~/.teleharness/oc2-password`) and `OPENCODE_DISABLE_PROJECT_CONFIG=1`. |
| `opencode/` | All | Reference OpenCode 2.x plugin (`vault-cache.ts`), skills (`teleharness-docx`, `teleharness-pdf`, `teleharness-pptx`, `teleharness-xlsx`, `teleharness-html`), and plugin unit tests. |
| `linux/teleharness.service` | Linux | `systemd` unit template with `OOMPolicy=continue` so one heavy agent turn cannot kill the portal. |
| `portal-server.js` | All | Optional zero-dependency HTTPS edge reverse proxy (`:80`/`:443`) with TLS, host allow-list, HTTP→HTTPS redirect, and non-buffered SSE streaming. |
| `voice/` | Linux, macOS, Windows | Optional local voice worker (`voice-worker.py`: Piper TTS + GigaAM v2 STT over JSON lines, CPU-only). See [`ops/voice/README.md`](voice/README.md). |
| `render/` | Linux, Windows | Optional server-side LibreOffice / headless Chromium document renderer (note: modern `.pptx`, `.docx`, `.xlsx`, `.csv`, `.pdf`, `.md`, `.html` already preview directly in the browser with zero server setup). See [`ops/render/README-linux.md`](render/README-linux.md). |
| `sandbox/` | Linux, Windows | Optional per-tenant command isolation (`linux/teleharness-tenant-run` on Linux; AppContainer `TeleharnessJail.cs` on Windows). See [`ops/sandbox/README.md`](sandbox/README.md). |
| `temporal/` | Linux, macOS | Reference OpenCode text-only config for non-admin Temporal pipeline turns. See [`docs/temporal.md`](../docs/temporal.md). |
| `stand/stand-v2.ps1` | Windows | Helper to launch an isolated staging instance on separate ports (`:4174`/`:4101`). |
| `watchdog-teleharness.ps1` | Windows | Scheduled watchdog script checking portal and OpenCode loopback ports. |

## Quick verification

```bash
# Run the server against OpenCode 2.x (Linux / macOS)
./ops/opencode/serve-v2.sh &
./ops/web-v2.sh

# Health check
curl -s http://127.0.0.1:4170/teleharness/healthz
```
