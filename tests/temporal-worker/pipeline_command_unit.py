"""шаг «Команда» в worker/temporal/pipeline.py и activity TeleharnessPortalCommandV1.

Работает на системном python3 без установленного temporalio (стаб temporalio).
Проверяет:
  - slot_wait → сон 10 с → повтор → done (с компактными метаданными в self.commands);
  - несовместимость со старыми историями при patched('command-step-v1') == False;
  - валидацию timeoutSeconds / maxAttempts в run();
  - перенос self.commands при resume-from-checkpoint-v1 seed;
  - activity TeleharnessPortalCommandV1: heartbeat при долгой команде, done, slot_wait,
    retryable и nonRetryable CommandFailed, фильтрацию лишних полей (stdout не утекает).
"""
import asyncio
import datetime
import importlib.util
import pathlib
import sys
import time
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]
STEP = {"id": "cmd1", "type": "command", "dependsOn": [], "timeoutSeconds": 600, "maxAttempts": 2}

state = {"outcomes": [], "calls": [], "sleeps": [], "patched": True, "heartbeats": 0}


class ApplicationError(Exception):
    def __init__(self, message, *, type=None, non_retryable=False):  # noqa: A002
        super().__init__(message)
        self.message = message
        self.type = type
        self.non_retryable = non_retryable


class RetryPolicy:
    def __init__(self, **kw):
        self.kw = kw


async def wait_condition(predicate):
    while not predicate():
        await asyncio.sleep(0)


async def execute_activity(name, arg, **kw):
    state["calls"].append({"name": name, "arg": arg, **kw})
    outcome = state["outcomes"].pop(0)
    if isinstance(outcome, Exception):
        raise outcome
    return outcome


async def sleep(seconds):
    state["sleeps"].append(seconds)
    await asyncio.sleep(0)


workflow = types.SimpleNamespace(
    defn=lambda name=None: (lambda cls: cls),
    query=lambda fn: fn,
    update=lambda fn: fn,
    run=lambda fn: fn,
    info=lambda: types.SimpleNamespace(run_id="run-1"),
    patched=lambda _id: state["patched"],
    wait_condition=wait_condition,
    execute_activity=execute_activity,
    sleep=sleep,
)


def _activity_info():
    return types.SimpleNamespace(
        workflow_id="wf-cmd-1",
        started_time=datetime.datetime.now(datetime.timezone.utc),
        start_to_close_timeout=datetime.timedelta(seconds=60),
        heartbeat_timeout=datetime.timedelta(seconds=0.6),
    )


def _heartbeat(*_a):
    state["heartbeats"] += 1


activity = types.SimpleNamespace(
    defn=lambda name=None: (lambda fn: fn),
    info=_activity_info,
    heartbeat=_heartbeat,
)

fake = types.ModuleType("temporalio")
fake.workflow = workflow
fake.activity = activity
common = types.ModuleType("temporalio.common")
common.RetryPolicy = RetryPolicy
exceptions = types.ModuleType("temporalio.exceptions")
exceptions.ApplicationError = ApplicationError
sys.modules.update({
    "temporalio": fake,
    "temporalio.workflow": workflow,
    "temporalio.activity": activity,
    "temporalio.common": common,
    "temporalio.exceptions": exceptions,
})

spec_p = importlib.util.spec_from_file_location("teleharness_pipeline", ROOT / "worker" / "temporal" / "pipeline.py")
pipeline = importlib.util.module_from_spec(spec_p)
spec_p.loader.exec_module(pipeline)

spec_a = importlib.util.spec_from_file_location("teleharness_model_activity", ROOT / "worker" / "temporal" / "model_activity.py")
model_activity = importlib.util.module_from_spec(spec_a)
spec_a.loader.exec_module(model_activity)

FAILED = []


def reset(outcomes, patched=True):
    state.update(outcomes=list(outcomes), calls=[], sleeps=[], patched=patched, heartbeats=0)
    return pipeline.Pipeline()


def check(name, ok):
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        FAILED.append(name)


