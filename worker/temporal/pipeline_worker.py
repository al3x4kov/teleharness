"""FEAT-19.5. Subscription pipeline worker and private preparation Activity."""
import asyncio
import os

from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from model_activity import portal, portal_step, subscription_model
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
    await Worker(
        client, task_queue=os.environ.get("TELEHARNESS_TEMPORAL_QUEUE", "teleharness-stage-pipeline-v1"),
        workflows=[Pipeline], activities=[prepare_run, subscription_model, portal_step],
    ).run()


if __name__ == "__main__":
    asyncio.run(serve())
