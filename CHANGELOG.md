# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [SemVer](https://semver.org/). The app version lives in [`src/lib/version.js`](src/lib/version.js)
and is shown in Settings → About.

## [Unreleased]

## [2.13.1] — 2026-11-28

Codex OAuth token auto-refresh and clear refresh failure diagnostics.

### Fixed
- **Automatic Codex OAuth token refresh.** `lib/codex-shim.mjs` now retries `account/read` once with `{ refreshToken: true }` in both `--teleharness-catalog` and turn execution when `{ refreshToken: false }` returns `account: null` under `requiresOpenaiAuth !== false`, preventing unnecessary Codex engine disablement on expired access tokens.
- **Sanitized Codex refresh diagnostics.** `lib/codex-shim.mjs` captures `codex app-server` stderr, strips ANSI escapes, redacts tokens/JWTs, and forwards `authError` to `lib/codex-catalog.js`, which logs the exact refresh failure reason on both active-to-off transitions and cold starts.

## [2.13.0] — 2026-11-28

UI & Settings layout polish, PWA metadata fix, and legacy brand cleanup with automated regression guard.

### Added
- **Legacy brand regression guard.** Added `tests/no-legacy-brand.test.js` to verify no stray pre-rebrand identifiers leak into source, docs, or tests across releases (while preserving third-party LLM provider names such as `z.ai` / `zai-coding-plan`).

### Fixed
- **Temporal header breadcrumbs.** Centered `.page-header > .t-crumbs` in grid column 2 and excluded it from the right-action column 3 rule so breadcrumb headers never crowd the right edge.
- **Settings → Computer disk labels.** Widened `.host-label` to 76 px with single-line ellipsis and added a `title` tooltip so Linux mount paths (e.g. `/boot/efi`) never wrap or collide with usage bars.
- **Settings → Background agents layout.** Fixed number limit inputs to use `.t-input.t-num` and styled `[data-bg-admin] .card-row` as spaced flex rows.
- **Settings → System prompt footer.** Scoped `.card .sheet-footer` to static/transparent so embedded footers no longer paint a sticky background band over cards.
- **PWA capability meta tag.** Added standard `<meta name="mobile-web-app-capable" content="yes" />` alongside `apple-mobile-web-app-capable` in `public/index.html`.
- **Remaining legacy identifiers.** Cleaned up remaining pre-rebrand strings in worktrees default git author/commit message, GitHub token expiry push tag, Temporal command step env filter, and tests.

## [2.12.0] — 2026-11-27

Desktop-first README & refreshed v2.12.0 architecture diagrams, Temporal pipeline hardening and cancellation, UI accessibility & layout polish, and full demo/mock route parity.

### Added
- **Temporal schedule & trigger management.** Delete schedules directly from the Schedules tab (including schedules whose pipe was deleted), create new GitHub triggers from a non-empty Triggers list via the *+ New trigger* button, and rotate webhook secrets or delete triggers with confirmation sheets directly from the trigger card.
- **Worktrees branch deletion modal.** Replacing browser `confirm()` with an in-app confirmation modal in the Worktrees view.
- **English architecture layers diagram.** Added an up-to-date English `docs/architecture-layers.svg` / `.png` alongside `docs/architecture-layers.ru.svg` / `.png` covering all four engine families (OpenCode 2.x, Claude Code, Codex, ACP) and Temporal pipelines.

### Changed
- **Desktop-first README & positioning.** Shifted `README.md`, `README.ru.md`, repository description, and topics toward the desktop web control room with desktop screenshots up front, presenting the mobile web / PWA view as an optional companion.
- **Temporal pipeline ergonomics & safety.**
  - Propagated Temporal activity cancellation through the Unix-socket model bridge (`CancelSignal` + `AbortSignal`) so canceled Command steps stop immediately instead of running to timeout.
  - Added non-admin engine selector and rollback-on-failure in the trigger creation wizard, fixed `nightly-deps` schedule defaults (`overlap: "skip"`, `catchupSeconds: 3600`) and `step.repo` wiring for `pull_request` steps.
  - Enforced per-user command allowlists on schedule creation/listing/resume and run resume, blocked non-admin users from enabling or triggering Claude-step workflows via explicit versions, and redacted host filesystem paths on outside-root command outputs for non-admin users.
  - Fixed `workflowId` route regex to accept underscores (`_`), fixed `RUNNING` workflow describe after Temporal Reset not showing stale failures, added human-readable duration formatting on External Workflows, and serialized Definition Editor save-before-publish.
