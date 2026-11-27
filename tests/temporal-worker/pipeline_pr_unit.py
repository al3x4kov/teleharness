"""FEAT-20.3 (2.5): шаг «Открыть PR» в worker/temporal/pipeline.py — без Temporal.

temporalio подменён стабом: wait_condition/sleep не ждут по-настоящему, исходы
активities выдаются по очереди. Так проверяются сами правила шага (кр. 13–14):
ожидание GitHub 5 мин × 288 → 24 ч, решение человека по файлам CI, поля итога
для экрана запуска. Запускается из tests/temporal-pipeline-pr.test.js.
"""
import asyncio
import importlib.util
import pathlib
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]
STEP = {"id": "pr", "type": "pull_request", "name": "Открыть PR"}

state = {"outcomes": [], "calls": [], "sleeps": [], "patched": True}


class ApplicationError(Exception):
    def __init__(self, message, *, type=None, non_retryable=False):  # noqa: A002 — сигнатура temporalio
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
    state["calls"].append({"name": name, "arg": arg, **kw})
    outcome = state["outcomes"].pop(0)
    if isinstance(outcome, Exception):
        raise outcome
    return outcome


async def sleep(seconds):
    state["sleeps"].append(seconds)
    await asyncio.sleep(0)


workflow = types.SimpleNamespace(
    defn=lambda name=None: (lambda cls: cls), query=lambda fn: fn, update=lambda fn: fn, run=lambda fn: fn,
    info=lambda: types.SimpleNamespace(run_id="run-1"), patched=lambda _id: state["patched"],
    wait_condition=wait_condition, execute_activity=execute_activity, sleep=sleep,
)
fake = types.ModuleType("temporalio")
fake.workflow = workflow
common = types.ModuleType("temporalio.common")
common.RetryPolicy = RetryPolicy
exceptions = types.ModuleType("temporalio.exceptions")
exceptions.ApplicationError = ApplicationError
sys.modules.update({"temporalio": fake, "temporalio.workflow": workflow, "temporalio.common": common, "temporalio.exceptions": exceptions})

spec = importlib.util.spec_from_file_location("teleharness_pipeline", ROOT / "worker" / "temporal" / "pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

FAILED = []


def reset(outcomes, patched=True):
    state.update(outcomes=list(outcomes), calls=[], sleeps=[], patched=patched)
    return pipeline.Pipeline()


def check(name, ok):
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        FAILED.append(name)


async def wait_pending(p, key):
    for _ in range(1000):
        if key in p.pending:
            return
        await asyncio.sleep(0)
    raise AssertionError("шаг не попросил решения человека")


async def main():
    done = {"state": "done", "url": "https://github.com/o/r/pull/318", "outcome": "created", "branch": "teleharness/142-fix", "base": "main", "sha": "a41f9c2"}

    # 1. Ждёт GitHub: 5 мин между проверками, затем успех — итог сохранён для экрана запуска.
    p = reset([{"state": "github_wait", "reason": "github_auth"}, {"state": "github_wait", "reason": "github_network"}, done])
    await p.execute_step(dict(STEP))
    check("github_wait ×2 → done: повтор каждые 300 с", state["sleeps"] == [300, 300])
    check("github_wait ×2 → done: итог шага с веткой и коммитом", p.pr["pr"] == {"state": "done", "url": done["url"], "outcome": "created", "branch": "teleharness/142-fix", "base": "main", "sha": "a41f9c2"})
    check("github_wait ×2 → done: причина ожидания снята, шаг завершён", "pr" not in p.wait_reasons and p.steps["pr"] == "completed")
    check("активити — TeleharnessPortalPrV1 с шагом и approved=false", [c["name"] for c in state["calls"]] == ["TeleharnessPortalPrV1"] * 3 and state["calls"][0]["arg"] == {"stepId": "pr", "approved": False})
    check("таймаут активити 120 с, до 3 попыток", state["calls"][0]["start_to_close_timeout"].total_seconds() == 120 and state["calls"][0]["retry_policy"].kw == {"maximum_attempts": 3})

    # 2. 24 ч истекли (288 повторов по 300 с) — ошибка шага, запуск падает.
    p = reset([{"state": "github_wait", "reason": "github_auth"}] * 289)
    try:
        await p.execute_step(dict(STEP))
        check("24 ч: шаг падает ошибкой github_wait_exhausted", False)
    except ApplicationError as error:
        check("24 ч: шаг падает ошибкой github_wait_exhausted", error.type == "github_wait_exhausted" and error.non_retryable)
    check("24 ч: ровно 288 пауз по 300 с (= 24 ч)", state["sleeps"] == [300] * 288)
    check("24 ч: причина и состояние шага остались читаемыми", p.wait_reasons.get("pr") == "github_auth" and p.steps["pr"] == "github_wait" and "pr" not in p.pr)

    # 3. Агент изменил файлы CI — решение человека; одобрение повторяет шаг с approved=true.
    p = reset([{"state": "needs_approval", "reason": "ci_files"}, done])
    task = asyncio.create_task(p.execute_step(dict(STEP)))
    await wait_pending(p, "pr")
    check("needs_approval: запуск ждёт решения, GitHub не тронут повторно", state["calls"][0]["arg"]["approved"] is False and len(state["calls"]) == 1)
    p.decisions["pr"] = "approve"
    await task
    check("needs_approval → одобрено: повтор шага с approved=true", state["calls"][1]["arg"] == {"stepId": "pr", "approved": True} and p.pr["pr"].get("outcome") == "created")

    # 4. Отклонение — как у шага решения: шаг отклонён, запуск завершается.
    p = reset([{"state": "needs_approval", "reason": "ci_files"}])
    task = asyncio.create_task(p.execute_step(dict(STEP)))
    await wait_pending(p, "pr")
    p.decisions["pr"] = "reject"
    try:
        await task
        check("needs_approval → отклонено: approval_rejected", False)
    except ApplicationError as error:
        check("needs_approval → отклонено: approval_rejected", error.type == "approval_rejected")
    check("needs_approval → отклонено: шаг «отклонён», без отправки", p.steps["pr"] == "rejected" and len(state["calls"]) == 1 and "pr" not in p.pr)

    # 5. Изменений нет — запуск завершается без ошибки.
    p = reset([{"state": "no_changes"}])
    await p.execute_step(dict(STEP))
    check("no_changes: итог без PR, шаг завершён", p.pr["pr"] == {"state": "no_changes", "url": None} and p.steps["pr"] == "completed")

    # 6. Старый портал без полей итога — состояние читается и так.
    p = reset([{"state": "done", "url": "https://github.com/o/r/pull/5"}])
    await p.execute_step(dict(STEP))
    check("ответ старого портала: state и url, без outcome", p.pr["pr"] == {"state": "done", "url": "https://github.com/o/r/pull/5"})

    # 7. Неизвестный итог — ошибка, а не вечное ожидание.
    p = reset([{"state": "mystery"}])
    try:
        await p.execute_step(dict(STEP))
        check("неизвестный итог → unknown_pr_result", False)
    except ApplicationError as error:
        check("неизвестный итог → unknown_pr_result", error.type == "unknown_pr_result")

    if FAILED:
        print("FAILED: " + ", ".join(FAILED))
        return 1
    print("ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
