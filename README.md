<div align="center">

<img src="docs/screenshots/social-preview.png" alt="Teleharness: one web control room for Claude Code, Codex, Gemini (ACP) and opencode, with optional mobile PWA" width="100%">

## Your AI coding agents in one web control room

**Run Claude Code, Codex, Gemini (ACP) and opencode from one desktop web control room — review diffs and isolated git
worktrees, hand a task over when a usage limit hits, and chain agents into pipelines that survive restarts. Need access
away from your desk? The same interface works as an optional mobile web app / PWA whenever you want it.**

Teleharness is an open-source, self-hosted control room for AI coding CLIs. It runs the real CLIs on your machine —
with their agents, skills, MCP servers, hooks and project context — and adds what a terminal can't: an Attention Board,
inline diff review with Plan-First, isolated git worktrees, a desktop MCP/Skills/Plan right panel, API-equivalent cost
tracking, cross-CLI handoff and durable multi-agent pipelines on [Temporal](https://temporal.io).
All of it runs on the CLI subscriptions you already pay for, not a metered API.

**Chat** · **Search** · **Board & Review** · **Worktrees** · **Relay** · **Pipelines** · **on your subscriptions** · **self-hosted**

[![Release](https://img.shields.io/github/v/release/al3x4kov/teleharness?style=flat-square&color=6366f1)](https://github.com/al3x4kov/teleharness/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/al3x4kov/teleharness/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/al3x4kov/teleharness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-0ea5e9?style=flat-square)](#platform-support)

[What it does](#what-it-does) •
[Board, Review & Worktrees](#board-diff-review-worktrees-and-costs) •
[Switch CLIs](#switch-cli-mid-conversation) •
[Pipelines](#pipelines-that-survive-restarts-temporal) •
[Try the demo](#try-it-in-30-seconds) •
[Tour](#a-quick-tour) •
[Features](#features) •
[Quick start](#quick-start) •
[Architecture](#architecture) •
[Configuration](#configuration) •
[Contributing](CONTRIBUTING.md) •
[Русский](README.ru.md)

<img src="docs/screenshots/desktop-dark-claude.png" alt="Teleharness desktop web control room: Claude Code chat in dark theme with adaptive sidebar, inline file changes, review banner, worktree conflict warning and context meter" width="820">

</div>

---

## What it does

<table>
<tr>
<td width="33%"><img src="docs/screenshots/desktop-light-codex.png" alt="Codex chat on desktop: GPT-6.1 Sol, file edits, passing tests, context meter"></td>
<td width="33%"><img src="docs/screenshots/desktop-light-relay.png" alt="Cross-CLI handoff on desktop: Claude Opus → GLM-5.3 in one shared feed"></td>
<td width="33%"><img src="docs/screenshots/desktop-light-temporal-runs.png" alt="Temporal runs on desktop with approval queues and subscription quota status"></td>
</tr>
<tr>
<td valign="top"><b>Chat</b><br>Claude Code, Codex, Gemini &amp; Copilot (ACP) and opencode side by side in a desktop web UI (with optional mobile PWA): live steps, subagent cards, MCP/Skills/Plan right panel, Plan-First, diffs and git worktrees, files, voice and push notifications.</td>
<td valign="top"><b>Relay</b><br>A subscription runs out mid-task? The same chat continues on another CLI or model — same folder, one feed, the missed turns carried over. Manually or automatically.</td>
<td valign="top"><b>Pipelines</b><br>Chain agents and allowlisted local commands into multi-step runs on Temporal: Claude reviews, you approve, Codex writes — with timers, conditions, schedules, external workflow control and artifacts. Runs survive restarts.</td>
</tr>
</table>

## Board, diff review, worktrees and costs

Run several coding agents at once without juggling ten terminal tabs:

- **Attention Board (`#/board`)** — one feed across every chat and Temporal run (*Waiting for you*, *Working*, *Done*,
  *Failed*) with a *While you were away* summary, a desktop side preview pane (≥ 768 px), quick actions and per-category
  push notifications with quiet hours.
- **Diff Review & Plan-First (`#/board/review`)** — two-pane desktop diff viewer (and touch-friendly single-column view
  on mobile) to select any line or range, leave inline draft comments, send structured feedback back to the agent, or
  accept and commit. Turn on *Plan first* so Claude, Codex, opencode or Gemini writes a read-only plan and waits for
  your approval before touching a single file.
- **Isolated Git Worktrees (`#/worktrees`)** — put each chat or pipeline run on its own branch and worktree, spot file
  overlaps and dry-run merge conflicts early, and merge back (squash / merge / fast-forward) after running your test command.
- **API-Equivalent Costs (`#/settings/costs`)** — every turn is logged in SQLite and priced against an editable model table,
  compared against your real subscriptions (Claude Max, ChatGPT Plus, Google Antigravity, GitHub Copilot CLI) to show
  actual savings, payback multiplier, soft monthly budgets and CSV export.
- **ACP Agents (`#/settings/acp`)** — install and sign in to **Google Antigravity** (`Gemini 4 Neon`, `Gemini 3.8 Flash`)
  and **GitHub Copilot CLI** right from Settings, with roles, vision, Plan-First, Auto-Relay, and automatic stale-session recovery after interrupted turns.

<p align="center">
  <img src="docs/screenshots/desktop-light-board.png" alt="Attention Board on desktop with side preview pane" width="820">
</p>
<p align="center"><sub>Attention Board on desktop: review queues, waiting plans, running pipelines, and a right-hand preview pane (≥ 768 px) without auto-marking items seen.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-review.png" alt="Review screen on desktop with file list and diff pane" width="820">
</p>
<p align="center"><sub>Diff review on desktop: file tree, inline line-range comments, return-to-agent feedback and commit actions.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-worktrees.png" alt="Isolated Git Worktrees on desktop with branch cards, file overlaps and merge conflict badges" width="820">
</p>
<p align="center"><sub>Isolated Git Worktrees: every chat or pipeline run on its own branch with live overlap and dry-run conflict checks.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-costs.png" alt="API-equivalent costs overview with daily chart, subscriptions and payback" width="820">
</p>
<p align="center"><sub>API-equivalent cost breakdown against fixed monthly subscriptions, daily chart and per-model spend.</sub></p>

<details>
<summary>Optional mobile web / PWA view (Board, Diff Review, Plan-First, Worktrees)</summary>

<p align="center">
  <img src="docs/screenshots/phone-light-board.png" alt="Attention Board on mobile with While you were away summary and Waiting for you section" width="180">
  <img src="docs/screenshots/phone-light-review.png" alt="Mobile diff review with line selection and inline draft comments" width="180">
  <img src="docs/screenshots/phone-light-plan.png" alt="Gemini 4 Neon chat with read-only Plan 1 card awaiting approval" width="180">
  <img src="docs/screenshots/phone-light-worktrees.png" alt="Isolated git worktrees on mobile with overlap and conflict detection" width="180">
</p>

</details>

## Switch CLI mid-conversation

Start a task with Claude Code, then continue it with Gemini (ACP), Codex, or opencode on GLM or any other model —
in any direction.

- **From the chat menu, at any time:** *Continue in…* → engine and model.
- **When a subscription runs out:** the usage-limit notice offers *Continue in &lt;model&gt;* — one click.
- **What carries over:** the project folder, one shared feed with a handoff mark, the turns the new CLI missed
  (sent with its first prompt) and, if a knowledge-base folder is set, the full chat journal.
- **Automatically, if you want:** turn on *Continue automatically on a usage limit* in Settings → Model & agents and
  list up to three backup models; the server hands the chat over and asks the new CLI to go on, even unattended.
  Off by default.
- **What doesn't:** the previous CLI's private session state.

<p align="center">
  <img src="docs/screenshots/desktop-light-relay.png" alt="Desktop layout: a chat handed over from Claude Code to opencode" width="820">
</p>
<p align="center"><sub>Cross-CLI handoff on desktop: Claude Opus did the first half, GLM-5.3 picked the task up in the same feed and project folder.</sub></p>

<details>
<summary>Optional mobile web / PWA view (handoff mark, model picker, Auto-Relay settings)</summary>

<p align="center">
  <img src="docs/screenshots/phone-light-relay.png" alt="Handoff mark in one feed: Claude Opus → GLM-5.3" width="220">
  <img src="docs/screenshots/phone-light-relay-sheet.png" alt="Choosing the engine and model to continue on" width="220">
  <img src="docs/screenshots/phone-light-autorelay.png" alt="Settings: Continue automatically on a usage limit" width="220">
</p>

</details>

Details, limits and FAQ: [docs/cross-cli-handoff.md](docs/cross-cli-handoff.md).

## Pipelines that survive restarts (Temporal)

Turn a routine into a pipe: Claude reviews the diff, you approve it in the browser (or optionally from your phone),
Codex writes the release notes and the file lands in the run folder. Each step runs on your CLI subscription as a turn
of your own chat, so you can open its conversation later. Runs keep going while the browser is closed or the server
restarts.

Why Temporal: every step is a durable activity, model calls are recorded exactly once in a ledger (or run locally
without PostgreSQL via `TELEHARNESS_TEMPORAL_LEDGER=none`), a *Human decision* step can wait for days without holding
a process, and concurrency slots per engine and per user keep your subscriptions within their limits.

A run that failed or was stopped doesn't start from zero: **Resume from step** continues it from the last successful
step — or any step you pick — on the same or the latest published version of the pipe. Completed steps are carried
over as-is (with their results and step chats), only the rest re-runs, the run folder and its files are inherited, and
the run screen shows a badge with a link back to the original run.

<p align="center">
  <img src="docs/screenshots/desktop-light-temporal-runs.png" alt="Runs on desktop: a run waiting for subscription quota, filters and statuses" width="820">
</p>
<p align="center"><sub>Runs list on desktop: when a subscription (including OpenCode) hits its quota, the step parks in <i>Waiting for subscription quota</i> — the run stays resumable instead of failing.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-temporal-triggers.png" alt="Temporal Triggers: GitHub background agents with webhook and polling status" width="820">
</p>
<p align="center"><sub>GitHub Background Agents: trigger pipelines on issue labels, comment commands or red CI and open draft PRs automatically.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-temporal-resume.png" alt="A finished run on desktop with the Resume from step button" width="820">
</p>
<p align="center"><sub>Resume from step: inspect step outputs and resume from the last successful step or any chosen point.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-temporal-resume-sheet.png" alt="Desktop resume dialog: version and start-step pickers with a preview of carried-over steps" width="400">
  <img src="docs/screenshots/desktop-light-temporal-resumed.png" alt="Continued run on desktop with carried-over steps badge and link to original run" width="400">
</p>

<p align="center">
  <img src="docs/screenshots/desktop-light-temporal-result.png" alt="Run result on desktop: final answer, step history and saved artifacts" width="820">
</p>

Steps: *Model* (Claude, Codex, Gemini ACP or OpenCode — GLM models are loaded from your connected OpenCode
providers), **Command** (allowlisted local scripts executed without a shell, or external Temporal workflows/schedules),
*Human decision* (with up to 3 rework cycles back to a model step), *Open PR* (isolated worktree → draft PR or
same-branch CI fix, with approval gate for `.github/workflows`), *Timer*, *Join*, *Condition*, *Artifact*; run inputs
as `{{input.name}}`, earlier answers as `{{steps.id}}`; schedules with a preview of the next runs; an admin
**External** tab to inspect and control any Temporal workflow (Start, Signal, Query, Reset, Cancel, Terminate); and
**GitHub Background Agents** (webhooks or 2-min polling on issue labels, `/agent` commands and red CI, with trusted
authors, 14-day event journal and admin kill-switch). Optional, Linux and macOS — see [docs/temporal.md](docs/temporal.md).
Try it without any setup in `npm run demo`.

<details>
<summary>Optional mobile web / PWA view (Temporal walkthrough GIF &amp; mobile screens)</summary>

<p align="center">
  <img src="docs/screenshots/temporal.gif" alt="A waiting run: Claude's review next to Approve; after approval Codex writes release notes and notes.md opens" width="300">
</p>

<p align="center">
  <img src="docs/screenshots/phone-light-temporal-runs.png" alt="Runs on mobile: waiting decisions and statuses" width="180">
  <img src="docs/screenshots/phone-light-temporal-editor.png" alt="Pipe editor on mobile: OpenCode model step" width="180">
  <img src="docs/screenshots/phone-light-temporal-result.png" alt="Run result on mobile: final answer and run files" width="180">
  <img src="docs/screenshots/phone-light-temporal-condition.png" alt="A condition that was false: next step skipped" width="180">
</p>

<p align="center">
  <img src="docs/screenshots/phone-light-temporal-resume.png" alt="Finished run on mobile with Resume from step button" width="200">
  <img src="docs/screenshots/phone-light-temporal-resume-sheet.png" alt="Resume sheet on mobile: version and start-step pickers" width="200">
  <img src="docs/screenshots/phone-light-temporal-resumed.png" alt="Continued run on mobile with carried-over badge" width="200">
</p>

</details>

## Why Teleharness

Chat apps give you a model. Agent CLIs give you much more — tools, file access, subagents, skills,
MCP servers, hooks, project memory — but managing parallel agents across raw terminal tabs quickly falls apart.

Teleharness puts a unified desktop web control room in front of those CLIs (with an optional mobile web / PWA view if
you ever want to check in from your phone) — and lets you chain them into durable pipelines:

- **CLIs, not models.** Each chat runs through `opencode serve`, the `claude` CLI, the `codex` CLI or ACP agents.
  Whatever you have configured there — agents, skills, plugins, MCP — works right in the browser.
- **Many providers through one portal.** opencode talks to Z.ai GLM, OpenAI, Google Gemini, Anthropic,
  OpenRouter, local models and more; Claude Code brings your Claude subscription, Codex your ChatGPT
  subscription. Pick the engine and model per chat — the picker auto-loads each OpenCode provider's model list and
  refreshes it on demand.
- **Agents that work in the background.** Pipelines on Temporal run multi-step jobs across Claude, Codex, Gemini ACP,
  opencode and allowlisted commands, pause for your approval and resume after restarts — on your subscriptions, never
  a paid API.
- **A task survives a usage limit.** When a subscription runs out mid-task, hand the chat over to another
  engine or model: same folder, one feed, and the new engine receives the turns it missed.
- **Memory that outlives a chat.** An Obsidian vault works as an active cache: agents get a snapshot
  of your notes at the start of a chat and leave a digest after each turn.
- **Your machine, your data.** Files, tools and history stay on your server. Providers only see the
  prompts and tool results needed for inference.
- **You stay in control.** Per chat, choose whether the agent asks before edits and commands; approve or deny
  right in the chat or via optional Web Push notifications.
- **Desktop-first, mobile when you want it.** Full desktop workspace with adaptive sidebar, MCP/Skills/Plan right panel
  and two-pane diff review; optionally pair a phone via QR code to monitor runs or approve plans on the go.
- **Share it safely.** Multiple users with their own folders, quotas and system prompts; on Windows
  their commands run in an AppContainer sandbox, on Linux through an optional per-user runner.

## Try it in 30 seconds

No engines, no API keys — the UI on synthetic chats:

```bash
git clone https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
npm run demo     # → http://127.0.0.1:4171/teleharness/
```

## A quick tour

All screenshots are taken from `npm run demo` — what you see is what you get.

### Desktop web workspace

<p align="center">
  <img src="docs/screenshots/desktop-light-right-panel.png" alt="Desktop chat with the right panel: search filter, MCP servers, Skills and live 2/4 turn plan" width="820">
</p>
<p align="center"><sub>Desktop right panel (&ge; 1024 px): live MCP statuses, searchable Skills with full SKILL.md modal preview, and the current turn plan.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-skill-modal.png" alt="Skill viewer modal rendering full SKILL.md Markdown over the desktop chat" width="820">
</p>
<p align="center"><sub>Skill viewer modal: inspect full rendered SKILL.md documentation without leaving the chat.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-codex.png" alt="Codex on desktop: GPT-6.1 Sol, file edits, tests and context meter" width="820">
</p>
<p align="center"><sub>Codex CLI on desktop: file edits, passing tests, permission modes and live context meter.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-home-search.png" alt="Full-text chat search on desktop with highlighted snippets and deep links" width="820">
</p>
<p align="center"><sub>Full-text SQLite FTS5 message search across all chats with highlighted snippets and deep links into history.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-drawer-1440.png" alt="Desktop sidebar at 2560×1440 filling height with Recent chats" width="400">
  <img src="docs/screenshots/desktop-light-drawer-720.png" alt="Desktop sidebar at 1280×720 keeping footer cleanly below Recent chats" width="400">
</p>
<p align="center"><sub>Adaptive desktop sidebar (&ge; 900 px): fills available height with Recent chats while keeping the user footer cleanly pinned at the bottom.</sub></p>

<p align="center">
  <img src="docs/screenshots/desktop-light-settings-about.png" alt="Desktop Settings → About showing Teleharness 2.12.0, opencode 2.2.6 and Claude Code" width="400">
  <img src="docs/screenshots/desktop-light-pair.png" alt="Desktop Settings → Connect a phone with optional one-time QR code" width="400">
</p>
<p align="center"><sub>Settings → About (exact portal and engine versions) and optional QR phone pairing when you want mobile access.</sub></p>

### Optional mobile web / PWA

If you choose to expose the portal over HTTPS, the exact same web app adapts to iOS Safari and Android Chrome as an
installable standalone PWA — completely optional.

<details>
<summary>Show mobile web / PWA gallery &amp; animated walkthrough</summary>

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Teleharness optional mobile PWA walkthrough: Claude Code, Codex and opencode in one app, approvals, relay and Temporal pipelines" width="300">
</p>

<table>
<tr>
<td width="25%"><img src="docs/screenshots/phone-light-home.png" alt="Chat list with the message search field"></td>
<td width="25%"><img src="docs/screenshots/phone-light-agents.png" alt="A turn that delegates work to subagents"></td>
<td width="25%"><img src="docs/screenshots/phone-light-agent-open.png" alt="A subagent card opened: steps and the answer"></td>
<td width="25%"><img src="docs/screenshots/phone-light-relay.png" alt="Handoff mark between two engines in one feed"></td>
</tr>
<tr>
<td valign="top"><b>Chats</b><br>Every chat is bound to an engine, a model and an agent. Claude Code chats are marked.</td>
<td valign="top"><b>Subagents</b><br>When an agent delegates, each run is a card: who, what for, how long, how many steps and tokens.</td>
<td valign="top"><b>Inside a run</b><br>Open a card to see the subagent's steps and its answer, or jump to its own chat.</td>
<td valign="top"><b>Relay</b><br>Hit a usage limit? The same chat continues on another engine — one feed, with a handoff mark.</td>
</tr>
<tr>
<td width="25%"><img src="docs/screenshots/phone-light-relay-sheet.png" alt="Choosing the engine and model to continue on"></td>
<td width="25%"><img src="docs/screenshots/phone-light-subscriptions.png" alt="Subscriptions: usage per provider"></td>
<td width="25%"><img src="docs/screenshots/phone-dark-steps.png" alt="Tool steps and result files, dark theme"></td>
<td width="25%"><img src="docs/screenshots/phone-dark-home.png" alt="Chat list with the message search field, dark theme"></td>
</tr>
<tr>
<td valign="top"><b>Pick where to continue</b><br>From the chat menu at any time, or straight from the limit notice. The folder stays the same.</td>
<td valign="top"><b>Subscriptions</b><br>Usage and remaining quota per connected provider, where it reports them through an official API.</td>
<td valign="top"><b>Steps and files</b><br>Reasoning, tool calls with output, and result files as cards with preview and download.</td>
<td valign="top"><b>Light and dark</b><br>Follows the system theme or your choice; touch-friendly when used on a phone.</td>
</tr>
</table>

</details>

## Features

| | |
|---|---|
| **Four engine families, one UI** | opencode (any provider), Claude Code, Codex CLI and ACP agents (Google Antigravity / Gemini & GitHub Copilot CLI) side by side; each chat sticks to its engine, model and agent. The picker groups models by connected opencode provider (subscription, free, API) with a "Refresh list" button; paid per-token opencode models stay hidden from non-admin users. Admins can grant Claude, Codex and Gemini (ACP) access per user in Settings → Users (scoped to their own folders, no shell).<br><img src="docs/screenshots/phone-light-picker-codex-detail.png" alt="Model picker in a Codex chat: pinned engine, model list and Refresh list button" width="180"> <img src="docs/screenshots/phone-light-settings-model.png" alt="Model catalogue in Settings: Z.AI Coding Plan (opencode), Claude and Codex groups with GLM-5.3 models and Refresh list" width="180"> <img src="docs/screenshots/phone-light-picker-refresh-error.png" alt="Refresh error: the picker keeps the previous list and explains what failed" width="180"> <img src="docs/screenshots/phone-light-acp.png" alt="Settings: ACP Agents with Google Antigravity and GitHub Copilot CLI" width="180"> |
| **Attention Board** | One inbox for every chat and Temporal run: *Waiting for you*, *Working*, *Done* and *Failed*, a *While you were away* summary, desktop side preview pane (≥ 768 px), quick actions and per-category push with quiet hours.<br><img src="docs/screenshots/desktop-light-board.png" alt="Attention Board on desktop" width="320"> |
| **Message search** | Full-text search across every user message and reply in all chats: highlighted snippets with "You:" / "Reply:" roles and match counts, jumping straight to the message (loading older history first, then highlighting), backed by a derived local SQLite FTS5 (trigram) index with tenant isolation and graceful title-search fallback while the index builds.<br><img src="docs/screenshots/desktop-light-home-search.png" alt="Chat search on desktop: highlighted snippets, roles and match counts" width="320"> |
| **Adaptive Recent list** | On desktop (≥ 900 px) the sidebar's Recent list fills the viewport height instead of stopping at eight rows — up to 100 chats within reach (minimum 8; compact 40 px rows on desktop so the footer stays cleanly below the list even on 1280×720/800 screens).<br><img src="docs/screenshots/desktop-light-drawer-1440.png" alt="Sidebar on 2560×1440: Recent fills the viewport height with 16 rows" width="240"> <img src="docs/screenshots/desktop-light-drawer-720.png" alt="Sidebar on 1280×720: Recent fills the shorter pane with the footer cleanly below" width="240"> |
| **Desktop right panel: MCP, Skills & turn plan** | On desktop (≥ 1024 px) an open chat gets a fixed 300 px right panel showing connected **MCP** servers, available **Skills** and the live **Plan** of the current turn (ACP, Claude Code and opencode). A live search bar filters both MCP and Skills with match counts, and clicking any skill opens a modal with the rendered `SKILL.md` (tenants see only allowed `teleharness-*` skills without file paths).<br><img src="docs/screenshots/desktop-light-right-panel.png" alt="Desktop chat with the right panel showing MCP, Skills and a 4-step turn plan" width="240"> <img src="docs/screenshots/desktop-light-skill-modal.png" alt="Skill viewer modal rendering full SKILL.md Markdown over the chat" width="240"> |
| **Diff Review & Plan-First** | Review queue across chats and runs, two-pane desktop diff (and single-column mobile view) with line selection and persistent inline draft comments, return-to-agent and accept/commit. *Plan first* makes the agent propose a read-only plan and wait for approval before editing files.<br><img src="docs/screenshots/desktop-light-review.png" alt="Desktop diff viewer" width="280"> <img src="docs/screenshots/phone-light-plan.png" alt="Gemini Plan 1 approval card" width="150"> |
| **Isolated Git Worktrees** | Give each chat or pipeline run its own git worktree and branch, detect cross-chat file overlaps and dry-run merge conflicts, merge with squash/merge/ff after running tests, and prune orphaned branches.<br><img src="docs/screenshots/desktop-light-worktrees.png" alt="Project worktrees list and merge settings on desktop" width="320"> |
| **API-equivalent costs** | SQLite turn cost log priced against an editable table, real subscriptions (Claude Max, ChatGPT Plus, Google Antigravity, Copilot CLI) with savings and payback multiplier, soft monthly budgets, per-chat / per-project / per-run totals and CSV export.<br><img src="docs/screenshots/desktop-light-costs.png" alt="Costs overview on desktop" width="320"> |
| **Permission mode per chat** | *Ask* — the agent asks before file edits and commands, you approve or deny in the chat (Claude through a permission bridge, Codex natively); *Edits without asking*; *No questions* (admin only).<br><img src="docs/screenshots/phone-light-ask.png" alt="In-chat permission request for a migration command with Allow and Deny" width="180"> <img src="docs/screenshots/phone-light-permission-modes.png" alt="Permission modes: Ask, Edits without asking, No questions" width="180"> |
| **Waiting for you** | A chat list filter with a count of chats where an agent waits for your decision, plus a push notification when it starts waiting.<br><img src="docs/screenshots/phone-light-waiting.png" alt="Waiting for you filter enabled with one chat needing approval" width="180"> |
| **Context and cost** | A meter above the composer: how full the model's context window is (with a warning past 80 %) and what the chat has cost — or that it runs on a subscription.<br><img src="docs/screenshots/phone-light-context.png" alt="Answer footer: subscription and Context 41 percent" width="180"> <img src="docs/screenshots/phone-light-context-warning.png" alt="Context warning at 86 percent, almost full" width="180"> |
| **Agent steps** | Live turn progress: reasoning, tool calls with output, background tasks. Each subagent run is a card with its duration, step count and tokens; open it to see every step — runs of the same tool fold into one line that expands on click, and *Show all steps (N)* lists them one by one. Undo a turn and its file edits.<br><img src="docs/screenshots/phone-light-agent-steps.png" alt="A subagent card with 14 steps: a folded line of commands opened step by step" width="180"> |
| **Turn changes and Git** | An answer that edited files gets a *Changes · N files* row: open it for a per-file diff — what this turn changed, or the file now against the last commit (two panes on desktop, one column on narrow screens). The Git screen of the chat folder shows the branch, ahead/behind and changed files: tick the files to commit, let the chat's own model suggest the message in a separate short request (it never lands in the chat history), commit, and push — push is for the admin only. Other users work with git in their own folders, without push or branch switching. Settings → Git holds the commit author, the message language and the default selection. |
| **Background subagents keep working** | Claude Code answers right away while subagents it started in the background keep running after the answer. A band above the composer shows who is still working; a new message waits in the queue, and Claude picks up their results and answers again when they finish. |
| **Temporal pipelines & GitHub Background Agents** *(optional)* | Multi-step scenarios that survive restarts: Claude, Codex, Gemini (ACP) or OpenCode (GLM) steps, allowlisted **Command** steps (local scripts without a shell or external Temporal workflows/schedules), human approvals with rework loops (up to 3 cycles), *Open PR* steps in isolated worktrees, timers, conditions and saved artifacts. Also runs locally without PostgreSQL (`TELEHARNESS_TEMPORAL_LEDGER=none`) and includes an admin **External** tab to inspect and control any Temporal workflow (Start, Signal, Query, Reset, Cancel, Terminate). A finished or failed run resumes from its last successful step — or any step you choose — carrying over the completed steps, the run folder and step chats. Connect a fine-grained GitHub PAT in Settings → GitHub to trigger pipes automatically via webhook or polling (*Issue → PR*, *Fix CI*, *Nightly dependency update*) with trusted authors, event journal and an admin kill-switch. Runs on your CLI subscriptions, never a paid API. Linux and macOS; off by default — see [docs/temporal.md](docs/temporal.md).<br><img src="docs/screenshots/desktop-light-temporal-runs.png" alt="Temporal runs on desktop" width="240"> <img src="docs/screenshots/desktop-light-temporal-triggers.png" alt="Temporal Triggers on desktop" width="240"> <img src="docs/screenshots/phone-light-github.png" alt="Settings: GitHub fine-grained token and repository readiness" width="140"> |
| **Relay between engines** | Hit a usage limit mid-task? Continue the same chat on another engine or model: same folder, one feed, and the new engine gets the turns it missed. Optionally automatic, with your own order of backup models. |
| **Subscriptions** | Usage and remaining quota per connected provider, where the provider reports it through an official API. |
| **Reliable streaming** | One SSE hub for every engine with replay, stall detection and loop protection — survives disconnects and tab sleep without losing output. |
| **Files & Office preview** | Attach files and images with the paperclip, paste them (Ctrl/⌘+V — a screenshot gets a dated name, a long pasted text becomes a .txt file) or drag them onto the chat. Result files come back as cards with built-in browser preview for **PowerPoint (`.pptx`)** (slides, bullet lists, tables, embedded images, speaker notes), `.docx`, `.xlsx`, `.csv`, `.pdf`, `.md`, `.html`, code, and media — plus authenticated downloads that also work in iOS/Android standalone PWA (Web Share API + Blob fallback). Browse allowed folders; a folder per chat.<br><img src="docs/screenshots/phone-light-pptx.png" alt="Built-in PowerPoint .pptx preview: slides, bullet lists, speaker notes and table" width="180"> <img src="docs/screenshots/phone-light-drop.png" alt="Dragging three files over a chat: Drop to attach" width="180"> <img src="docs/screenshots/phone-light-attached.png" alt="Pasted screenshot and dropped files as chips in the composer" width="180"> |
| **Obsidian as active cache** | Vault snapshot in context, turn digests and a per-chat journal written back, an isolated zone per user. |
| **Voice** | Local speech-to-text and text-to-speech (Python worker, CPU only) and a hands-free voice mode. |
| **Push notifications** | Get notified when a long turn is done or an agent needs your decision (Web Push, VAPID). |
| **Optional phone pairing by QR** | Settings → Connect a phone shows a one-time QR code (valid 10 minutes); scan it if you want to sign in from a phone without typing a token. Needs `TELEHARNESS_PUBLIC_URL`.<br><img src="docs/screenshots/desktop-light-pair.png" alt="Connect a phone on desktop: QR code, expiry, one-time link and Copy" width="320"> |
| **Multi-user** | Admin and users with own folders, system prompts, MCP sets, upload and voice quotas, rate limits. |
| **Settings → About** | The exact version of the portal and every engine in one place — handy when filing an issue.<br><img src="docs/screenshots/desktop-light-settings-about.png" alt="Settings, About detail page: Teleharness 2.12.0, opencode 2.2.6, Claude Code" width="320"> |
| **Desktop-first + optional mobile PWA** | Built for desktop browsers (light & dark themes, adaptive sidebar, right panel, keyboard navigation, English and Russian UI) and responsive down to iOS Safari / Android Chrome standalone PWA if you choose to use it on mobile (native touch text selection, one-tap Copy, safe areas). |
| **Zero runtime dependencies** | The backend is plain Node.js stdlib. |

## Quick start

> [!TIP]
> **Want every feature working out of the box?** See the **[Full Installation Guide (`docs/installation.md`)](docs/installation.md)** ([по-русски: `docs/installation.ru.md`](docs/installation.ru.md)) — complete step-by-step setup for Linux, macOS, and Windows covering all 4 engine families, desktop workspace, MCP/Skills right panel, Office/PPTX preview, Git & Worktrees, Obsidian active cache, GitHub Background Agents, Temporal pipelines, local CPU voice, multi-user sandboxing, autostart services, and optional HTTPS + QR mobile PWA + Web Push.

### Requirements

| | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 22.5 (22 LTS / 24 LTS) | the portal & built-in SQLite FTS5 search/costs/board |
| [Git](https://git-scm.com) | ≥ 2.20 | Git screen, diff review, isolated Worktrees |
| [opencode](https://opencode.ai) | 2.x (tested with 2.2.6) | the opencode engine |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 2.x | the Claude engine |
| [Codex CLI](https://github.com/openai/codex) | 0.169+ | optional, the Codex engine (admin by default; grantable per user) |
| ACP CLI (`gemini` / `copilot` / custom) | latest | optional, ACP agents configured in Settings → ACP Agents |
| Python | 3.11+ | optional, local CPU voice worker & Temporal pipeline worker |

You need at least one engine.

### One command

```bash
npx github:al3x4kov/teleharness            # → http://127.0.0.1:4180/teleharness/
```

It checks Node, keeps its data in `~/.teleharness`, builds the UI on the first run, tells you which engines it
found (and how to install the missing ones) and prints the admin token. Options: `--port N`, `--host 0.0.0.0`
(reachable from your LAN), `--rebuild`. opencode serve is not started for you — the installer prints the command.

### Install and run

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
git clone --branch v2.12.0 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci && npm run build

cp .env.example .env               # every value is optional

# engines (you need at least one)
opencode auth login                # add the providers you want
claude setup-token                 # Claude engine: put the token into .env as CLAUDE_CODE_OAUTH_TOKEN

./ops/opencode/serve-v2.sh &       # opencode 2.x on 127.0.0.1:4196, password in ~/.teleharness/oc2-password
./ops/web-v2.sh                    # → http://127.0.0.1:4170/teleharness/
```
</details>

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
git clone --branch v2.12.0 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci; npm run build

Copy-Item .env.example .env        # every value is optional

opencode auth login
claude setup-token

# opencode 2.x with HTTP Basic auth; the portal gets the same password
$env:OPENCODE_SERVER_PASSWORD = [guid]::NewGuid().ToString('N')
Start-Process opencode -ArgumentList 'serve','--hostname','127.0.0.1','--port','4196'

$env:TELEHARNESS_OC_API = 'v2'; $env:TELEHARNESS_UPSTREAM = 'http://127.0.0.1:4196'; $env:TELEHARNESS_OC_PASSWORD = $env:OPENCODE_SERVER_PASSWORD
node server.js                     # → http://127.0.0.1:4170/teleharness/
```
</details>

Full step-by-step guide for **all features on Linux, macOS, and Windows**: [`docs/installation.md`](docs/installation.md)
(Mac-specific launchd & optional phone checklist: [`docs/macos.md`](docs/macos.md)). On Linux, run it as a
systemd service from [`ops/linux/teleharness.service`](ops/linux/teleharness.service) — it keeps one agent turn that runs
out of memory from stopping the whole portal.

On first start the portal creates an admin and writes the login token to `data/admin-token.txt`
(or uses `TELEHARNESS_ADMIN_TOKEN`). Open it directly in your desktop browser at `http://127.0.0.1:4170/teleharness/`.
If you also want optional mobile web / PWA access, put it behind TLS — the bundled edge server
(`ops/portal-server.js`) or any reverse proxy (Caddy, nginx, Tailscale Serve).

> [!NOTE]
> The portal is served under `/teleharness/`; every setting is a `TELEHARNESS_*` environment variable
> (see [`.env.example`](.env.example)).

### Platform support

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Portal, opencode and Claude engines, files, push | yes | yes | yes |
| Codex & ACP engines (chats) | yes (admin; grantable per user) | yes (admin; grantable per user) | yes (admin; grantable per user) |
| Temporal pipelines (optional) | yes | yes | — |
| Codex in Temporal pipelines | yes (text-only for regular users) | yes (text-only for regular users) | — |
| Obsidian cache, voice | yes | yes | yes |
| Shell commands for non-admin users | — | yes, with the optional per-user runner¹ | yes (AppContainer sandbox) |

On macOS (and on Linux without the runner) shell access for regular users is refused (fail-closed); admins are not
affected. ¹ On Linux, users' shell commands can run through a per-user runner (`/usr/local/libexec/teleharness-tenant-run`,
see `ops/sandbox/linux`); without it they stay refused.
User isolation is moving to one container per user with the full agent runtime — the same on every host OS —
so the Windows sandbox is intentionally not ported to other systems.

## Architecture

<p align="center"><img src="docs/architecture-components.png" alt="Teleharness components: desktop web UI and optional mobile PWA, portal with SQLite FTS5/costs/board, harness of four engine families (opencode 2.x, Claude Code, Codex, ACP), Obsidian, voice, sandbox, GitHub and Temporal pipelines, model providers" width="900"></p>

- **Portal** (`server.js`) — API, auth and users, the event hub, chat-to-engine binding, the handoff between
  engines, SQLite FTS5 chat search, attention board, costs, and Git/Worktree APIs. One adapter per engine family:
  `lib/oc-client.js` for `opencode serve` (1.x and 2.x), runners for `claude` CLI and the Codex shim over
  `codex app-server`, and the ACP JSON-RPC bridge (`lib/acp-chat.js`) for Gemini / Copilot / custom ACP agents.
- **Harness** — everything around the CLI: agents and orchestration (oh-my-opencode-slim), the
  knowledge-base and sandbox plugin for opencode (`ops/opencode/plugin-v2` for 2.x, `vault-cache.ts` for 1.x),
  Claude Code hooks, skills, MCP servers. This decides what an agent can do and
  what it knows.
- **Obsidian** — long-term memory for agents, one zone per user; also holds the per-chat journal an engine
  reads after a handoff.
- **Voice** — a separate local Python process (Piper TTS, GigaAM STT).
- **Sandbox** — other users' shell commands: an optional per-user runner on Linux, AppContainer on Windows,
  refused on macOS.
- **Temporal pipelines** (optional, Linux and macOS) — a Temporal server, a Python worker and optional PostgreSQL
  (history, exactly-once ledger, concurrency slots; or local mode via `TELEHARNESS_TEMPORAL_LEDGER=none`). A model
  step is a turn of a portal chat in the pipe's folder, reached through a private socket; command steps run allowlisted
  scripts or external Temporal workflows. See [`docs/temporal.md`](docs/temporal.md).

The layer-by-layer picture and the path of a request:

<p align="center"><img src="docs/architecture-layers.png" alt="Teleharness v2.12.0 architecture layers: desktop web UI and optional mobile PWA, portal server, four CLI engine families, Temporal and voice workers, storage and providers" width="820"></p>

Chat search runs on a derived index that can always rebuild itself:

<p align="center"><img src="docs/search-pipeline.png" alt="Search pipeline: messages are cleaned and fed into a derived SQLite FTS5 trigram index, queried through a tenant-isolated API, and rendered as snippets with deep links into the chat" width="820"></p>
<p align="center"><sub>Messages are cleaned and fed into a local SQLite FTS5 (trigram) index, queried through a tenant-isolated API, and rendered as snippets with deep links into the chat.</sub></p>

More: [`docs/architecture.md`](docs/architecture.md) (in Russian), requirements in [`openspec/specs/`](openspec/specs/).

## Configuration

Everything is configured with environment variables; the schema with types, defaults and validation is
[`lib/config.js`](lib/config.js), the template is [`.env.example`](.env.example).

| Variable | Default | |
|---|---|---|
| `PORT` | `4170` | portal port |
| `TELEHARNESS_UPSTREAM` | `http://127.0.0.1:4096` | `opencode serve` address (the default is the opencode 1.x legacy port; with 2.x use `:4196`) |
| `TELEHARNESS_OC_API` | `v1` | `v2` for opencode 2.x (`ops/web-v2.sh` sets it) |
| `TELEHARNESS_OC_PASSWORD` | — | HTTP Basic password of `opencode serve` 2.x |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription token (`claude setup-token`) |
| `TELEHARNESS_ADMIN_TOKEN` | generated | admin login token |
| `TELEHARNESS_PUBLIC_URL` | — | public https address of the portal root (`https://host/teleharness/`) for optional phone pairing QR code; empty — no QR |
| `TELEHARNESS_CODEX` | on | `off` hides the Codex engine even when `codex` is installed and signed in |
| `TELEHARNESS_CODEX_BIN` | `codex` from npm global or `PATH` | path to the codex binary or its `bin/codex.js` |
| `TELEHARNESS_DATA_DIR` | `./data` | users, sessions, logs |
| `TELEHARNESS_FILE_ROOTS` | home folder | folders available in the file browser |
| `TELEHARNESS_KB_ROOT` | `off` | Obsidian vault folder for agents, e.g. `~/Obsidian/agents` |
| `TELEHARNESS_TENANT_HOME` | `~/.teleharness-tenants` | users' folders |
| `TELEHARNESS_VOICE_PYTHON`, `TELEHARNESS_VOICE_MODELS` | `~/.teleharness/voice/…` | local voice worker |

Feature groups and tuning knobs are in the same schema: `TELEHARNESS_LISTEN_HOST` / `TELEHARNESS_ENV`
(bind address, stand guard), `TELEHARNESS_EDGE_ALLOWED_HOSTS` (edge HTTPS redirect allowlist), `TELEHARNESS_ACP`
(ACP agents), `TELEHARNESS_PUSH…` (Web Push: on/off, VAPID keys, quiet-hour batching),
`TELEHARNESS_VOICE…` (speech-to-text / text-to-speech limits per user), `TELEHARNESS_TENANT…` (per-user
rate, upload and vision limits), and the Temporal set — `TELEHARNESS_TEMPORAL_PIPELINES`,
`TELEHARNESS_TEMPORAL_LEDGER`, `TELEHARNESS_TEMPORAL_MODELS`, `TELEHARNESS_TEMPORAL_DRAIN` and friends — documented in
[`docs/temporal.md`](docs/temporal.md). The complete list with types, defaults and validation lives in
[`lib/config.js`](lib/config.js); unknown variables fail the start.

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
| `ops/` | launch scripts, opencode plugins, edge server, sandbox, voice worker, document rendering |
| `config/` | Claude Code and opencode configs |
| `tests/`, `fixtures/`, `fixtures-demo/` | tests and synthetic fixtures |
| `openspec/specs/`, `docs/` | requirements, architecture, ADRs |

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Built with

[opencode](https://opencode.ai) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex CLI](https://github.com/openai/codex) · [Temporal](https://temporal.io) ·
[oh-my-opencode-slim](https://www.npmjs.com/package/oh-my-opencode-slim) · [Preact](https://preactjs.com) ·
[esbuild](https://esbuild.github.io) · [marked](https://marked.js.org) · [DOMPurify](https://github.com/cure53/DOMPurify) ·
[highlight.js](https://highlightjs.org) · [Piper](https://github.com/rhasspy/piper) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)

## License

[MIT](LICENSE). Bundled third-party files keep their licenses: `openspec-*` / `opsx-*` skills and
commands — MIT ([OpenSpec](https://github.com/Fission-AI/OpenSpec)), the `dogfood` skill — Apache-2.0.
