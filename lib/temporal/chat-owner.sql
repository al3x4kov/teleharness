-- TASK-19.9. Only the server-side successful creation path registers a chat.
BEGIN;
CREATE TABLE IF NOT EXISTS temporal_chat_owners (
    tenant_id text NOT NULL,
    chat_id text NOT NULL,
    executor text NOT NULL CHECK (executor IN ('legacy', 'temporal')),
    PRIMARY KEY (tenant_id, chat_id)
);

CREATE OR REPLACE FUNCTION temporal_chat_owner(tenant text, chat text)
RETURNS text LANGUAGE sql STABLE STRICT AS $$
    SELECT coalesce((SELECT executor FROM temporal_chat_owners
                     WHERE tenant_id = tenant AND chat_id = chat), 'legacy');
$$;

CREATE OR REPLACE FUNCTION temporal_register_chat(tenant text, chat text, enabled boolean)
RETURNS text LANGUAGE plpgsql STRICT AS $$
BEGIN
    INSERT INTO temporal_chat_owners (tenant_id, chat_id, executor)
    VALUES (tenant, chat, CASE WHEN enabled THEN 'temporal' ELSE 'legacy' END)
    ON CONFLICT DO NOTHING;
    RETURN temporal_chat_owner(tenant, chat);
END;
$$;
COMMIT;
