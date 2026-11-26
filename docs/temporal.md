# Temporal pipelines (optional)

Teleharness can run **pipelines** — multi-step scenarios that survive restarts — on top of
[Temporal](https://temporal.io). The feature is **off by default**: without it the *Temporal* section explains that
execution is not connected, and you can still draft pipes.

## What a pipe can do

| Step | What it does |
|---|---|
| **Model** | Runs the instruction as a turn of your own chat with Claude Code, Codex, Gemini (ACP) or OpenCode (GLM models are loaded from your connected OpenCode providers), inside the pipe's run folder: it can read and create files. Runs on your CLI subscription; no paid API is used. The step's conversation opens from the run. For regular users Codex answers with text only (Codex has no per-user sandbox) and pay-per-token OpenCode models are hidden from regular users. When a subscription hits its quota (including an OpenCode quota error), the step parks in *Waiting for subscription quota* instead of failing the run. |
| **Command** | Runs an allowlisted command from the admin catalog without a shell (`exec`) or triggers/starts an external Temporal workflow or schedule (`temporal-workflow`). Supports typed parameters with `{{input.*}}` / `{{steps.*}}` interpolation, clean environment allowlist, symlink-escape protection, 1 MiB tail-truncated stdout artifacts, concurrency slots (`slot_wait`), and SQLite idempotency. |
| **Human decision** | Stops and waits for *Approve* / *Reject*, showing the previous step's answer next to the buttons. |
| **Timer** | Waits for a given time. |
| **Join** | Continues when all marked branches finish. |
| **Condition** | Continues only if a step's answer or a run input matches (equals / contains / does not contain / yes / no); otherwise the steps after it are shown as *skipped* and the run still completes. |
| **Artifact** | Saves a step's answer as a file in the run folder. |

Run inputs are asked in the start form and inserted into instructions as `{{input.name}}`; a previous step's answer is
`{{steps.id}}`. Each pipe gets its own folder `<project>/pipelines/<name>`, each run its own `runs/<date>-<id>`.
Versions are immutable: a run keeps the version it started with. Runs can be paused, resumed, cancelled or terminated
(with a reason), and scheduled (hourly, daily, weekdays or cron, with a preview of the next runs).

## Try it first

`npm run demo` shows the Temporal section with synthetic pipes, runs and schedules — no Temporal server needed.
In the demo, *Approve* on the waiting run walks it to a result with files.

## What you need

Linux or macOS host (the worker talks to the portal over a Unix socket owned by the portal's user; Windows is not
supported for pipelines). Keep the data directory path short: the socket path `<data dir>/temporal-private/worker.sock` must fit in
103 bytes on macOS and 107 on Linux, otherwise the portal refuses to start pipelines and says so.


1. **Temporal server** with a namespace, reachable from the portal (gRPC). Any deployment works — Temporal Cloud,
   `temporal server start-dev` for a trial, or a self-hosted server with PostgreSQL.
2. **The `temporal` CLI** on the portal host (the portal starts, describes and controls workflows through it).
3. **PostgreSQL database for the worker ledger** — `lib/temporal/ledger.sql` and `lib/temporal/permits.sql`
   (exactly-once model calls and concurrency slots). Set the per-engine and per-user slots in `temporal_limits`
   (`scope='provider'` for `claude` / `codex` / `opencode`, `scope='tenant'` for a user id or `'*'` as the default).
4. **The Python worker** — `worker/temporal/pipeline_worker.py` with the packages from
   [`worker/temporal/requirements.txt`](../worker/temporal/requirements.txt), run as the portal's user with
   `PG*` variables for the ledger and `TELEHARNESS_TEMPORAL_MODEL_SOCKET` pointing to `<data dir>/temporal-private/worker.sock`.
   The worker also frees the slots of runs closed during a model step (cancelled or timed out): every
   `TELEHARNESS_TEMPORAL_PERMIT_SWEEP_S` seconds (300) it releases slots of runs closed longer than
   `TELEHARNESS_TEMPORAL_PERMIT_GRACE_S` seconds ago (3600).

## Local mode without PostgreSQL

If you only need **Command**, **Timer**, **Human decision**, **Join**, **Condition**, and **Artifact** steps (without
PostgreSQL-backed model quota ledgers), set `TELEHARNESS_TEMPORAL_LEDGER=none` and point
`TELEHARNESS_TEMPORAL_ADDRESS=127.0.0.1:7233` at a local `temporal server start-dev` instance. The Python worker
imports `psycopg` lazily, so PostgreSQL is not required in this mode. On macOS, see
[`ops/temporal/README.md`](../ops/temporal/README.md) for ready-to-use `launchd` plist examples and a short
`/tmp/teleharness-temporal/worker.sock` socket path.

## External Temporal workflows (admin)

Admins get two extra tabs inside **Temporal**:

- **Commands** — manage the allowlist catalog (`<data dir>/temporal-commands.json`) of `exec` scripts and
  `temporal-workflow` entries, discover schedules from an external Temporal cluster, and reload the catalog.
- **External** — inspect and control non-portal workflows running in Temporal: filter by status / type / task queue,
  start a new workflow with JSON input, inspect decoded Input / Result / Failure payloads, pending activities, and
  event history, and run **Signal**, **Query**, **Reset** (to any `WorkflowTaskCompleted` event or reset type),
  **Cancel**, or **Terminate** (with a mandatory reason). Set `TELEHARNESS_TEMPORAL_UI_URL` (e.g.
  `http://127.0.0.1:8233`) to include direct deep links to Temporal Web UI.

## Portal settings

| Variable | Meaning |
|---|---|
| `TELEHARNESS_TEMPORAL_PIPELINES=1` | Turns the feature on (private worker socket, runs, controls, schedules). |
| `TELEHARNESS_TEMPORAL_MODELS=claude,codex,acp,opencode` | Engines allowed in model steps. Empty — no model steps. |
| `TELEHARNESS_TEMPORAL_CLI` | Path to the `temporal` CLI binary (auto-resolved from `PATH`, fallback `/opt/temporal/temporal`). |
| `TELEHARNESS_TEMPORAL_ADDRESS` | Temporal gRPC address (default `127.0.0.1:17235` in prod, `127.0.0.1:17233` in stand; use `127.0.0.1:7233` for local dev). |
| `TELEHARNESS_TEMPORAL_NAMESPACE` | Temporal namespace (default `teleharness-production` / `teleharness-stage`). |
| `TELEHARNESS_TEMPORAL_QUEUE` | Worker task queue (default `teleharness-prod-pipeline-v1` / `teleharness-stage-pipeline-v1`). |
| `TELEHARNESS_TEMPORAL_LEDGER` | `postgres` (default, required for model steps) or `none` (local mode without PostgreSQL). |
| `TELEHARNESS_TEMPORAL_COMMAND_SLOTS` | Max concurrent Command steps (`1..32`, default `2`). |
| `TELEHARNESS_TEMPORAL_COMMAND_ROOTS` | Semicolon-separated allowed root directories for `exec` commands (falls back to `TELEHARNESS_FILE_ROOTS`). |
| `TELEHARNESS_TEMPORAL_MODEL_SOCKET` | Custom short Unix socket path (`<= 103` bytes on macOS, `<= 107` bytes on Linux). |
| `TELEHARNESS_TEMPORAL_UI_URL` | Optional Temporal Web UI base URL for deep links on external workflows and `temporal-workflow` command steps. |
| `TELEHARNESS_TEMPORAL_SUBSCRIPTION_ATTESTED=1` | You confirm Claude runs on a subscription only (needed when the token cannot read usage). |
| `TELEHARNESS_TEMPORAL_DRAIN=1` | Stop accepting new runs and schedule resumes (for maintenance). |

Hardening (backups, restore drills, a private gRPC proxy, systemd units) depends on your hosting and is not part of
this repository.
