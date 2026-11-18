-- TASK-19.9. Only membership in the immutable Temporal roster moves a chat.
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM temporal_chat_owners
    WHERE chat_id = :'chat' AND executor = 'temporal' AND tenant_id <> :'owner'
) THEN 'foreign' ELSE temporal_chat_owner(:'owner', :'chat') END;
