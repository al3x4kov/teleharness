"""BUG-266 (BUG-19.25). The worker's sweep: Temporal statuses → released permits.

Fake Temporal client (real temporalio status/error types), disposable PostgreSQL.

Run against a disposable PostgreSQL with lib/temporal/permits.sql applied:
  PGDATABASE=temporal_test_<name> PYTHONPATH=worker/temporal python3 tests/temporal-worker/permit_sweep_worker.py
(requires psycopg and temporalio).
"""
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import psycopg
from temporalio.client import WorkflowExecutionStatus as S
from temporalio.service import RPCError, RPCStatusCode
from model_activity import closed_times, sweep_abandoned_permits

assert os.environ["PGDATABASE"].startswith("temporal_test_")
now = time.time()
at = lambda s: datetime.fromtimestamp(s, tz=timezone.utc)
runs = {
    "wf-canceled-old": (S.CANCELED, at(now - 7200)),
    "wf-failed-old": (S.FAILED, at(now - 7200)),
    "wf-canceled-new": (S.CANCELED, at(now - 30)),
    "wf-running": (S.RUNNING, None),
}

class Handle:
    def __init__(self, wf): self.wf = wf
    async def describe(self):
        if self.wf == "wf-gone":
            raise RPCError("workflow not found", RPCStatusCode.NOT_FOUND, b"")
        if self.wf == "wf-broken":
            raise ValueError("unexpected reply")
        if self.wf == "wf-unreachable":
            raise RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
        status, closed = runs[self.wf]
        return SimpleNamespace(status=status, close_time=closed)

class Client:
    def get_workflow_handle(self, wf): return Handle(wf)

ids = list(runs) + ["wf-gone", "wf-unreachable", "wf-broken"]
closed = asyncio.run(closed_times(Client(), ids))
assert set(closed) == {"wf-canceled-old", "wf-failed-old", "wf-canceled-new", "wf-gone"}, closed
assert closed["wf-gone"] == 0.0

tenant = str(uuid4())
op = lambda wf: json.dumps([wf, "s1"], separators=(",", ":"))
with psycopg.connect() as conn:
    with conn.transaction():
        conn.execute("insert into temporal_limits values ('tenant',%s,10) on conflict do nothing", (tenant,))
        conn.execute("insert into temporal_limits values ('provider','codex',20) on conflict (scope,identifier) do update set max_active=20")
        for wf in ids:
            assert conn.execute("select temporal_reserve(%s,'codex',%s)", (tenant, op(wf))).fetchone()[0], wf

logs = []
async def one_pass():
    task = asyncio.create_task(sweep_abandoned_permits(Client(), every_s=3600, grace_s=3600, log=logs.append))
    for _ in range(100):
        await asyncio.sleep(0.05)
        if logs:
            break
    task.cancel()
asyncio.run(one_pass())
assert logs and "released 3 abandoned permit(s)" in logs[0], logs

with psycopg.connect() as conn:
    held = {json.loads(r[0])[0] for r in conn.execute(
        "select operation_id from temporal_permits where tenant_id=%s and not released", (tenant,))}
assert held == {"wf-canceled-new", "wf-running", "wf-unreachable", "wf-broken"}, held
print("PASS worker sweep: closed>grace and purged released; recent, running, unreachable, broken kept")
