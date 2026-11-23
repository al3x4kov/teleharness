"""FEAT-19.5. Durable orchestration over a safe, pinned definition projection."""
import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError


def invalid(code: str):
    return ApplicationError(code, type=code, non_retryable=True)


@workflow.defn(name="TeleharnessPipelineV1")
class Pipeline:
    def __init__(self):
        self.paused = False
        self.pending = {}
        self.steps = {}
        self.decisions = {}
        self.wait_reasons = {}
        self.conditions = {}
        self.files = {}
        self.pr = {}
        self.reworks = {}
        self.rework_events = {}
        self.step_defs = {}

    @workflow.query
    def state(self) -> dict:
        return {"paused": self.paused, "pending": sorted(self.pending),
                "generation": workflow.info().run_id, "steps": dict(self.steps), "waitReasons": dict(self.wait_reasons),
                "conditions": dict(self.conditions), "files": dict(self.files), "pr": dict(self.pr),
                "reworks": dict(self.reworks)}

    @workflow.update
    def control(self, request: dict) -> dict:
        action = request.get("action")
        if action in ("pause", "resume"):
            self.paused = action == "pause"
        elif action in ("approve", "reject"):
            step = request.get("stepId")
            if request.get("generation") != workflow.info().run_id:
                raise invalid("stale_generation")
            if step in self.decisions:
                if self.decisions[step] != action:
                    raise invalid("decision_conflict")
            elif step in self.pending and not self.paused:
                self.decisions[step] = action
                del self.pending[step]
            else:
                raise invalid("approval_unavailable")
        elif action == "rework":
            step = request.get("stepId")
            if request.get("generation") != workflow.info().run_id:
                raise invalid("stale_generation")
            if step in self.decisions:
                raise invalid("decision_conflict")
            if step not in self.pending or self.paused:
                raise invalid("approval_unavailable")
            step_def = self.step_defs.get(step) or {}
            target = step_def.get("reworkTarget")
            max_reworks = step_def.get("maxReworks", 3)
            if not target or target not in self.step_defs:
                raise invalid("rework_unavailable")
            if self.reworks.get(step, 0) >= max_reworks:
                raise invalid("rework_limit_reached")
            self.reworks[step] = self.reworks.get(step, 0) + 1
            self.rework_events[step] = self.reworks[step]
            del self.pending[step]
        else:
            raise invalid("unknown_command")
        return self.state()

    async def execute_step(self, step: dict):
        key = step["id"]
        await workflow.wait_condition(lambda: not self.paused)
        self.steps[key] = "running"
        if step["type"] == "timer":
            await workflow.sleep(step["seconds"])
        elif step["type"] == "model":
            wait_seconds = 30
            while True:
                await workflow.wait_condition(lambda: not self.paused)
                self.steps[key] = "running"
                outcome = await workflow.execute_activity(
                    "TeleharnessSubscriptionModelV1", key,
                    start_to_close_timeout=timedelta(seconds=step["timeoutSeconds"]),
                    heartbeat_timeout=timedelta(seconds=min(10,step["timeoutSeconds"])),
                    retry_policy=RetryPolicy(maximum_attempts=step["maxAttempts"]),
                )
                if outcome.get("state") == "completed":
                    break
                if outcome.get("state") != "quota_wait":
                    raise invalid("unknown_model_result")
                self.wait_reasons[key] = outcome.get("reason", "quota_wait")
                self.steps[key] = "quota_wait"
                await workflow.sleep(wait_seconds)
                if workflow.patched("subscription-backoff-v1"):
                    wait_seconds = min(wait_seconds * 2, 3600)
        elif step["type"] in ("condition", "artifact"):
            # FEAT-19.16: the portal evaluates the check / writes the file.
            outcome = await workflow.execute_activity(
                "TeleharnessPortalStepV1", key, start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            if step["type"] == "condition":
                self.conditions[key] = bool(outcome.get("value"))
            elif outcome.get("file"):
                self.files[key] = outcome["file"]
        elif step["type"] == "approval":
            if workflow.patched("review-rework-v1") and step.get("reworkTarget"):
                seen_rework = self.reworks.get(key, 0)
                while True:
                    self.steps[key] = "running"
                    self.pending[key] = True
                    await workflow.wait_condition(
                        lambda: key in self.decisions or self.rework_events.get(key, 0) > seen_rework
                    )
                    if key in self.decisions:
                        if self.decisions[key] == "reject":
                            self.steps[key] = "rejected"
                            raise invalid("approval_rejected")
                        break
                    seen_rework = self.rework_events[key]
                    target_step = self.step_defs[step["reworkTarget"]]
                    self.steps[key] = "waiting"
                    await self.execute_step(target_step)
            else:
                self.pending[key] = True
                await workflow.wait_condition(lambda: key in self.decisions)
                if self.decisions[key] == "reject":
                    self.steps[key] = "rejected"
                    raise invalid("approval_rejected")
        elif step["type"] == "pull_request":
            # FEAT-20.3 (1.13): портал делает git-флоу и PR; воркер ждёт github_wait
            # (5 мин, до 24 ч = 288 повторов), решение человека — как в шаге approval.
            approved = False
            attempts = 0
            while True:
                await workflow.wait_condition(lambda: not self.paused)
                self.steps[key] = "running"
                outcome = await workflow.execute_activity(
                    "TeleharnessPortalPrV1", {"stepId": key, "approved": approved},
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                state = outcome.get("state")
                if state in ("done", "no_changes"):
                    self.pr[key] = {"state": state, "url": outcome.get("url") if isinstance(outcome.get("url"), str) else None}
                    # FEAT-20.3 (2.5): outcome (created|updated|pushed), branch and commit —
                    # for the run screen. An older portal omits them; the UI has a fallback.
                    for field in ("outcome", "branch", "base", "sha"):
                        if isinstance(outcome.get(field), str):
                            self.pr[key][field] = outcome[field]
                    break
                if state == "needs_approval":
                    self.pending[key] = True
                    await workflow.wait_condition(lambda: key in self.decisions)
                    if self.decisions[key] == "reject":
                        self.steps[key] = "rejected"
                        raise invalid("approval_rejected")
                    approved = True
                    continue
                if state == "github_wait":
                    self.wait_reasons[key] = outcome.get("reason") or "github_wait"
                    self.steps[key] = "github_wait"
                    attempts += 1
                    if attempts > 288:
                        raise invalid("github_wait_exhausted")
                    if workflow.patched("pull-request-step-v1"):
                        await workflow.sleep(300)
                    continue
                raise invalid("unknown_pr_result")
        self.wait_reasons.pop(key, None)
        self.steps[key] = "completed"

    @workflow.run
    async def run(self, request: dict) -> dict:
        if set(request) != {"launchRef"} or not isinstance(request["launchRef"], str):
            raise invalid("invalid_launch_reference")
        projection = await workflow.execute_activity(
            "prepare_run", request, start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        steps = projection.get("steps", [])
        if not isinstance(steps, list) or not 1 <= len(steps) <= 64:
            raise invalid("invalid_plan")
        remaining = {}
        for step in steps:
            key = step.get("id")
            if not isinstance(key, str) or key in remaining or not isinstance(step.get("dependsOn"), list):
                raise invalid("invalid_plan")
            if step.get("type") not in ("approval", "timer", "parallel", "model", "condition", "artifact", "pull_request"):
                raise invalid("runtime_unavailable")
            if step["type"] == "timer" and (type(step.get("seconds")) is not int or not 1 <= step["seconds"] <= 2592000):
                raise invalid("invalid_duration")
            if step["type"] == "model":
                for field, maximum in (("timeoutSeconds", 86400), ("maxAttempts", 10)):
                    if type(step.get(field)) is not int or not 1 <= step[field] <= maximum:
                        raise invalid("invalid_model_policy")
            remaining[key] = step
            self.steps[key] = "waiting"
        # Reject the whole snapshot before any branch can trigger an effect.
        ordered = set()
        while len(ordered) < len(remaining):
            ready = [key for key, step in remaining.items() if key not in ordered
                     and all(isinstance(dep, str) and dep in ordered for dep in step["dependsOn"])]
            if not ready:
                raise invalid("invalid_dependencies")
            ordered.update(ready)
        for key, step in remaining.items():
            if step["type"] == "approval" and step.get("reworkTarget") is not None:
                target = step.get("reworkTarget")
                max_reworks = step.get("maxReworks", 3)
                if (not isinstance(target, str) or target not in remaining or
                        remaining[target].get("type") != "model" or
                        type(max_reworks) is not int or not 1 <= max_reworks <= 3):
                    raise invalid("invalid_plan")
        self.step_defs = dict(remaining)
        seed = projection.get("seed")
        if seed is not None and workflow.patched("resume-from-checkpoint-v1"):
            if not isinstance(seed, dict):
                raise invalid("invalid_seed")
            seeded_steps = seed.get("steps")
            if not isinstance(seeded_steps, dict):
                raise invalid("invalid_seed")
            for key, status in seeded_steps.items():
                if key not in remaining or status not in ("completed", "skipped"):
                    raise invalid("invalid_seed")
            for key in seeded_steps:
                if any(dep not in seeded_steps for dep in remaining[key]["dependsOn"]):
                    raise invalid("invalid_seed")
            raw_conds = seed.get("conditions", {})
            raw_files = seed.get("files", {})
            raw_pr = seed.get("pr", {})
            raw_reworks = seed.get("reworks", {})
            if not all(isinstance(x, dict) for x in (raw_conds, raw_files, raw_pr, raw_reworks)):
                raise invalid("invalid_seed")
            for key, value in raw_conds.items():
                if key not in seeded_steps or remaining[key]["type"] != "condition" or not isinstance(value, bool):
                    raise invalid("invalid_seed")
                self.conditions[key] = value
            for key, status in seeded_steps.items():
                if status == "completed" and remaining[key]["type"] == "condition" and key not in self.conditions:
                    raise invalid("invalid_seed")
            for key, value in raw_files.items():
                if key not in seeded_steps or remaining[key]["type"] != "artifact" or not isinstance(value, str):
                    raise invalid("invalid_seed")
                self.files[key] = value
            for key, value in raw_pr.items():
                if key not in seeded_steps or remaining[key]["type"] != "pull_request" or not isinstance(value, dict):
                    raise invalid("invalid_seed")
                if value.get("state") not in ("done", "no_changes"):
                    raise invalid("invalid_seed")
                self.pr[key] = dict(value)
            for key, value in raw_reworks.items():
                if key not in seeded_steps or remaining[key]["type"] != "approval" or type(value) is not int or not 0 <= value <= 10:
                    raise invalid("invalid_seed")
                self.reworks[key] = value
            for key, status in seeded_steps.items():
                self.steps[key] = status
                del remaining[key]
        running = {}
        try:
            while remaining or running:
                await workflow.wait_condition(lambda: not self.paused)
                changed = True
                while changed:
                    changed = False
                    for key, step in list(remaining.items()):
                        deps = step["dependsOn"]
                        if not all(self.steps.get(dep) in ("completed", "skipped") for dep in deps):
                            continue
                        # FEAT-19.16: a false condition (or a skipped step) skips everything after it.
                        if any(self.steps.get(dep) == "skipped" or self.conditions.get(dep) is False for dep in deps):
                            self.steps[key] = "skipped"
                            del remaining[key]
                            changed = True
                            continue
                        running[key] = asyncio.create_task(self.execute_step(step))
                        del remaining[key]
                if not running:
                    if remaining:
                        raise invalid("invalid_dependencies")
                    break
                await workflow.wait_condition(lambda: any(task.done() for task in running.values()))
                for key, task in list(running.items()):
                    if task.done():
                        await task
                        del running[key]
            await workflow.wait_condition(lambda: not self.paused)
            return self.state()
        finally:
            for task in running.values():
                task.cancel()