async def main():
    # 1. slot_wait x2 (10 s) -> done with compact metadata
    p = reset([
        {"state": "slot_wait", "reason": "command_slots_busy"},
        {"state": "slot_wait", "reason": "command_slots_busy"},
        {"state": "done", "exitCode": 0, "durationMs": 420, "kind": "exec", "filesCount": 2, "secretLeak": "nope"},
    ])
    await p.execute_step(dict(STEP))
    check("slot_wait x2 -> done: паузы по 10 с", state["sleeps"] == [10, 10])
    check("activity = TeleharnessPortalCommandV1 с heartbeat_timeout=30",
          [c["name"] for c in state["calls"]] == ["TeleharnessPortalCommandV1"] * 3
          and state["calls"][0]["heartbeat_timeout"].total_seconds() == 30
          and state["calls"][0]["retry_policy"].kw == {"maximum_attempts": 2})
    check("commands metadata сохранена без лишних полей",
          p.commands["cmd1"] == {"exitCode": 0, "durationMs": 420, "kind": "exec", "filesCount": 2}
          and "secretLeak" not in p.commands["cmd1"])
    check("шаг завершён, wait_reasons очищен", p.steps["cmd1"] == "completed" and "cmd1" not in p.wait_reasons)
    check("state() включает commands", p.state().get("commands") == p.commands)

    # 2. patched("command-step-v1") == False -> non-retryable runtime_unavailable
    p = reset([], patched=False)
    try:
        await p.execute_step(dict(STEP))
        check("старая история без патча отклоняет command", False)
    except ApplicationError as err:
        check("старая история без патча отклоняет command", err.type == "runtime_unavailable" and err.non_retryable)

    # 3. Полный run() с command шагом + invalid_command_policy
    p = reset([
        {"steps": [dict(STEP)]},
        {"state": "done", "exitCode": 0, "durationMs": 55, "kind": "temporal-workflow", "childWorkflowId": "teleharness-cmd-1", "childStatus": "COMPLETED", "uiUrl": "http://localhost:8233/w/1"},
    ])
    out = await p.run({"launchRef": "wf-1"})
    check("run() выполняет command и возвращает commands в state",
          out["steps"]["cmd1"] == "completed" and out["commands"]["cmd1"]["childWorkflowId"] == "teleharness-cmd-1")

    p = reset([{"steps": [{**STEP, "timeoutSeconds": 0}]}])
    try:
        await p.run({"launchRef": "wf-2"})
        check("run() отклоняет timeoutSeconds=0", False)
    except ApplicationError as err:
        check("run() отклоняет timeoutSeconds=0", err.type == "invalid_command_policy")

    # 4. Seed переносит commands при resume-from-checkpoint-v1
    p = reset([
        {
            "steps": [dict(STEP), {"id": "t2", "type": "timer", "dependsOn": ["cmd1"], "seconds": 5}],
            "seed": {"steps": {"cmd1": "completed"}, "commands": {"cmd1": {"exitCode": 0, "durationMs": 100}}},
        }
    ])
    out = await p.run({"launchRef": "wf-3"})
    check("resume seed сохраняет commands и пропускает повторный запуск cmd1",
          out["commands"]["cmd1"] == {"exitCode": 0, "durationMs": 100} and len(state["calls"]) == 1)

    # 5. TeleharnessPortalCommandV1: heartbeat при долгой команде + фильтрация stdout
    orig_portal = model_activity.portal
    try:
        def fake_portal_slow(action, req, deadline_ms=None):
            assert action == "step" and req == {"workflowId": "wf-cmd-1", "stepId": "cmd1"}
            time.sleep(0.45)
            return {"state": "done", "exitCode": 0, "durationMs": 450, "stdout": "SHOULD_NOT_PASS", "kind": "exec"}

        model_activity.portal = fake_portal_slow
        state["heartbeats"] = 0
        res = await model_activity.portal_step_command("cmd1")
        check("TeleharnessPortalCommandV1 шлёт heartbeat пока команда работает", state["heartbeats"] >= 2)
        check("TeleharnessPortalCommandV1 не пропускает stdout в Temporal", res == {"state": "done", "exitCode": 0, "durationMs": 450, "kind": "exec"})

        # failed retryable (exit != 0)
        model_activity.portal = lambda *_a: {"state": "failed", "error": "Код выхода 2", "nonRetryable": False}
        try:
            await model_activity.portal_step_command("cmd1")
            check("CommandFailed retryable", False)
        except ApplicationError as err:
            check("CommandFailed retryable", err.type == "CommandFailed" and err.non_retryable is False and "Код выхода 2" in err.message)

        # failed nonRetryable (uncertain / 403)
        model_activity.portal = lambda *_a: {"state": "failed", "error": "Команда прервана", "nonRetryable": True}
        try:
            await model_activity.portal_step_command("cmd1")
            check("CommandFailed nonRetryable", False)
        except ApplicationError as err:
            check("CommandFailed nonRetryable", err.type == "CommandFailed" and err.non_retryable is True)

        # slot_wait
        model_activity.portal = lambda *_a: {"state": "slot_wait", "reason": "command_slots_busy"}
        res_wait = await model_activity.portal_step_command("cmd1")
        check("TeleharnessPortalCommandV1 возвращает slot_wait", res_wait == {"state": "slot_wait", "reason": "command_slots_busy"})

        # TELEHARNESS_TEMPORAL_LEDGER=none raises ledger_unavailable in _ledger_connect()
        import os
        saved = os.environ.get("TELEHARNESS_TEMPORAL_LEDGER")
        try:
            os.environ["TELEHARNESS_TEMPORAL_LEDGER"] = "none"
            try:
                await model_activity.subscription_model("m1")
                check("TELEHARNESS_TEMPORAL_LEDGER=none blocks ledger", False)
            except ApplicationError as err:
                check("TELEHARNESS_TEMPORAL_LEDGER=none blocks ledger", err.type == "ledger_unavailable" and err.non_retryable is True)
        finally:
            if saved is None:
                os.environ.pop("TELEHARNESS_TEMPORAL_LEDGER", None)
            else:
                os.environ["TELEHARNESS_TEMPORAL_LEDGER"] = saved
    finally:
        model_activity.portal = orig_portal

    if FAILED:
        print("FAILED:", FAILED)
        sys.exit(1)
    print("ALL OK")


if __name__ == "__main__":
    asyncio.run(main())
