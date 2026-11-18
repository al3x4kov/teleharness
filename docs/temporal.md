# Temporal pipelines (optional)

Teleharness can run **pipelines** — multi-step scenarios that survive restarts — on top of
[Temporal](https://temporal.io). The feature is **off by default**: without it the *Temporal* section explains that
execution is not connected, and you can still draft pipes.

## What a pipe can do

| Step | What it does |
|---|---|
| **Model** | Runs the instruction as a turn of your own chat with Claude Code or Codex, inside the pipe's run folder: it can read and create files. Runs on your CLI subscription; no paid API is used. The step's conversation opens from the run. For regular users Codex answers with text only (Codex has no per-user sandbox). |
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
supported for pipelines).


1. **Temporal server** with a namespace, reachable from the portal (gRPC). Any deployment works — Temporal Cloud,
   `temporal server start-dev` for a trial, or a self-hosted server with PostgreSQL.
2. **The `temporal` CLI** on the portal host (the portal starts, describes and controls workflows through it).
3. **PostgreSQL database for the worker ledger** — `lib/temporal/ledger.sql` and `lib/temporal/permits.sql`
   (exactly-once model calls and concurrency slots). Set the per-engine and per-user slots in `temporal_limits`
   (`scope='provider'` for `claude` / `codex`, `scope='tenant'` for a user id or `'*'` as the default).
4. **The Python worker** — `worker/temporal/pipeline_worker.py` with the packages from
   [`worker/temporal/requirements.txt`](../worker/temporal/requirements.txt), run as the portal's user with
   `PG*` variables for the ledger and `TELEHARNESS_TEMPORAL_MODEL_SOCKET` pointing to `<data dir>/temporal-private/worker.sock`.

## Portal settings

| Variable | Meaning |
|---|---|
| `TELEHARNESS_TEMPORAL_PIPELINES=1` | Turns the feature on (private worker socket, runs, controls, schedules). |
| `TELEHARNESS_TEMPORAL_MODELS=claude,codex` | Engines allowed in model steps. Empty — no model steps. |
| `TELEHARNESS_TEMPORAL_SUBSCRIPTION_ATTESTED=1` | You confirm Claude runs on a subscription only (needed when the token cannot read usage). |
| `TELEHARNESS_TEMPORAL_DRAIN=1` | Stop accepting new runs and schedule resumes (for maintenance). |

The namespace, address and task queue are set in `server.js` (the `TELEHARNESS_TEMPORAL_PIPELINES` block: `127.0.0.1:17235`, namespace `teleharness-production`, queue `teleharness-prod-pipeline-v1`); adjust them to your Temporal
deployment. Hardening (backups, restore drills, a private gRPC proxy, systemd units) depends on your hosting and is
not part of this repository.
