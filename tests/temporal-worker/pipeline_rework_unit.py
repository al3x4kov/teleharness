"""TASK-20.34 п.1 / FEAT-20.1 кр. 14: цикл доработки rework (≤ 3) в worker/temporal/pipeline.py."""
import asyncio
import importlib.util
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]
state = {"outcomes": {}, "calls": [], "patched": True}


class ApplicationError(Exception):
    def __init__(self, message, *, type=None, non_retryable=False):  # noqa: A002
        super().__init__(message)
        self.type = type
        self.non_retryable = non_retryable


class RetryPolicy:
    def __init__(self, **kw):
        self.kw = kw


async def wait_condition(predicate):
    while not predicate():
        await asyncio.sleep(0)


async def execute_activity(name, arg, **kw):
    state["calls"].append({"name": name, "arg": arg})
    if name == "prepare_run":
        return state["outcomes"]["prepare_run"]
    if name == "TeleharnessSubscriptionModelV1":
        return {"state": "completed", "receipt": f"r-{arg}-{len(state['calls'])}"}
    if name == "TeleharnessPortalStepV1":
        return {"value": True, "file": "runs/r1/plan.md"}
    raise AssertionError(f"unexpected activity {name}")


async def sleep(seconds):
    await asyncio.sleep(0)


workflow = types.SimpleNamespace(
    defn=lambda name=None: (lambda cls: cls), query=lambda fn: fn, update=lambda fn: fn, run=lambda fn: fn,
    info=lambda: types.SimpleNamespace(run_id="run-rework-1"), patched=lambda _id: state["patched"],
    wait_condition=wait_condition, execute_activity=execute_activity, sleep=sleep,
)
fake = types.ModuleType("temporalio")
fake.workflow = workflow
common = types.ModuleType("temporalio.common")
common.RetryPolicy = RetryPolicy
exceptions = types.ModuleType("temporalio.exceptions")
exceptions.ApplicationError = ApplicationError
sys.modules.update({"temporalio": fake, "temporalio.workflow": workflow, "temporalio.common": common, "temporalio.exceptions": exceptions})

spec = importlib.util.spec_from_file_location("zai_pipeline", ROOT / "worker" / "temporal" / "pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

FAILED = []


def check(name, ok):
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        FAILED.append(name)


async def wait_pending(p, key):
    for _ in range(2000):
        if key in p.pending:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"step {key} did not become pending")


async def main():
    plan_projection = {
        "steps": [
            {"id": "plan", "type": "model", "dependsOn": [], "timeoutSeconds": 60, "maxAttempts": 1},
            {"id": "plan_file", "type": "artifact", "dependsOn": ["plan"]},
            {"id": "approve_plan", "type": "approval", "dependsOn": ["plan_file"]},
            {"id": "code", "type": "model", "dependsOn": ["approve_plan"], "timeoutSeconds": 60, "maxAttempts": 1},
            {"id": "review", "type": "approval", "dependsOn": ["code"], "reworkTarget": "code", "maxReworks": 3},
        ]
    }
    state["outcomes"] = {"prepare_run": plan_projection}
    state["calls"] = []
    p = pipeline.Pipeline()
    task = asyncio.create_task(p.run({"launchRef": "wf-1"}))

    await wait_pending(p, "approve_plan")
    check("approve_plan waits after plan_file", p.files.get("plan_file") == "runs/r1/plan.md")

    # rework on approval without reworkTarget -> rework_unavailable
    try:
        p.control({"action": "rework", "stepId": "approve_plan", "generation": "run-rework-1"})
        check("approve_plan rejects rework", False)
    except ApplicationError as err:
        check("approve_plan rejects rework", err.type == "rework_unavailable")

    p.control({"action": "approve", "stepId": "approve_plan", "generation": "run-rework-1"})
    await wait_pending(p, "review")
    code_runs = [c for c in state["calls"] if c["name"] == "TeleharnessSubscriptionModelV1" and c["arg"] == "code"]
    check("code ran once before first review", len(code_runs) == 1)

    for i in range(1, 4):
        st = p.control({"action": "rework", "stepId": "review", "generation": "run-rework-1"})
        check(f"rework #{i} increments counter", st["reworks"].get("review") == i)
        await wait_pending(p, "review")
        code_runs = [c for c in state["calls"] if c["name"] == "TeleharnessSubscriptionModelV1" and c["arg"] == "code"]
        check(f"code re-ran after rework #{i}", len(code_runs) == i + 1)

    # 4th rework must fail with rework_limit_reached and keep review pending
    try:
        p.control({"action": "rework", "stepId": "review", "generation": "run-rework-1"})
        check("4th rework rejected with rework_limit_reached", False)
    except ApplicationError as err:
        check("4th rework rejected with rework_limit_reached", err.type == "rework_limit_reached" and "review" in p.pending)

    p.control({"action": "approve", "stepId": "review", "generation": "run-rework-1"})
    final = await task
    check("workflow completes after approve with reworks=3", final["reworks"].get("review") == 3 and final["steps"]["review"] == "completed")

    # invalid plan with maxReworks > 3 rejected
    state["outcomes"] = {"prepare_run": {"steps": [
        {"id": "code", "type": "model", "dependsOn": [], "timeoutSeconds": 60, "maxAttempts": 1},
        {"id": "review", "type": "approval", "dependsOn": ["code"], "reworkTarget": "code", "maxReworks": 4},
    ]}}
    p2 = pipeline.Pipeline()
    try:
        await p2.run({"launchRef": "wf-bad"})
        check("invalid maxReworks > 3 rejected", False)
    except ApplicationError as err:
        check("invalid maxReworks > 3 rejected", err.type == "invalid_plan")

    if FAILED:
        print("FAILED:", FAILED)
        sys.exit(1)
    print("ALL OK")


if __name__ == "__main__":
    asyncio.run(main())
