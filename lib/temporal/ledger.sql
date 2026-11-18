-- FEAT-19.5. Apply in the portal control-plane database.
BEGIN;
CREATE TABLE IF NOT EXISTS temporal_operations (
    tenant_id text NOT NULL,
    logical_run_id text NOT NULL,
    operation_key text NOT NULL,
    claim_token uuid NOT NULL,
    receipt_ref text CHECK (length(receipt_ref) > 0),
    PRIMARY KEY (tenant_id, logical_run_id, operation_key)
);

CREATE OR REPLACE FUNCTION temporal_claim(text, text, text, uuid)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO temporal_operations (tenant_id, logical_run_id, operation_key, claim_token)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
        RETURN 'claimed';
    END IF;
    IF EXISTS (SELECT 1 FROM temporal_operations
               WHERE tenant_id = $1 AND logical_run_id = $2 AND operation_key = $3
                 AND receipt_ref IS NOT NULL) THEN
        RETURN 'completed';
    END IF;
    RETURN 'unknown';
END;
$$;

CREATE OR REPLACE FUNCTION temporal_finish(text, text, text, uuid, text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
    UPDATE temporal_operations SET receipt_ref = $5
    WHERE tenant_id = $1 AND logical_run_id = $2 AND operation_key = $3
      AND claim_token = $4 AND receipt_ref IS NULL AND $5 IS NOT NULL;
    RETURN FOUND;
END;
$$;
COMMIT;