- **UI accessibility & layout fixes.**
  - Fixed desktop sidebar footer overlapping the *"Show all"* link at 1280×800 and ensured all navigation views expose exactly one `<h1>` (including Chat not-found, External Workflows, Triggers, and New Schedule).
  - Set `inert` and `aria-hidden` on the closed mobile drawer so off-screen focusable controls are excluded from Tab order.
  - Portaled Board confirmation dialogs to `document.body`, prevented `Sheet` Escape handlers from using stale closures, and updated `ExternalWorkflowsList` cards with explicit accessible labels.
- **API hardening & mock/demo parity.**
  - Added malformed URI validation (`400` instead of `500`) on review routes, body size limit (`413`) and invalid JSON handling (`400`) on `/api/auth/pair/claim`, prevented `PATCH /api/session/:id` from mutating local title cache on upstream `404`, and returned `404` for unknown chat IDs in non-admin cost queries.
  - Completed `TELEHARNESS_MOCK=1` / demo-mode coverage across SPA routes (`/api/attention`, `/api/claude/agents`, `/api/github/connection`, `/api/me/pins`, `/api/push/key`, `/api/voice`, `/api/acp/catalog`, `/api/admin/users`, `POST/PATCH/DELETE /api/session`) and updated mock `opencodeVersion` to `2.2.6`.

## [2.10.0] — 2026-11-26

### Added
- **Command pipeline step & admin allowlist catalog.** Added a `command` step type to Temporal pipelines
  supporting two modes: `exec` (direct `execFile` without a shell, clean environment allowlist, symlink-escape
  protection within `TELEHARNESS_TEMPORAL_COMMAND_ROOTS`, fail-closed Linux tenant jail, 1 MiB tail-truncated
  stdout artifacts, concurrency semaphore with `slot_wait`, and SQLite idempotency / `uncertain` post-restart
  protection) and `temporal-workflow` (triggering an external Temporal Schedule or starting a deterministic
  child workflow with status polling, failure extraction, and optional child cancellation on abort).
- **Commands catalog UI & Python worker support.** Added an admin-only **Commands** tab in Temporal
  (`/teleharness/api/admin/temporal-commands*`) with CRUD sheets, external Temporal schedule discovery,
  role-projected step previews in `DefinitionEditor`, `CommandStepBox` metadata in `RunDetail`, and the
  `TeleharnessPortalCommandV1` worker activity with 30 s heartbeats and `workflow.patched("command-step-v1")`
  replay compatibility.
- **Local Temporal mode without PostgreSQL & macOS `launchd` examples.** Added `TELEHARNESS_TEMPORAL_LEDGER=none`
  (lazy `psycopg` import so command, timer, condition, approval, and artifact pipelines run against a local
  Temporal dev server with no PostgreSQL), full `TELEHARNESS_TEMPORAL_CLI` / `ADDRESS` / `NAMESPACE` / `QUEUE` /
  `COMMAND_SLOTS` / `COMMAND_ROOTS` / `MODEL_SOCKET` configuration, Unix-socket length checks (103 B macOS /
  107 B Linux), and `ops/temporal/` `launchd` plist templates.
- **External Temporal workflows viewer & controller (admin-only).** Added an admin-only **External** tab in
  Temporal and `/teleharness/api/admin/temporal-workflows*` endpoints backed by injection-safe `--flag=value`
  CLI calls: Visibility list with status / type / task-queue filters (excluding portal pipelines by default),
  **Start workflow** sheet with JSON input validation, workflow detail view with decoded Input / Result / Failure
  payloads, pending activities, event history timeline with inline `Reset here` buttons, **Signal**, **Query**
  (with copyable JSON result), **Reset** (by event ID or reset type + reapply exclude), **Cancel**, **Terminate**
  (mandatory reason), `TELEHARNESS_TEMPORAL_UI_URL` deep links, and payload-free audit logging.

## [2.8.2] — 2026-11-25

