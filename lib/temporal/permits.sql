-- TASK-19.8. Concurrency reservation only; an uncertain effect holds its slot.
BEGIN;
CREATE TABLE IF NOT EXISTS temporal_limits (
    scope text NOT NULL CHECK (scope IN ('provider','tenant')),
    identifier text NOT NULL,
    max_active integer NOT NULL CHECK (max_active >= 0),
    PRIMARY KEY (scope, identifier)
);
CREATE TABLE IF NOT EXISTS temporal_permits (
    tenant_id text NOT NULL,
    provider text NOT NULL,
    operation_id text NOT NULL,
    released boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS temporal_active_provider ON temporal_permits(provider) WHERE NOT released;
CREATE INDEX IF NOT EXISTS temporal_active_tenant ON temporal_permits(tenant_id) WHERE NOT released;

CREATE OR REPLACE FUNCTION temporal_reserve(tenant text, engine text, operation text)
RETURNS boolean LANGUAGE plpgsql STRICT AS $$
DECLARE
    provider_limit integer;
    tenant_limit integer;
BEGIN
    SELECT max_active INTO provider_limit FROM temporal_limits
        WHERE scope='provider' AND identifier=engine FOR UPDATE;
    SELECT max_active INTO tenant_limit FROM temporal_limits
        WHERE scope='tenant' AND identifier=tenant FOR UPDATE;
    -- FEAT-19.16: a user without an explicit row gets the shared default (tenant/'*').
    IF tenant_limit IS NULL THEN
        SELECT max_active INTO tenant_limit FROM temporal_limits
            WHERE scope='tenant' AND identifier='*' FOR UPDATE;
    END IF;
    IF provider_limit IS NULL OR tenant_limit IS NULL THEN RETURN false; END IF;
    IF (SELECT count(*) FROM temporal_permits WHERE provider=engine AND NOT released) >= provider_limit
        OR (SELECT count(*) FROM temporal_permits WHERE tenant_id=tenant AND NOT released) >= tenant_limit
        THEN RETURN false;
    END IF;
    INSERT INTO temporal_permits(tenant_id,provider,operation_id) VALUES(tenant,engine,operation)
        ON CONFLICT DO NOTHING;
    RETURN FOUND;
END;
$$;

-- BUG-252: CREATE OR REPLACE resets SECURITY DEFINER; keep it with the definition
-- (the worker role has no direct UPDATE/SELECT FOR UPDATE on temporal_limits).
ALTER FUNCTION temporal_reserve(text,text,text) SECURITY DEFINER SET search_path TO pg_catalog,public,pg_temp;

CREATE OR REPLACE FUNCTION temporal_release(tenant text, engine text, operation text)
RETURNS boolean LANGUAGE plpgsql STRICT AS $$
BEGIN
    UPDATE temporal_permits SET released=true WHERE tenant_id=tenant AND provider=engine
        AND operation_id=operation AND NOT released;
    RETURN FOUND;
END;
$$;
COMMIT;
