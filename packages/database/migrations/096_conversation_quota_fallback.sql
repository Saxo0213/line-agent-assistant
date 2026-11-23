-- A chat pin that the provider quota fallback made records the failed provider here.
-- The system reverts such a pin when the failed provider recovers. A manual /agent choice sets this column to NULL.
ALTER TABLE conversations ADD COLUMN quota_fallback_from text CHECK (quota_fallback_from IN ('claude','codex'));

UPDATE conversations c SET quota_fallback_from = p.failed_provider
FROM (
  SELECT DISTINCT ON (account_id, chat_type, chat_id) account_id, chat_type, chat_id, failed_provider, target_provider
  FROM provider_quota_proposals
  WHERE state = 'accepted'
  ORDER BY account_id, chat_type, chat_id, consumed_at DESC NULLS LAST
) p
WHERE p.account_id = c.account_id AND p.chat_type = c.chat_type AND p.chat_id = c.chat_id
  AND p.target_provider = c.default_provider;
