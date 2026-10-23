-- Files attached in the local Agent room. Metadata only: [{ name, relativePath, size, mime, kind, sha256 }].
-- The bytes live in the Agent workspace (.agent-attachments/<jobId>/), owned by Main.
-- LINE jobs never carry attachments; the CHECK makes that a database fact, not an application convention.

ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_attachments_shape_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_attachments_shape_check CHECK (
  jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10);

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_attachments_ui_only_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_attachments_ui_only_check CHECK (
  source_type = 'ui' OR attachments = '[]'::jsonb);
