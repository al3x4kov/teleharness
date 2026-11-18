# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [SemVer](https://semver.org/). The app version lives in [`src/lib/version.js`](src/lib/version.js)
and is shown in Settings → About.

## [Unreleased]

### Added
- **Temporal in the demo.** `npm run demo` shows synthetic pipes, runs in every state (waiting for a decision, running,
  waiting for a subscription quota, completed with files, a skipped branch, failed, cancelled) and schedules; *Approve*
  on the waiting run walks it to a result with `notes.md`. README: a Temporal section with a phone GIF and screenshots
  (English and Russian).

### Changed
- **Breaking: one name everywhere.** The codename is gone: the portal is served under `/teleharness/`, every setting is a
  `TELEHARNESS_*` environment variable, the data directory is `~/.teleharness`, tenant folders are
  `.teleharness-tenants`, uploads go to `.teleharness-uploads`, the sandbox helpers are `teleharness-jail`,
  `teleharness-render` and `teleharness-tenant-run`, document skills are `teleharness-docx` … `teleharness-xlsx`, the
  Temporal workflow is `TeleharnessPipelineV1`. Upgrading an existing install: rename the environment variables and
  folders accordingly, update reverse-proxy rules to the new path and sign in again (the cookie and browser storage
  keys were renamed too). Z.ai provider and model ids (`zai-coding-plan`, `zai/glm-*`) are the provider's own names
  and stay as they are.
- **Architecture diagram refreshed** (English and Russian): three CLIs (opencode, Claude Code, Codex), Temporal
  pipelines (server, Python worker, PostgreSQL, model bridge), the sandbox per OS, and the ChatGPT subscription as a
  provider.

### Fixed
- Temporal: a data directory whose worker-socket path exceeds the OS limit (104 bytes on macOS) no longer crashes the
  portal with a bare `ENOENT` — it stops with a clear reason.
- A run waiting for a decision no longer repeats the previous step's answer as an *Interim result* — it is shown once,
  next to *Approve* / *Reject*.

## [1.24.2] — 2026-11-18

### Added
- **Temporal pipelines** *(optional, off by default — [docs/temporal.md](docs/temporal.md))*. A *Temporal* section next to
  Chats and Projects: **Runs** (status of every run without extra taps, a *Waiting for you* block and a menu badge,
  filters, search, self-refresh), **Pipes** (templates, version state, last run) and **Schedules** (hourly / daily /
  weekdays / cron, a preview of the next runs before saving, *Run now*, schedules that lost access are shown with the
  reason). A run screen with a step timeline, the decision next to the answer it is about, confirmation sheets for
  reject / cancel / terminate (a reason is required for terminate) and a *Result* block.
- **Steps:** *Model* — Claude Code or Codex runs the instruction as a turn of the owner's own chat inside the run
  folder (files and tools by the owner's rights; for regular users Codex answers with text only); *Human decision*;
  *Timer*; *Join*; *Condition* (equals / contains / does not contain / yes / no — the steps after a false condition are
  *skipped*); *Artifact* (save a step's answer as a file). Run inputs are asked in a start form and inserted as
  `{{input.name}}`; earlier answers as `{{steps.id}}`.
- **Folders:** every pipe gets `<project>/pipelines/<name>`, every run `runs/<date>-<id>`; the project of a new pipe is
  picked from the user's own projects (no typed paths). Step conversations open from the run and stay out of the chat
  list.
- **Durable execution:** immutable versions (a run keeps the version it started with, publishing an unchanged pipe is
  refused), exactly-once model calls with a ledger, per-engine and per-user concurrency slots, a usage limit makes a
  step wait and retry on the subscription — never a paid API.
- **Linux:** an optional per-user runner for regular users' shell commands (`ops/sandbox/linux`); without it they stay
  refused.

### Changed
- Git screen and changes (1.22.1): rename-only and binary files are shown as such, a detached HEAD is explained,
  suggest-message and push errors are worded by kind, the chat title is the Git subtitle.
- An agent-shown file that lies outside the configured roots opens for the admin (other users keep their own roots).

### API
- `GET /teleharness/api/temporal/capabilities`, `…/projects`, `…/attention`; `GET/POST /teleharness/api/temporal/definitions`,
  `GET/PUT …/definitions/:id`, `POST …/:id/publish`; `GET/POST /teleharness/api/temporal/runs`, `GET …/runs/:id`,
  `GET …/runs/:id/results/:step`, `POST …/runs/:id/actions`; `GET/POST /teleharness/api/temporal/schedules`,
  `POST …/schedules/:id/pause|resume`.

### Notes
- Server-side Temporal validation and error texts are in Russian for now; the editor translates validation messages.
- The Temporal worker is Python (`worker/temporal`, `temporalio`, `psycopg`); hosting hardening is up to your setup.

## [1.22.0] — 2026-11-16

### Added
- **Turn changes.** An answer that edited files shows a *Changes · N files* row with the totals. It opens a list of
  files (a sheet on a phone, two panes on a desktop) and a diff per file: *This turn* — the edit as the agent made it,
  or *Now vs commit* — the file in the working folder against the last commit, when the chat folder is a git
  repository. Copy the diff or download it as a patch; large diffs show the first 400 lines.
- **Git screen** (chat menu → *Git*, or *Project Git* under the changes): branch, ahead/behind, last commit and the
  changed files. Tick the files to commit, *Suggest message* asks the chat's own model (Claude, Codex or opencode)
  in a separate short request that never lands in the chat history, *Commit* commits exactly the ticked files, and
  *Push* sends the branch to its upstream with a readable error when it fails. Push is admin-only and can be turned
  off; other users commit in their own folders only, without push or branch switching. git runs without a shell,
  with timeouts and no prompts; repositories in other users' folders run with hooks and configured programs off.
- **Settings → Git:** commit author (name and e-mail), the language of a suggested message (the interface language or
  always English), which files are ticked by default, and the push switch for the admin.
- **Background subagents keep working after the answer.** Claude turns now talk to the CLI over stream-json, so
  subagents started in the background are no longer killed when the main answer ends. A band above the composer
  shows them; a new message waits in the queue and Claude answers again once they finish.

### API
- `GET /teleharness/api/git/status`, `GET /teleharness/api/git/diff`, `POST /teleharness/api/git/commit`, `POST /teleharness/api/git/push`,
  `POST /teleharness/api/git/suggest-message` (folder by `?sid=` or `?directory=`), `GET/PUT /teleharness/api/me/git` — see
  [docs/architecture.md](docs/architecture.md).

### Notes
- git must be on the server's `PATH`. Error texts from the server side of Git are in Russian for now; an English UI
  shows its own wording for push errors.

## [1.21.1] — 2026-11-16

### Added
- **Agent roles for Codex chats.** A Codex chat can run with a portal agent (for example *Workflow*) or with none;
  the role is chosen in the chat like a Claude agent and applies from the next answer. Settings → Model & agents has
  a separate default agent for new Codex chats.

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
