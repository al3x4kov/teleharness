"""FEAT-19.5. Keep the claim durable before invoking a model adapter."""
from uuid import uuid4

from psycopg.pq import TransactionStatus


class UncertainEffect(Exception):
    """The external operation needs reconciliation before another attempt."""


def run_once(connection, key, effect):
    if connection.info.transaction_status != TransactionStatus.IDLE:
        raise ValueError("run_once requires an idle, dedicated database connection")
    token = uuid4()
    with connection.transaction():
        state, = connection.execute(
            "select temporal_claim(%s,%s,%s,%s)", (*key, token)
        ).fetchone()
        if state == "completed":
            receipt, = connection.execute(
                """select receipt_ref from temporal_operations
                   where tenant_id=%s and logical_run_id=%s and operation_key=%s""", key
            ).fetchone()
            return receipt
        if state != "claimed":
            raise UncertainEffect("Existing operation without a receipt")
    receipt = effect()
    with connection.transaction():
        recorded, = connection.execute(
            "select temporal_finish(%s,%s,%s,%s,%s)", (*key, token, receipt)
        ).fetchone()
        if not recorded:
            raise UncertainEffect("Could not confirm the receipt")
    return receipt