### Fixed
- **Clipboard file paste outside focused textarea.** Added a window-level `paste` listener in `Composer` with
  `WeakSet` bubbling deduplication so pressing `Ctrl/⌘+V` in an open chat attaches files and focuses the input
  even when the textarea is not focused, while ignoring pastes inside other editable controls (`input`,
  `textarea`, `select`, `contenteditable`) or behind blocking overlays.
- **Finder, Explorer, Linux file managers & browser "Copy image" pastes.** Refined `pasteAction()` so copied
  image files carrying companion filenames, local paths, `file://` URIs, or single-`<img>` HTML fragments
  attach as files instead of pasting raw text, while preserving the narrow Word/Excel text+render exception.
- **Clipboard folder detection, rapid-paste races & SVG uploads.** Unified `extractEntries()` detects pasted
  folders via `webkitGetAsEntry()` (showing the folder error while still attaching sibling files) and recovers
  files from `dt.files` on partial `getAsFile() === null`; synchronous `filesRef` + batch reservation prevents
  duplicate filenames and quota drift across rapid pastes/drops; `image/svg+xml` uploads as a binary file to
  `.teleharness-uploads` instead of an inline data URL; `uploadOne` falls back to `sessionDir(sessionId)`;
  pasting while a chat is stopping shows a clear refusal notice.
- **Drag-and-drop reliability & overlay guards.** `dragInfo()` now recognizes `application/x-moz-file`,
  `items` with `kind === "file"`, and `dt.files` fallbacks; `DropZone` clears on all four window edges,
  `dragend`, and `blur`, and suppresses the drop overlay and attachment behind open modals, sheets,
  `FileViewer`, `SkillModal`, `VoiceMode`, and review scrims while still calling `preventDefault()`.

## [2.8.1] — 2026-11-24

### Added
- **Background Agents queue clearing & admin limit controls.** Added `POST /api/temporal/triggers/:id/queue/clear`
  with a **Clear queue** action on trigger cards (drains pending items without stopping active runs) and
  configurable admin defaults (`userPerDay`, `defaultPerHour`, `defaultQueue`) in Settings → Background Agents.
- **Skills detail TTL cache & request deduplication.** `GET /api/skills/:id` now caches skill payloads for 30 s
  with in-flight deduplication and automatic cache invalidation on 404, eliminating repeated full-catalog fetches
  when opening the Skill modal.

### Fixed
- **Right panel on mobile & narrow viewports.** `AppShell` now gates mounting `RightPanel` behind
  `matchMedia("(min-width: 1024px)")`, preventing idle `/api/mcp`, `/api/skills`, and `/api/session/:id/plan`
  requests on phones.
- **Plan loading retry & right-panel contrast.** `loadPlan` now distinguishes transient network/5xx errors
  (scheduling a retry instead of permanently caching an empty plan) from 4xx responses; muted right-panel labels
  (`.rp-empty`, `.rp-plan-hint`, `.rp-modal-path`) were raised to `--text-2` for WCAG AA contrast; aligned
  the v1 `fetchSkills` fallback query to `?directory=`.
- **Background Agents security & server wiring.** Wired `usesClaude`, `permissionCheck`, `dirAllowed`, and
  `claudeLeftToday` in `server.js` so the daily Claude background cap only counts Claude pipelines; enforced
  admin-only Claude background policy in readiness and `POST /triggers`; validated folder `git remote origin`
  against the selected repository; prevented tenants from pushing outside `teleharness/*` and blocked pushing
  to the base/default branch in `mode: "new"`; added `ls-remote` 409 guard for deleted `same-branch` targets;
  fixed poll-path fork filtering (`head_repository` / `pull_requests`), CI anti-loop detection
  (`last_agent_sha` / `Co-Authored-By`), `Refs #N` in PR bodies, `filtered_repo` matching in `passesFilters`,
  15-minute poll reconciliation for webhook triggers, and 5 hardening nits (post-signature rate limiting,
  constant-time `verifyKey`, untrusted title framing, webhook cleanup on trigger delete, and connection timeout).

## [2.8.0] — 2026-11-24

### Added
- **Built-in PowerPoint (`.pptx`) preview in FileViewer.** Client-side OOXML parser (`parsePptx` in
  `src/lib/office.js`) renders slides in presentation order with titles, bullet lists, tables, embedded images
  from `ppt/media/*`, and expandable speaker notes directly in the browser — zero server load, instant on mobile.
