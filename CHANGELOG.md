# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [SemVer](https://semver.org/). The app version lives in [`src/lib/version.js`](src/lib/version.js)
and is shown in Settings → About.

## [Unreleased]

## [1.21.0] — 2026-11-16

### Added
- **Codex CLI as a third engine.** Codex models (ChatGPT subscription) appear in the model picker as their own group
  once `codex` is installed and signed in on the server. Turns run through `codex app-server` behind a small shim
  (`lib/codex-shim.mjs`) that speaks the same protocol as the Claude runner, so Codex chats get history, the message
  queue, in-chat permission requests and push, context and usage, and Relay / auto-handoff to and from the other
  engines. The binary is found in the npm global folder or `PATH` on macOS, Linux and Windows (`TELEHARNESS_CODEX_BIN`
  overrides, `TELEHARNESS_CODEX=off` disables).
- Codex chats offer the permission modes *Ask* and *No questions*.

### Notes
- Codex is admin-only on every OS for now: an allowed command runs with the server's rights until Codex gets its own
  sandbox, so it is not offered to other users. Undo and edit of a turn are off for Codex turns.

## [1.20.0] — 2026-11-15

### Added
- **Permission mode per chat.** *Ask* (the agent asks before file edits and commands, you approve or deny right in
  the chat), *Edits without asking* and *No questions* (admin only). For Claude chats the approvals go through a
  permission bridge (`claude` stream-json control requests); the mode applies from the next turn.
- **Waiting for you.** A push notification when an agent needs your decision, and a chat list filter with the number
  of chats waiting for you.
- **Phone pairing by QR code.** Settings → Connect a phone shows a one-time sign-in link as a QR code (valid
  10 minutes); scanning it signs the phone in to the same account without typing a token. Set `TELEHARNESS_PUBLIC_URL` to
  the public https address of the portal root to enable it.
- **Context and cost.** A meter above the composer shows how full the model's context window is (a warning past
  80 %) and what the chat has cost, or that it runs on a subscription; each turn's footer shows its cost.
- **Auto-handoff on a usage limit (optional).** Settings → Model & agents → *Continue automatically on a usage
  limit* with up to three backup models: the server hands the chat over and asks the new engine to continue, even
  with the phone closed. Off by default.
- **One-command install:** `npx github:al3x4kov/teleharness` — data in `~/.teleharness`, the UI is built on the
  first run, engines are detected and the admin token is printed.
- Demo mode: a Codex chat, a chat waiting for a permission decision, context fields on answers, a demo QR code and
  the auto-handoff setting.

### Changed
- README: a screen-by-screen tour with new screenshots and a new demo GIF (English and Russian), a new banner.
- Demo mode has a chat that shows subagent cards and a handoff between engines.
- Quota reset times in Settings → Subscriptions are shown in the viewer’s own time zone (they were fixed to Moscow time).

## [1.19.4] — 2026-11-14

### Fixed
- A new user opening Settings right after the first sign-in saw "MCP servers: not configured" until a reload — the
  first answer of a cold opencode folder is empty while the MCP servers connect. An empty or still-pending answer is
  now retried in the background for about 45 seconds, and Settings ask again when opened.
- After signing out in another tab (or any 401 mid-session) the sign-in screen no longer claims the token is invalid;
  it suggests signing in again first.

## [1.19.2] — 2026-11-13

### Added
- **Relay.** Continue a chat on another engine or model — from the chat menu at any time, or from the usage-limit
  notice when a subscription runs out mid-task. The chat keeps its folder and one feed with a handoff mark; the new
  engine receives the turns it missed with its first prompt and can read the chat journal for the rest.
- **Chat journal.** With a knowledge-base folder configured, every chat is written to `journal/<date>-<chat>.md`
  (requests, agent steps, answers). Agents are told where it is and may read it without a permission prompt.
- **Subscriptions** in Settings for every user: usage and remaining quota per connected provider where an official
  API reports it (z.ai Coding Plan, OpenRouter, DeepSeek, Moonshot, SiliconFlow; OpenAI and Anthropic API spend with
  an organization admin key). Providers without such an API say so plainly.
- **Subagent cards.** Each subagent run is a card with its task, live "now" line, grouped steps, answer rendered as
  Markdown, and a link to the agent's own chat; background agents get a bar above the composer.
- **Files on request.** When you ask an agent for a file it appears in the chat as a card with preview and download;
  server paths are no longer shown to users who cannot open them.
- **opencode 2.x.** The portal talks to `opencode serve` 2.x through one adapter (`TELEHARNESS_OC_API=v2`, HTTP Basic auth),
  with the sandbox and knowledge-base plugins ported to the 2.x plugin API. opencode 1.x remains the default mode.
- Claude Fable 5.2 in the Claude model catalog; context windows follow the CLI.
- macOS / Linux launch scripts `ops/opencode/serve-v2.sh` and `ops/web-v2.sh`, and a step-by-step
  [macOS guide](docs/macos.md) with launchd services.

### Changed
- The app is called **Teleharness** everywhere in the UI, with a new icon.
- Path checks, process-tree termination and default locations are platform-aware in one place
  (`lib/paths.js`, `lib/proc.js`); macOS system folders are refused as chat folders.
- The engine label of opencode chats is "opencode" (it is not tied to one provider).

### Fixed
- A finished turn no longer flips the chat back to "busy" for 10–20 seconds when another device polls the status.
- Deleting a user's folders is refused on macOS / Linux when another user's folder lives inside (prefix comparison
  used a Windows separator).
- Empty chats left by an interrupted start are cleaned up through the engine adapter.
- Voice mode with browser speech recognition starts listening as soon as it opens.

### Known limits
- On macOS and Linux, shell commands for non-admin users are refused. Isolation is moving to one container per user;
  the Windows AppContainer sandbox is not ported.
- The macOS setup is covered by CI and by launch-script tests with stand-in binaries, not yet by a full run on hardware.

## [1.15.1] — 2026-11-10

First public release under the name **Teleharness**.

### Added
- English UI; the language follows the browser and can be switched in Settings (English / Russian).
- macOS and Linux support: portable default paths, POSIX process handling, host stats via `os` and `df`.
  The tenant sandbox stays Windows-only; elsewhere shell access for non-admin users is refused (fail-closed).
- `npm run demo` — the UI on synthetic chats, no engines or API keys required.
- CI on Linux, macOS and Windows; `config/install.sh` for macOS/Linux.

### Changed
- opencode chats run on oh-my-opencode-slim (`orchestrator` agent). A chat or a saved default on an agent that
  is no longer in the catalog continues on the default agent.
- Every new tenant chat works in its own subfolder, so parallel chats no longer overwrite each other's files.
- A Claude turn closes on the CLI result even if a background task keeps the process alive.

### Fixed
- Slash commands in admin opencode chats expand through opencode `/command`.
- A chat deleted mid-turn no longer stays busy.

[1.21.0]: https://github.com/al3x4kov/teleharness/releases/tag/v1.21.0
[1.20.0]: https://github.com/al3x4kov/teleharness/compare/v1.19.4...v1.21.0
[1.19.4]: https://github.com/al3x4kov/teleharness/releases/tag/v1.19.4
[1.19.2]: https://github.com/al3x4kov/teleharness/releases/tag/v1.19.2
[1.15.1]: https://github.com/al3x4kov/teleharness/releases/tag/v1.15.1
