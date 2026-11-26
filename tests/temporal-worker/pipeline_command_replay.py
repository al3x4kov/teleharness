"""replay-тест совместимости TeleharnessPipelineV1 (старая история без command-step-v1).

Запускается в venv с установленным temporalio (python with temporalio installed).
Строит минимальную историю TeleharnessPipelineV1 (prepare_run -> timer -> WorkflowExecutionCompleted)
без маркера command-step-v1 и проигрывает её через temporalio.worker.Replayer против
обновлённого Pipeline. Отсутствие NonDeterminismError доказывает обратную совместимость.
"""
import asyncio
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker" / "temporal"))

from temporalio.client import WorkflowHistory  # noqa: E402
from temporalio.worker import Replayer  # noqa: E402
from pipeline import Pipeline  # noqa: E402


def _b64(obj) -> str:
    import base64
    return base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")


def build_legacy_timer_history() -> WorkflowHistory:
    payload_enc = {"encoding": "anNvbi9wbGFpbg=="}
    plan = {"steps": [{"id": "wait1", "type": "timer", "dependsOn": [], "seconds": 5}]}
    final_state = {
        "paused": False,
        "pending": [],
        "generation": "legacy-run-1",
        "steps": {"wait1": "completed"},
        "waitReasons": {},
        "conditions": {},
        "files": {},
        "pr": {},
        "reworks": {},
        "commands": {},
    }
    events = [
        {
            "eventId": "1",
            "eventType": "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
            "workflowExecutionStartedEventAttributes": {
                "workflowType": {"name": "TeleharnessPipelineV1"},
                "taskQueue": {"name": "teleharness-stage-pipeline-v1"},
                "input": {"payloads": [{"metadata": payload_enc, "data": _b64({"launchRef": "wf-legacy-1"})}]},
                "originalExecutionRunId": "legacy-run-1",
                "firstExecutionRunId": "legacy-run-1",
            },
        },
        {"eventId": "2", "eventType": "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", "workflowTaskScheduledEventAttributes": {"taskQueue": {"name": "teleharness-stage-pipeline-v1"}}},
        {"eventId": "3", "eventType": "EVENT_TYPE_WORKFLOW_TASK_STARTED", "workflowTaskStartedEventAttributes": {"scheduledEventId": "2"}},
        {"eventId": "4", "eventType": "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", "workflowTaskCompletedEventAttributes": {"scheduledEventId": "2", "startedEventId": "3"}},
        {
            "eventId": "5",
            "eventType": "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
            "activityTaskScheduledEventAttributes": {
                "activityId": "1",
                "activityType": {"name": "prepare_run"},
                "taskQueue": {"name": "teleharness-stage-pipeline-v1"},
                "input": {"payloads": [{"metadata": payload_enc, "data": _b64({"launchRef": "wf-legacy-1"})}]},
                "workflowTaskCompletedEventId": "4",
            },
        },
        {"eventId": "6", "eventType": "EVENT_TYPE_ACTIVITY_TASK_STARTED", "activityTaskStartedEventAttributes": {"scheduledEventId": "5"}},
        {
            "eventId": "7",
            "eventType": "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
            "activityTaskCompletedEventAttributes": {
                "scheduledEventId": "5",
                "startedEventId": "6",
                "result": {"payloads": [{"metadata": payload_enc, "data": _b64(plan)}]},
            },
        },
        {"eventId": "8", "eventType": "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", "workflowTaskScheduledEventAttributes": {"taskQueue": {"name": "teleharness-stage-pipeline-v1"}}},
        {"eventId": "9", "eventType": "EVENT_TYPE_WORKFLOW_TASK_STARTED", "workflowTaskStartedEventAttributes": {"scheduledEventId": "8"}},
        {"eventId": "10", "eventType": "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", "workflowTaskCompletedEventAttributes": {"scheduledEventId": "8", "startedEventId": "9"}},
        {
            "eventId": "11",
            "eventType": "EVENT_TYPE_TIMER_STARTED",
            "timerStartedEventAttributes": {
                "timerId": "1",
                "startToFireTimeout": "5s",
                "workflowTaskCompletedEventId": "10",
            },
        },
        {
            "eventId": "12",
            "eventType": "EVENT_TYPE_TIMER_FIRED",
            "timerFiredEventAttributes": {"timerId": "1", "startedEventId": "11"},
        },
        {"eventId": "13", "eventType": "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", "workflowTaskScheduledEventAttributes": {"taskQueue": {"name": "teleharness-stage-pipeline-v1"}}},
        {"eventId": "14", "eventType": "EVENT_TYPE_WORKFLOW_TASK_STARTED", "workflowTaskStartedEventAttributes": {"scheduledEventId": "13"}},
        {"eventId": "15", "eventType": "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", "workflowTaskCompletedEventAttributes": {"scheduledEventId": "13", "startedEventId": "14"}},
        {
            "eventId": "16",
            "eventType": "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED",
            "workflowExecutionCompletedEventAttributes": {
                "workflowTaskCompletedEventId": "15",
                "result": {"payloads": [{"metadata": payload_enc, "data": _b64(final_state)}]},
            },
        },
    ]
    for i, ev in enumerate(events):
        ev["eventTime"] = f"2026-11-25T10:00:{i:02d}Z"
    return WorkflowHistory.from_json("wf-legacy-1", {"events": events})


async def main():
    replayer = Replayer(workflows=[Pipeline])
    await replayer.replay_workflow(build_legacy_timer_history())
    print("REPLAY OK")


if __name__ == "__main__":
    asyncio.run(main())