- **Standalone PWA & mobile file downloads.** FileViewer download buttons now fetch with credentials and deliver
  files via the Web Share API (`navigator.share` with `File`, when supported on mobile standalone PWA) or an
  object-URL `Blob` download fallback, eliminating silent no-ops on iOS standalone home-screen apps.
- **Explicit Copy button on user messages.** Both user and assistant bubbles provide a one-tap Copy action in the
  footer, alongside unrestricted native OS text selection.
- **Full-feature cross-platform installation guides.** Added comprehensive bilingual guides
  ([`docs/installation.md`](docs/installation.md) and [`docs/installation.ru.md`](docs/installation.ru.md))
  covering all 4 engine families, HTTPS/QR/PWA/Push, MCP/Skills right panel, Office/PPTX preview, Git/Worktrees,
  Obsidian, GitHub Background Agents, Temporal pipelines, local CPU voice, multi-user sandboxing, and autostart
  services on Linux, macOS, and Windows.

### Fixed
- **Mobile copy no longer jumps the chat to mid-screen.** Removed long-press `onTouchStart` / `onContextMenu`
  interception in `MessageBubble` (restoring native partial text selection and system Copy menu), guarded
  `AppShell` keyboard detection against `readonly` / off-screen clipboard `<textarea>` elements, and updated
  `clipboard.js` to mark its fallback element `data-clipboard-helper="1"` with `focus({ preventScroll: true })`.
- **Office, Markdown, CSV, and XML preview edge cases.** Hardened `src/lib/office.js` and `FileViewer.jsx`
  against ZIP/OOXML edge cases, UTF-8 BOM & quoted multiline CSV cells, SVG/data-URL safety, filename sanitization,
  POSIX path handling, and upload quota checks.
- **Right panel & UI accessibility polish.** Portaled `SkillModal` directly to `document.body` with focus
  management and Escape/backdrop close, refined `Drawer`, `Composer`, `HomeView`, `ProjectView`, and
  `Settings` state handling.
- **Edge routing & security hardening.** Hardened `ops/portal-server.js` Host validation against open redirects
  (with optional `TELEHARNESS_EDGE_ALLOWED_HOSTS` allowlist), case-normalized prefix redirects, and immediate
  upstream SSE teardown on client disconnect; hardened `worktrees`, `hub`, `oc-client`, and `acp` flows.
- **`.env.example` boolean values.** Updated example flags to `1`/`0` so copying `.env.example` to `.env`
  passes `lib/config.js` strict boolean validation cleanly out of the box.

### Changed
- **Refreshed architecture diagrams & docs.** Updated `docs/architecture-components*.{svg,png}`,
  `docs/architecture.md`, `docs/macos.md`, `ops/README-teleharness.md`, and `ops/voice/README.md` to match
  the current 4-engine architecture (`lib/oc-client.js`, ACP JSON-RPC, SQLite FTS5, desktop right panel,
  built-in PPTX/Office preview, GitHub triggers, Temporal resume-from-checkpoint).

## [2.7.1] — 2026-11-23

This release combines the 2.7.0 and 2.7.1 changes (everything since v2.6.0).

### Added
- **Desktop right panel for open chats (≥ 1024 px).** A fixed 300 px right-hand column displays the current chat's
  **MCP** servers (status dots, localized status labels, error tooltip), available **Skills** (monospaced name +
  ellipsized description, 5 visible rows with *Show all (N)* / *Collapse*), and a live **Plan** section whenever
  the active turn emits steps from ACP (`sessionUpdate: "plan"`), Claude Code (`TodoWrite`), or opencode
  (`todo.updated` / `todowrite`). Each section loads and retries independently; narrow viewports (< 1024 px)
  keep the chat clean with no panel or toggle button.
- **Live search filter & Skill viewer modal.** A search bar at the top of the right panel filters both MCP
  servers (by name or localized status) and Skills (by name, ID, or description), showing match counts (`N/M`)
  and lifting the 5-row cap while keeping the current-turn Plan untouched. Clicking any skill opens a centered
  modal (`GET /teleharness/api/skills/:id`) that strips YAML frontmatter and renders the full `SKILL.md`
  Markdown (admin sees the file path and can pass `?directory=`; tenants are restricted to `teleharness-*`
  skills without path disclosure and receive `403` for other IDs).
