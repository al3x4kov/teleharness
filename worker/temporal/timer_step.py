"""FEAT-19.5. Durable timer with the published definition's bounds."""
from temporalio import workflow
from temporalio.exceptions import ApplicationError


@workflow.defn(name="TeleharnessTimerStepV1")
class TimerStep:
    @workflow.run
    async def run(self, seconds: int) -> int:
        if type(seconds) is not int or not 1 <= seconds <= 2592000:
            raise ApplicationError("Invalid timer duration", non_retryable=True)
        await workflow.sleep(seconds)
        return seconds
