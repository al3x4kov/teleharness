"""FEAT-19.5. Durable subscription Activity using the private portal socket."""
import asyncio
import http.client
import json
import os
import socket
import time
import threading
from uuid import uuid4

import psycopg
from temporalio import activity
from temporalio.exceptions import ApplicationError


class PortalConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(os.environ["TELEHARNESS_TEMPORAL_MODEL_SOCKET"])


def portal(action, request, deadline_ms=None):
    remaining = (deadline_ms / 1000 - time.time()) if deadline_ms else 30
    if remaining <= 0:
        raise TimeoutError("Activity deadline elapsed")
    conn = PortalConnection("localhost", timeout=min(3600, remaining))  # FEAT-19.16: chat-turn steps run up to an hour
    headers = {"Content-Type": "application/json"}
    if deadline_ms:
        headers["X-Teleharness-Deadline-Ms"] = str(deadline_ms)
    try:
        conn.request("POST", "/" + action, json.dumps(request),
                     headers)
        response = conn.getresponse()
        if response.status != 200:
            raise ApplicationError("Portal model dispatch unavailable",
                                   type="ModelUnavailable",
                                   non_retryable=(400 <= response.status < 500 and response.status != 408))
        limit = 256 * 1024 if action == 'prepare' else 2048
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Oversized portal response')
        return json.loads(data)
    finally:
        conn.close()


def uncertain():
    return ApplicationError("External outcome requires reconciliation",
                            type="UnknownModelResult", non_retryable=True)


def perform(connection, dispatch, workflow_id, step_id):
    request = {"workflowId": workflow_id, "stepId": step_id}
    allowed = dispatch("resolve", request)
    tenant, engine = allowed["tenant"], allowed["engine"]
    key = (tenant, workflow_id, step_id)
    operation = json.dumps([workflow_id, step_id], separators=(",", ":"))
    token = uuid4()
    def acquire():
        # A stable operation serializes acquisition and receipt inspection.
        connection.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))",
                           (json.dumps(key),))
        existing = connection.execute(
            "select receipt_ref from temporal_operations "
            "where tenant_id=%s and logical_run_id=%s and operation_key=%s", key
        ).fetchone()
        if existing:
            if existing[0] is None:
                raise uncertain()
            return {"state":"completed", "receipt":existing[0]}
        if allowed.get("state") == "quota_wait":
            return {"state":"quota_wait","reason":allowed.get("reason","quota_wait")}
        reserved, = connection.execute("select temporal_reserve(%s,%s,%s)",
                                       (tenant, engine, operation)).fetchone()
        if not reserved:
            return {"state":"quota_wait"}
        state, = connection.execute("select temporal_claim(%s,%s,%s,%s)",
                                    (*key, token)).fetchone()
        if state != "claimed":
            raise uncertain()
    def publish(receipt):
        dispatch("publish", {**request, "receipt":receipt})
        return {"state":"completed", "receipt":receipt}

    with connection.transaction():
        previous = acquire()
    if previous:
        return publish(previous["receipt"]) if previous["state"] == "completed" else previous
    try:
        outcome = dispatch("execute", request)
    except Exception:
        raise uncertain() from None
    with connection.transaction():
        if outcome.get("state") == "quota_wait":
            # Only the trusted subscription transport may return an authoritative
            # rejection before generating output. An ambiguous transport failure
            # keeps both the claim and the permit for reconciliation.
            cleared = connection.execute(
                "delete from temporal_operations where tenant_id=%s and logical_run_id=%s "
                "and operation_key=%s and claim_token=%s and receipt_ref is null", (*key, token)
            ).rowcount
            freed = connection.execute(
                "delete from temporal_permits where tenant_id=%s and provider=%s "
                "and operation_id=%s and not released", (tenant, engine, operation)
            ).rowcount
            if cleared != 1 or freed != 1:
                raise uncertain()
            return {"state":"quota_wait"}
        receipt = outcome["receipt"]
        confirmed, = connection.execute("select temporal_finish(%s,%s,%s,%s,%s)",
                                        (*key, token, receipt)).fetchone()
        released, = connection.execute("select temporal_release(%s,%s,%s)",
                                       (tenant, engine, operation)).fetchone()
        if not confirmed or not released:
            raise uncertain()
    return publish(receipt)