- **Turn plan API and hub tracking.** Added `GET /teleharness/api/session/:id/plan`, `teleharness.plan` SSE
  events across ACP, Claude Code, and opencode, automatic plan reset on the next user prompt, and an admin
  reload fallback from loaded message history. Demo mode (`npm run demo`) includes sample skills and multi-step
  plans in both English and Russian.

## [2.6.0] — 2026-11-23

### Added
- **Temporal: resume a run from a step.** A finished, failed or canceled run can continue from its last
  successful step — or any selected step — on the original or the latest published version of the pipe
  (`POST /teleharness/api/temporal/runs/:id/resume`). The planner (`lib/temporal/resume-plan.js`,
  `shared/temporal-resume.js`) builds a topologically closed seed under the worker's
  `resume-from-checkpoint-v1` gate: completed steps (with their results, step chats and condition outcomes) carry
  over unchanged, the run folder and its files are inherited, and only the remaining steps re-run. The run screen
  gets a *Resume from step* button with a sheet (version and start-step pickers, a preview of which steps carry
  over), a *resumed · N steps carried over* badge in the run facts and a continuation link back to the original run.
  Demo mode (`npm run demo`) shows the whole flow on finished and failed runs.

### Fixed
- **Desktop Drawer footer no longer overlaps Recent rows at 1280×720.** `.drawer-foot` is a regular
  flex item (`flex-shrink: 0`) inside the flex-column `.drawer` instead of `position: absolute`, so the footer
  never covers the bottom «Recent» chats on short desktop windows.

### Changed
- **README quality & selling hierarchy (v9).** The bulky search hero between «What it does» and «Board, mobile
  review, worktrees and costs» is gone: chat search stays concise in Features and the tour, the search-pipeline
  diagram moved to Architecture, drawer-height screenshots left the hero area, and the Temporal section explains
  resume-from-step. EN/RU kept symmetric; Configuration now points to every `TELEHARNESS_*` variable group.

## [2.5.4] — 2026-11-23

This release combines the 2.5.3 and 2.5.4 changes (everything since v2.5.2).

### Added
- **Full-text search across chat messages.** A local SQLite FTS5 trigram index (WAL, fully derived — it rebuilds
  itself if the file is deleted) indexes every chat question (cleaned of system injections) and the final text parts
  of answers, across OpenCode and Claude/Codex/ACP chats. `GET /teleharness/api/session/search` is tenant-isolated
  (admins see everything, users only their own directories), keeps itself fresh while you type (debounced live
  updates, indexing progress is reported honestly), and the chat list shows matching chats with a highlighted
  snippet («You:» / «Answer:» roles, `<mark>` highlights, safe regex splitting — no raw HTML). Tapping a hit deep-links
  to `#/chat/:id?mid=…`: the chat auto-loads older history pages until the message is reachable, widens its window,
  scrolls to it and highlights it for a few seconds (works across compact merged turns too).
- **Adaptive recent chats in the desktop sidebar.** On screens ≥ 900 px the «Recent» section fills the available
  panel height (via a `ResizeObserver`, capped at 100, minimum 8) instead of a fixed list; below 900 px it stays 8.

### Fixed
- **Antigravity ACP stale-session guard (post-answer hangs).** An ACP turn interrupted by a restart, crash, stop or
  timeout could leave a non-terminal step row (pending/running/generating/waiting/queued) in the agent's SQLite
  database, after which `session/prompt` never reached idle and the chat hung after its answer. The portal now clears
  the saved ACP session on any abnormal exit and on restart recovery, and — before resuming an Antigravity session —
  does a read-only SQLite check for non-terminal steps, starting a fresh session with the chat history when one is
  found (a damaged or hot-WAL database skips resume for the same reason).

## [2.5.2] — 2026-11-22

### Added
- **OpenCode (GLM) steps in Temporal pipelines.** A *Model* step can now run on OpenCode with `glm-5.3-flash` or
  `glm-5.3`: the model catalog is loaded from your connected OpenCode providers (60-second cache, a fallback list in
  demo mode), permission and question prompts are answered non-interactively so a background step never hangs on a
  dialog, the run detail shows the OpenCode engine label, and a subscription quota error parks the run in
  *Waiting for subscription quota* instead of failing it.
