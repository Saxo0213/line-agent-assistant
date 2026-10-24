ALTER TABLE agent_jobs
  DROP CONSTRAINT agent_jobs_account_id_chat_type_chat_id_source_message_id_fkey;

ALTER TABLE agent_jobs
  ADD COLUMN source_sender_id text;
