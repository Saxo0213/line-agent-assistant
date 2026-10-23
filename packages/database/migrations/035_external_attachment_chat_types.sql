ALTER TABLE attachments DROP CONSTRAINT attachments_chat_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_chat_type_check
  CHECK (chat_type IN ('direct', 'group', 'room', 'community', 'thread'));