- **Auto-loaded model catalog in the chat picker.** The picker builds a group per connected OpenCode provider —
  subscription plans, free models and API keys — shows a *Refresh* button with loading and error states, keeps the
  saved models when a refresh fails (HTTP 502 does not wipe the cache), and hides pay-per-token OpenCode models from
  tenant users.

### Changed
- Per-tenant policy now covers OpenCode: tenants are served subscription and free (`cost = 0`) OpenCode models, while
  pay-per-token models are hidden and rejected server-side. Refreshed EN & RU demo, screenshots and GIFs with the GLM steps and the new picker states.

### Fixed
- Image support for chat models now follows the OpenCode 2.x `capabilities.input` array instead of assuming text-only.

## [2.5.1] — 2026-11-22

### Added
- **GitHub Background Agents & `pull_request` step.** Connect a fine-grained GitHub PAT in Settings → GitHub
  (stored encrypted on the server, never exposed to agents), then create webhook or 2-minute polling triggers in
  Temporal → Triggers from built-in templates (*Issue → PR*, *Fix CI*, *Nightly dependency update*) or custom pipes.
  The `pull_request` step commits in an isolated worktree and opens a draft PR (or pushes a fix to the same branch
  on red CI), requires explicit human approval when CI files (`.github/workflows`) are modified, tracks trusted
  authors, rate limits, and 14-day event journals with safe replay, and gives admins a global kill-switch and daily
  background Claude quota in Settings → Background agents.
- **Gemini (ACP) in Temporal pipelines & MCP server forwarding in ACP.** Pick Gemini (ACP) models with readable
  labels in Temporal pipe steps, and forward configured MCP servers into ACP `session/new` (respecting per-tenant
  allowlists).
- **Per-tenant Codex & Gemini (ACP) access.** Admins can grant or revoke Codex and Gemini (ACP) per user in
  Settings → Users; tenant runs stay scoped to the user's own folders without shell commands or bypass modes.
- **Approval rework loop & *Plan → approve → code → review* template.** Configure an approval step to send work back
  to an earlier model step with review notes (up to 3 rework cycles), and start from the built-in
  *Plan → approve → code → review* template.
- **Attention Board desktop/tablet preview pane.** On screens ≥ 768 px, clicking any card on *All* or *Needs review*
  opens a right-hand preview pane with full context and quick actions without auto-marking the item as seen.
- **Worktree *Continue in this copy*.** Reopen a merged worktree directly from the Worktree sheet to keep iterating on
  the same branch and working copy.

### Changed
- Full English and Russian localization across GitHub settings, Background agents admin controls, Temporal triggers,
  PR step outcomes, rework sheets, and the Attention Board preview pane.
- Updated `npm run demo` with synthetic GitHub connection, active triggers and event journal, a completed GitHub
  *Issue → PR* run, Gemini (ACP) in Temporal, and approval rework, plus refreshed EN & RU screenshots.

### Fixed
- Cross-OS git `askpass` helper in the `pull_request` step (`.cmd` on Windows, `0700` `.sh` on POSIX).

## [2.4.9] — 2026-11-22

### Added
- **ACP engines: Google Antigravity (Gemini) and GitHub Copilot CLI.** Install and sign in to ACP agents from
  Settings → ACP agents, pick Gemini models (`Gemini 4 Neon`, `Gemini 3.8 Flash`) or GitHub Copilot CLI per chat,
  use roles, permissions, vision attachments, background status & message queue, Plan-First (`plan-ro`) and
  bidirectional Auto-Relay with Gemini.
- **Attention Board (`#/board`).** A single control room across all chats and Temporal runs grouped into
  *Needs you*, *Working*, *Ready* and *Failed*, with a *While you were away* summary, quick actions (approve,
  stop, snooze, mark seen) and per-category Web Push notifications with quiet hours.
- **Mobile Review & Plan-First (`#/board/review`, `#/review/:id`).** A review queue for agent edits, a mobile-first
  diff viewer with line selection and persistent inline draft comments, return-to-agent with structured feedback,
  accept & commit, and a read-only *Plan first* toggle that pauses for approval before any file is touched.
- **Isolated Git Worktrees (`#/worktrees`).** Run each chat or pipeline in its own git worktree and branch, detect
  file overlaps and merge conflicts via dry-run, merge back (squash / merge / fast-forward) with a configurable test
  command, and clean up orphaned branches.
