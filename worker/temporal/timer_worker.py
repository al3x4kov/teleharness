"""FEAT-19.5. Start a timer worker on an isolated staging queue."""
import asyncio
import sys

from temporalio.client import Client
from temporalio.worker import Worker

from timer_step import TimerStep


async def serve(queue: str):
    client = await Client.connect("127.0.0.1:17233", namespace="teleharness-stage")
    await Worker(client, task_queue=queue, workflows=[TimerStep]).run()


if __name__ == "__main__":
    asyncio.run(serve(sys.argv[1]))
