ALTER TABLE line_friend_whitelist_grants
  ADD COLUMN scope_kind text NOT NULL DEFAULT 'ACCOUNT',
  ADD COLUMN chat_type text,
  ADD COLUMN chat_id text;

ALTER TABLE line_friend_whitelist_audit
  ADD COLUMN scope_kind text NOT NULL DEFAULT 'ACCOUNT',
  ADD COLUMN chat_type text,
  ADD COLUMN chat_id text;

ALTER TABLE line_friend_whitelist_grants
  DROP CONSTRAINT line_friend_whitelist_grants_capability_check,
  DROP CONSTRAINT line_friend_whitelist_grants_account_id_target_mid_version_key;

DROP INDEX line_friend_whitelist_one_active_idx;
DROP INDEX line_friend_whitelist_active_lookup_idx;

UPDATE line_friend_whitelist_grants SET capability = 'AGENT_USE';

ALTER TABLE line_friend_whitelist_grants
  ADD CONSTRAINT line_friend_whitelist_grants_capability_check CHECK (capability = 'AGENT_USE'),
  ADD CONSTRAINT line_friend_whitelist_grants_scope_check CHECK (
    (scope_kind = 'ACCOUNT' AND chat_type IS NULL AND chat_id IS NULL)
    OR (scope_kind = 'CHAT' AND chat_type IS NOT NULL AND chat_type IN ('group', 'room')
      AND chat_id IS NOT NULL AND length(chat_id) > 0)
  );

ALTER TABLE line_friend_whitelist_audit
  ADD CONSTRAINT line_friend_whitelist_audit_scope_check CHECK (
    (scope_kind = 'ACCOUNT' AND chat_type IS NULL AND chat_id IS NULL)
    OR (scope_kind = 'CHAT' AND chat_type IS NOT NULL AND chat_type IN ('group', 'room')
      AND chat_id IS NOT NULL AND length(chat_id) > 0)
  );

CREATE UNIQUE INDEX line_friend_whitelist_account_history_version_idx
  ON line_friend_whitelist_grants (account_id, target_mid, version) WHERE scope_kind = 'ACCOUNT';
CREATE UNIQUE INDEX line_friend_whitelist_chat_history_version_idx
  ON line_friend_whitelist_grants (account_id, chat_type, chat_id, target_mid, version) WHERE scope_kind = 'CHAT';
CREATE UNIQUE INDEX line_friend_whitelist_account_one_active_idx
  ON line_friend_whitelist_grants (account_id, target_mid) WHERE scope_kind = 'ACCOUNT' AND state = 'ACTIVE';
CREATE UNIQUE INDEX line_friend_whitelist_chat_one_active_idx
  ON line_friend_whitelist_grants (account_id, chat_type, chat_id, target_mid)
  WHERE scope_kind = 'CHAT' AND state = 'ACTIVE';
CREATE INDEX line_friend_whitelist_active_lookup_idx
  ON line_friend_whitelist_grants (account_id, target_mid, scope_kind, chat_type, chat_id, version DESC)
  WHERE state = 'ACTIVE';