- **API-Equivalent Costs & Subscriptions (`#/settings/costs`).** SQLite ledger of turn usage priced against an
  editable model price table, subscription tracking (including Google Antigravity and GitHub Copilot CLI) with
  savings and payback multiplier, soft monthly budgets, per-chat / per-project / per-run breakdowns, and CSV export.
- **Linux AppArmor `bwrap` profile for Codex** (`ops/linux/`) so Codex sandboxing works out of the box on Ubuntu
  24.04+ kernels with unprivileged userns restrictions.

### Changed
- **New positioning: a self-hosted control room for AI coding agents.** README (English and Russian) opens with
  *Your AI coding agents, from your phone*, updated media (all screenshots, both GIFs and social preview in EN & RU),
  and full `2.4.9` demo coverage in `npm run demo`.
- Full English and Russian localization across all new views (Attention Board, Mobile Review & Plan-First, Git
  Worktrees, Costs & Subscriptions, and ACP Agents).
- A test checks that every local image, link and anchor in both READMEs resolves.

### Fixed
- **ACP Auto-Relay, Relay catch-up, Costs, Push and Plan-First:** ACP JSON-RPC errors (including rate limits with
  code `-32000`) properly trigger bidirectional Auto-Relay; `withRelayCatchUp` and Web Push recognize ACP turns;
  ACP turns are recorded in the cost ledger with Antigravity & Copilot subscriptions; Plan-First (`plan-ro`) works
  for admin ACP chats; engine indicator dots render reliably across viewports.
- **Persistent background-agent bar** stays visible across reconnects and chat switches while background subagents
  are still running.

## [2.0.5] — 2026-11-20

### Fixed
- **One agent turn could stop the whole portal on Linux.** Every agent turn runs as a child of the portal (the CLI,
  browsers or test runs an agent starts). Under systemd, with the default `OOMPolicy=stop`, the kernel killing any of
  them for memory stopped the entire service — every running chat broke and the portal restarted. The new sample unit
  [`ops/linux/teleharness.service`](ops/linux/teleharness.service) sets `OOMPolicy=continue` (only the process that ran
  out of memory dies) and a memory limit with room for concurrent turns; [`docs/macos.md`](docs/macos.md) explains it.
  If you already run Teleharness under systemd, add `OOMPolicy=continue` to your unit.
- The empty-composer mic button is dark in the English UI too (its style was tied to the Russian label).
- Attachment chips sit in one row that scrolls sideways, so the next chip peeks at the edge instead of hiding below
  the fold; long names are shortened in the middle and keep their end and extension (the full name is in the tooltip).
- *Continue automatically on a usage limit*: the switch stays next to the title and no longer jumps when turned on.
- Temporal run screen on a phone: the end of the page (the run files) scrolls clear of the bottom action bar.
- `npm run demo`: *New chat* opens a new chat instead of an empty `#/chat/undefined` screen.

### Changed
- README in English and Russian: the features table lost its decorative icon column, the platform table says yes
  instead of check marks, install commands point to `v2.0.5`, paste and drag-and-drop and the full subagent steps are
  described; every screenshot and GIF is re-captured from the current demo.
- The demo has a Claude chat whose subagent runs 14 commands, to show folded steps and *Show all steps (N)*.

## [2.0.4] — 2026-11-20

### Added
- **Paste files into a chat.** Ctrl/⌘+V in the message field attaches images and files from the clipboard — in a
  chat with any model and engine, through the same path, limits and chips as the paperclip. A screenshot without a
  name becomes *Screenshot YYYY-MM-DD HH-MM-SS.png* (unique within the message). Plain text pastes as text, also
  when an office app puts a rendered picture next to it; text longer than 5000 characters is attached as
  *Pasted text YYYY-MM-DD HH-MM-SS.txt* instead of flooding the field.
- **Drag and drop files into a chat.** Dragging files over the chat area (feed and composer) shows *Drop to attach*
  with the number of files; dropping attaches them. Folders are refused with a reason while the other files attach;
  while the chat is stopping the zone reads *Can't attach right now*; a file dropped anywhere in the window never
  opens in place of the app. Dragging text or links does not show the zone. Light and dark themes.

