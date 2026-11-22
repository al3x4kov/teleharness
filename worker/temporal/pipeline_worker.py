"""FEAT-19.5. Subscription pipeline worker and private preparation Activity."""
import asyncio
import os

from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from model_activity import portal, portal_step, portal_step_pr, subscription_model, sweep_abandoned_permits
from pipeline import Pipeline


@activity.defn(name="prepare_run")
async def prepare_run(request: dict) -> dict:
    context = activity.info()
    return await asyncio.to_thread(portal, "prepare", {
        "launchRef": request["launchRef"],
        "workflowId": context.workflow_id,
        "runId": context.workflow_run_id,
    })


async def serve():
    client = await Client.connect(
        os.environ.get("TELEHARNESS_TEMPORAL_ADDRESS", "127.0.0.1:17233"),
        namespace=os.environ.get("TELEHARNESS_TEMPORAL_NAMESPACE", "teleharness-stage"),
    )
    # BUG-266: slots of runs closed during a model step are freed after the grace period
    sweep = asyncio.create_task(sweep_abandoned_permits(
        client,
        every_s=int(os.environ.get("TELEHARNESS_TEMPORAL_PERMIT_SWEEP_S", "300")),
        grace_s=int(os.environ.get("TELEHARNESS_TEMPORAL_PERMIT_GRACE_S", "3600")),
    ))
    try:
        await Worker(
            client, task_queue=os.environ.get("TELEHARNESS_TEMPORAL_QUEUE", "teleharness-stage-pipeline-v1"),
            workflows=[Pipeline], activities=[prepare_run, subscription_model, portal_step, portal_step_pr],
        ).run()
    finally:
        sweep.cancel()


if __name__ == "__main__":
    asyncio.run(serve())
