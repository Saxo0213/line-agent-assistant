-- External schedules retain the local client's authorized account scope through each scheduled Agent job.
-- NULL denotes an existing or internally created operator schedule with the legacy full scope; an empty array is a restricted scope.
ALTER TABLE agent_schedules
  ADD COLUMN external_account_scope text[];

ALTER TABLE agent_jobs
  ADD COLUMN mcp_account_scope text[];

ALTER TABLE agent_schedules
  ADD CONSTRAINT agent_schedules_external_account_scope_valid
  CHECK (external_account_scope IS NULL OR (cardinality(external_account_scope) <= 32 AND array_position(external_account_scope, NULL) IS NULL));

ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_mcp_account_scope_valid
  CHECK (mcp_account_scope IS NULL OR (cardinality(mcp_account_scope) <= 32 AND array_position(mcp_account_scope, NULL) IS NULL));
