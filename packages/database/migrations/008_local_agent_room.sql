INSERT INTO conversations (account_id, chat_type, chat_id, title, agent_enabled, default_provider)
SELECT account_id, 'direct', '__local_agent_room__', 'Agent 室', true, 'codex'
FROM line_accounts
ON CONFLICT (account_id, chat_type, chat_id) DO UPDATE
SET title = EXCLUDED.title, agent_enabled = true, updated_at = now();
