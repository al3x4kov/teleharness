"""BUG-266 (BUG-19.25). Disposable PostgreSQL contract for the abandoned-permit sweep.

A run cancelled or timed out during a model step leaves its permit unreleased
(an uncertain effect holds its slot — TASK-19.8). Without a sweep the tenant's
slots stay taken forever (prod 2026-11-19: both admin slots since 18.11).
The sweep releases a permit only when its workflow is closed and the grace
period has passed; the claim without a receipt stays (the closed run cannot
repeat the operation). A running or unknown workflow keeps its slot.

Run against a disposable PostgreSQL with lib/temporal/permits.sql applied:
  PGDATABASE=temporal_test_<name> PYTHONPATH=worker/temporal python3 tests/temporal-worker/permit_sweep_contract.py
(requires psycopg).
"""
import json
import os
from uuid import uuid4

import psycopg
from model_activity import release_abandoned

assert os.environ["PGDATABASE"].startswith("temporal_test_")
tenant = str(uuid4())
op = lambda wf, step: json.dumps([wf, step], separators=(",", ":"))
NOW = 1_000_000.0
GRACE = 3600
cases = {
    "closed-old": NOW - GRACE - 1,     # closed long ago → released
    "closed-recent": NOW - 60,         # closed a minute ago → kept (grace)
    "running": None,                   # still running / unknown → kept
    "purged": 0.0,                     # history gone (retention) → released
}
with psycopg.connect() as conn:
    with conn.transaction():
        conn.execute("insert into temporal_limits values ('tenant',%s,10) on conflict do nothing", (tenant,))
        conn.execute("insert into temporal_limits values ('provider','claude',10) on conflict (scope,identifier) do update set max_active=greatest(temporal_limits.max_active,10)")
        for wf in cases:
            reserved, = conn.execute("select temporal_reserve(%s,'claude',%s)", (tenant, op(wf, "s1"))).fetchone()
            assert reserved, wf
            state, = conn.execute("select temporal_claim(%s,%s,'s1',%s)", (tenant, wf, uuid4())).fetchone()
            assert state == "claimed", (wf, state)
        # a malformed operation id is never touched
        conn.execute("insert into temporal_permits(tenant_id,provider,operation_id) values (%s,'claude','not-json')", (tenant,))

    looked = []
    def closed_at(workflow_id):
        looked.append(workflow_id)
        return cases.get(workflow_id)

    with conn.transaction():
        freed = release_abandoned(conn, closed_at, now=NOW, grace_s=GRACE)
    assert sorted(f[2] for f in freed) == sorted([op("closed-old", "s1"), op("purged", "s1")]), freed

    held = {r[0] for r in conn.execute(
        "select operation_id from temporal_permits where tenant_id=%s and not released", (tenant,))}
    assert held == {op("closed-recent", "s1"), op("running", "s1"), "not-json"}, held
    claims = conn.execute(
        "select count(*) from temporal_operations where tenant_id=%s and receipt_ref is null", (tenant,)).fetchone()[0]
    assert claims == 4, claims  # claims stay: the closed run cannot repeat the operation

    # idempotent: a second sweep frees nothing new
    with conn.transaction():
        assert release_abandoned(conn, closed_at, now=NOW, grace_s=GRACE) == []
print("PASS abandoned permits: closed+grace released, running/recent/malformed kept, claims kept")
