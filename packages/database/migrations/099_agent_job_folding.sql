-- A LINE job whose message arrived while an earlier turn of the same chat ran can be folded into the next claimed job
-- (the lead). A folded job stays queued, is never claimed, and takes the lead's final status when the lead ends.
ALTER TABLE agent_jobs ADD COLUMN folded_into uuid NULL REFERENCES agent_jobs(job_id) ON DELETE SET NULL;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_folded_into_not_self_check CHECK (folded_into IS NULL OR folded_into <> job_id);
CREATE INDEX agent_jobs_folded_into_idx ON agent_jobs (folded_into) WHERE folded_into IS NOT NULL;
