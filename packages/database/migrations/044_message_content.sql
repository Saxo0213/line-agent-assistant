-- Layer 2 of the two-layer message storage: the content bridge's projection of messages.raw / raw.native.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content jsonb;
-- 0 = never projected (or a type with no projection); otherwise the version of the bridge rule that produced `content`.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_rule_version integer NOT NULL DEFAULT 0;
-- Re-projection after a rule change selects rows by (content type, rule version) among rows that still hold Layer-1 data.
CREATE INDEX IF NOT EXISTS messages_content_reprojection_idx
  ON messages (account_id, (raw->'message'->>'contentType'), content_rule_version)
  WHERE raw ? 'message' OR raw ? 'native';
