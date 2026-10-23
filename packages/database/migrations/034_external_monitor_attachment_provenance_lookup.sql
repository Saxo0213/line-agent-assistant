-- Recovery and manual retry distinguish external-monitor attachments from
-- ordinary LINE attachments using the canonical account/message provenance.
CREATE INDEX IF NOT EXISTS message_source_provenance_external_attachment_idx
  ON message_source_provenance (account_id, message_id)
  WHERE origin = 'EXTERNAL_MONITOR';