def release_abandoned(connection, closed_at, now=None, grace_s=3600):
    """BUG-266: free the slots of runs that can no longer hold an effect.

    An uncertain effect holds its slot (TASK-19.8), but a run cancelled or timed
    out during a model step never comes back to settle it — its tenant lost the
    slot forever. A permit is released once its workflow is closed and the grace
    period (longer than any model turn) has passed. closed_at(workflow_id) →
    close time in epoch seconds, 0 when the history is gone, None while running
    or unknown (kept). The claim without a receipt stays: a closed run cannot
    repeat the operation. Returns the released (tenant, provider, operation).
    """
    now = time.time() if now is None else now
    freed = []
    rows = connection.execute(
        "select tenant_id, provider, operation_id from temporal_permits where not released").fetchall()
    for tenant, engine, operation in rows:
        try:
            workflow_id, _step = json.loads(operation)
        except (ValueError, TypeError):
            continue
        if not isinstance(workflow_id, str):
            continue
        closed = closed_at(workflow_id)
        if closed is None or now - closed < grace_s:
            continue
        released, = connection.execute("select temporal_release(%s,%s,%s)",
                                       (tenant, engine, operation)).fetchone()
        if released:
            freed.append((tenant, engine, operation))
    return freed


async def closed_times(client, workflow_ids):
    """BUG-266: {workflow_id: close time (epoch s)} for closed runs; 0 when the
    history is gone (retention); running or unreachable runs are absent (kept)."""
    from temporalio.client import WorkflowExecutionStatus as S
    from temporalio.service import RPCError, RPCStatusCode
    closed_states = {S.COMPLETED, S.FAILED, S.CANCELED, S.TERMINATED, S.TIMED_OUT, S.CONTINUED_AS_NEW}
    out = {}
    for workflow_id in workflow_ids:
        try:
            info = await client.get_workflow_handle(workflow_id).describe()
        except RPCError as err:
            if err.status == RPCStatusCode.NOT_FOUND:
                out[workflow_id] = 0.0
            continue
        except Exception:  # one unreadable run keeps its slot, the pass goes on
            continue
        if info.status in closed_states and info.close_time is not None:
            out[workflow_id] = info.close_time.timestamp()
    return out


async def sweep_abandoned_permits(client, every_s=300, grace_s=3600, connect=None, log=print):
    """BUG-266: the worker's background pass over unreleased permits."""
    connect = connect or psycopg.connect
    while True:
        try:
            def pending():
                with connect() as connection:
                    ids = set()
                    for operation, in connection.execute(
                            "select operation_id from temporal_permits where not released"):
                        try:
                            workflow_id = json.loads(operation)[0]
                        except (ValueError, TypeError, IndexError, KeyError):
                            continue
                        if isinstance(workflow_id, str):
                            ids.add(workflow_id)
                    return ids
            ids = await asyncio.to_thread(pending)
            if ids:
                closed = await closed_times(client, ids)
                def apply():
                    with connect() as connection:
                        with connection.transaction():
                            return release_abandoned(connection, closed.get, grace_s=grace_s)
                freed = await asyncio.to_thread(apply)
                if freed:
                    log(f"[teleharness-temporal] released {len(freed)} abandoned permit(s): "
                        + ", ".join(f"{t}/{e}" for t, e, _ in freed))
        except Exception as err:  # the sweep never takes the worker down
            log(f"[teleharness-temporal] permit sweep failed: {type(err).__name__}")
        await asyncio.sleep(every_s)


@activity.defn(name="TeleharnessSubscriptionModelV1")
async def subscription_model(step_id: str) -> dict:
    info = activity.info()
    workflow_id = info.workflow_id
    deadline_ms = int((info.started_time + info.start_to_close_timeout).timestamp() * 1000)
    cancelled = threading.Event()
    def dispatch(action, request):
        if cancelled.is_set() and action != "publish":
            raise RuntimeError("Activity cancelled")
        return portal(action, request, deadline_ms)
    def execute():
        with psycopg.connect() as connection:
            return perform(connection, dispatch, workflow_id, step_id)
    task = asyncio.create_task(asyncio.to_thread(execute))
    try:
        while not task.done():
            activity.heartbeat()
            await asyncio.wait({task}, timeout=min(2,info.heartbeat_timeout.total_seconds()/3) if info.heartbeat_timeout else 2)
        return task.result()
    finally:
        cancelled.set()


@activity.defn(name="TeleharnessPortalStepV1")
async def portal_step(step_id: str) -> dict:
    """FEAT-19.16. «Условие»/«Артефакт»: the portal evaluates or writes; no model, no ledger."""
    info = activity.info()
    deadline_ms = int((info.started_time + info.start_to_close_timeout).timestamp() * 1000)
    reply = await asyncio.to_thread(portal, "step", {"workflowId": info.workflow_id, "stepId": step_id}, deadline_ms)
    if not isinstance(reply, dict) or not isinstance(reply.get("value"), bool):
        raise ApplicationError("Invalid portal step reply", type="InvalidPortalStep", non_retryable=True)
    return {"value": reply["value"], "file": reply.get("file") if isinstance(reply.get("file"), str) else None}