### Fixed
- **Subagent card hid most of its steps.** The header said, for example, *40 steps* while the expanded card showed
  two to five lines: runs of same-kind steps (mostly commands with Claude) were merged into one line, its *N more*
  was cut off by the ellipsis, and *Show all steps* only appeared above eight lines. A merged line now opens on tap,
  its counter is always visible, *Show all steps (N)* lists every step on its own line, and the header counts all
  steps. Claude subagents keep up to 200 steps (was 40); beyond that the card says *Showing 200 of N steps*.

## [2.0.3] — 2026-11-19

### Added
- **Delete a pipe.** *Delete pipe…* in the pipe editor, with a confirmation sheet that lists the consequences. The
  delete is refused with a reason while the pipe has a running run, a run waiting for your decision or an active
  schedule. Finished runs and their files stay readable on the *Runs* tab, marked *pipe deleted*; a schedule of a
  deleted pipe stays visible, paused.

### Changed
- **Compressed static assets.** Text assets are served brotli- or gzip-compressed according to `Accept-Encoding`
  (the app bundle shrinks from about 826 KB to about 200 KB); the compressed copy is built once per file version.
- **Contrast.** Secondary text and warnings in the light theme reach WCAG AA (at least 4.5:1).

### Fixed
- **Chats failing to open when the engine runs out of memory.** With opencode 2.x the dialogs poll woke every chat
  folder in the engine, and the extra processes ran it out of memory. The poll now only asks folders with busy chats
  or open questions. The chats list also survives a short engine restart: it falls back to the last good list (up to
  2 minutes, `TELEHARNESS_LIST_STALE_MS`) and then to the server's chat index (`TELEHARNESS_LIST_INDEX_STALE_MS`).
  Identical concurrent list and dialog reads share one engine call.
- **Security:** a `directory` (or `location`) in the body of a new-chat request no longer overrides the checked
  `?directory=` folder.
- A message no longer vanishes when a turn fails at once, for example on a provider quota error.
- **Temporal:** a run cancelled or timed out during a model step no longer holds its subscription slot forever.
  The worker frees slots of closed runs after a grace period (one hour by default,
  `TELEHARNESS_TEMPORAL_PERMIT_GRACE_S`; the sweep runs every `TELEHARNESS_TEMPORAL_PERMIT_SWEEP_S`, 300 s). A step
  that is still running keeps its slot.
- A message sent from another device shows its text at once instead of an empty bubble until the turn ends.
- After a chat is handed to another engine, older answers and errors keep the name and colour of the engine that
  wrote them.
- Error details no longer drop the letter “s”.
- The last Codex turn no longer offers *Undo turn* (Codex turns cannot be undone).
- Settings → Active turns shows a turn waiting for your answer to a question or permission as *waiting for your
  answer*, not *running*.
- The usage-limit strip fits a 320 px screen; its buttons wrap their label and stay at least 44 px tall.
- A chat binding is no longer saved under a key that is not a chat id (for example `undefined`).

## [2.0.0] — 2026-11-19

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
- **New README demo GIF** (English and Russian): captioned scenes — three CLIs in one phone app, approving an agent from
  anywhere, handing a chat to another CLI on a usage limit or automatically, and a Temporal pipeline with Claude, your
  approval and Codex.
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

[2.4.9]: https://github.com/al3x4kov/teleharness/releases/tag/v2.4.9
[2.0.5]: https://github.com/al3x4kov/teleharness/releases/tag/v2.0.5
[2.0.4]: https://github.com/al3x4kov/teleharness/releases/tag/v2.0.4
[2.0.3]: https://github.com/al3x4kov/teleharness/releases/tag/v2.0.3
[2.0.0]: https://github.com/al3x4kov/teleharness/releases/tag/v2.0.0
[1.24.2]: https://github.com/al3x4kov/teleharness/releases/tag/v1.24.2
[1.22.0]: https://github.com/al3x4kov/teleharness/releases/tag/v1.22.0
[1.21.0]: https://github.com/al3x4kov/teleharness/releases/tag/v1.21.0
[1.20.0]: https://github.com/al3x4kov/teleharness/compare/v1.19.4...v1.21.0
[1.19.4]: https://github.com/al3x4kov/teleharness/releases/tag/v1.19.4
[1.19.2]: https://github.com/al3x4kov/teleharness/releases/tag/v1.19.2
[1.15.1]: https://github.com/al3x4kov/teleharness/releases/tag/v1.15.1
