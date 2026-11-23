"""FEAT-19.32: unit tests for seed-based resume in worker/temporal/pipeline.py."""
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
        return {"value": True, "file": f"runs/r1/{arg}.md"}
    raise AssertionError(f"unexpected activity {name}")


async def sleep(seconds):
    state["calls"].append({"name": "sleep", "arg": seconds})
    await asyncio.sleep(0)


workflow = types.SimpleNamespace(
    defn=lambda name=None: (lambda cls: cls), query=lambda fn: fn, update=lambda fn: fn, run=lambda fn: fn,
    info=lambda: types.SimpleNamespace(run_id="run-resume-1"), patched=lambda _id: state["patched"],
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


async def main():
    # 1. Resume skips seeded steps and runs only remaining steps.
    state["calls"].clear()
    state["outcomes"]["prepare_run"] = {
        "steps": [
            {"id": "s1", "type": "model", "dependsOn": [], "timeoutSeconds": 60, "maxAttempts": 1},
            {"id": "s2", "type": "timer", "dependsOn": ["s1"], "seconds": 5},
            {"id": "s3", "type": "model", "dependsOn": ["s2"], "timeoutSeconds": 60, "maxAttempts": 1},
        ],
        "seed": {
            "steps": {"s1": "completed", "s2": "completed"},
            "conditions": {},
            "files": {},
            "pr": {},
            "reworks": {},
        },
    }
    p = pipeline.Pipeline()
    res = await p.run({"launchRef": "wf-resumed-1"})
    executed = [c["arg"] for c in state["calls"] if c["name"] in ("TeleharnessSubscriptionModelV1", "sleep")]
    check("1. skips seeded s1/s2 and runs only s3", executed == ["s3"] and res["steps"] == {"s1": "completed", "s2": "completed", "s3": "completed"})

    # 2. Seeded false condition skips downstream unseeded steps without executing them.
    state["calls"].clear()
    state["outcomes"]["prepare_run"] = {
        "steps": [
            {"id": "c1", "type": "condition", "dependsOn": []},
            {"id": "m1", "type": "model", "dependsOn": ["c1"], "timeoutSeconds": 60, "maxAttempts": 1},
        ],
        "seed": {
            "steps": {"c1": "completed"},
            "conditions": {"c1": False},
            "files": {},
            "pr": {},
            "reworks": {},
        },
    }
    p2 = pipeline.Pipeline()
    res2 = await p2.run({"launchRef": "wf-resumed-2"})
    executed2 = [c["arg"] for c in state["calls"] if c["name"] == "TeleharnessSubscriptionModelV1"]
    check("2. false seeded condition skips downstream m1", executed2 == [] and res2["steps"] == {"c1": "completed", "m1": "skipped"} and res2["conditions"] == {"c1": False})

    # 3. Seeded artifact files and pr metadata are preserved in workflow state.
    state["calls"].clear()
    state["outcomes"]["prepare_run"] = {
        "steps": [
            {"id": "a1", "type": "artifact", "dependsOn": []},
            {"id": "pr1", "type": "pull_request", "dependsOn": ["a1"]},
            {"id": "t1", "type": "timer", "dependsOn": ["pr1"], "seconds": 1},
        ],
        "seed": {
            "steps": {"a1": "completed", "pr1": "completed"},
            "conditions": {},
            "files": {"a1": "runs/r1/a1.md"},
            "pr": {"pr1": {"state": "done", "url": "https://github.com/o/r/pull/1"}},
            "reworks": {},
        },
    }
    p3 = pipeline.Pipeline()
    res3 = await p3.run({"launchRef": "wf-resumed-3"})
    check("3. preserves seeded files and pr metadata", res3["files"] == {"a1": "runs/r1/a1.md"} and res3["pr"]["pr1"]["state"] == "done")

    # 4. Rejects non-closed seed (s2 seeded without its dependency s1).
    state["calls"].clear()
    state["outcomes"]["prepare_run"] = {
        "steps": [
            {"id": "s1", "type": "timer", "dependsOn": [], "seconds": 1},
            {"id": "s2", "type": "timer", "dependsOn": ["s1"], "seconds": 1},
        ],
        "seed": {"steps": {"s2": "completed"}},
    }
    p4 = pipeline.Pipeline()
    got_err = None
    try:
        await p4.run({"launchRef": "wf-bad-seed"})
    except ApplicationError as e:
        got_err = e.type
    check("4. rejects non-closed seed with invalid_seed", got_err == "invalid_seed")

    # 5. Rejects unknown seeded step id.
    state["outcomes"]["prepare_run"] = {
        "steps": [{"id": "s1", "type": "timer", "dependsOn": [], "seconds": 1}],
        "seed": {"steps": {"ghost": "completed"}},
    }
    p5 = pipeline.Pipeline()
    got_err5 = None
    try:
        await p5.run({"launchRef": "wf-bad-step"})
    except ApplicationError as e:
        got_err5 = e.type
    check("5. rejects unknown seeded step id with invalid_seed", got_err5 == "invalid_seed")

    if FAILED:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
