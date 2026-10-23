ALTER TABLE conversations ADD COLUMN native_metadata jsonb NOT NULL
  DEFAULT '{"midType":null,"parentChatId":null,"communityId":null}'::jsonb;
ALTER TABLE conversations ADD CONSTRAINT conversations_native_metadata_shape_check CHECK (
  jsonb_typeof(native_metadata) = 'object'
  AND native_metadata ?& ARRAY['midType', 'parentChatId', 'communityId']
  AND (native_metadata - ARRAY['midType', 'parentChatId', 'communityId']) = '{}'::jsonb
  AND (native_metadata->'midType' = 'null'::jsonb
    OR (jsonb_typeof(native_metadata->'midType') = 'number' AND (native_metadata->>'midType') ~ '^(0|[1-9][0-9]*)$'))
  AND (native_metadata->'parentChatId' = 'null'::jsonb
    OR (jsonb_typeof(native_metadata->'parentChatId') = 'string' AND char_length(native_metadata->>'parentChatId') <= 256))
  AND (native_metadata->'communityId' = 'null'::jsonb
    OR (jsonb_typeof(native_metadata->'communityId') = 'string' AND char_length(native_metadata->>'communityId') <= 256))
);

ALTER TABLE conversations DROP CONSTRAINT conversations_chat_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_chat_type_check
  CHECK (chat_type IN ('direct', 'group', 'room', 'community', 'thread'));
ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_chat_type_check;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_chat_type_check
  CHECK (chat_type IN ('direct', 'group', 'room', 'community', 'thread'));
ALTER TABLE messages DROP CONSTRAINT messages_chat_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_chat_type_check
  CHECK (chat_type IN ('direct', 'group', 'room', 'community', 'thread'));
