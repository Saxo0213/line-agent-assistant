DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_deliveries d
    JOIN agent_jobs j ON j.job_id = d.job_id
    WHERE j.source_type = 'line'
      AND ROW(d.account_id, d.chat_type, d.chat_id, d.creation_epoch)
          IS DISTINCT FROM ROW(j.account_id, j.chat_type, j.chat_id, j.creation_epoch)
  ) THEN
    RAISE EXCEPTION 'Existing LINE delivery route does not match its job';
  END IF;
END $$;

ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_delivery_route_key
  UNIQUE (job_id, account_id, chat_type, chat_id, creation_epoch);

ALTER TABLE agent_deliveries
  ADD CONSTRAINT agent_deliveries_job_route_fkey
  FOREIGN KEY (job_id, account_id, chat_type, chat_id, creation_epoch)
  REFERENCES agent_jobs (job_id, account_id, chat_type, chat_id, creation_epoch);

CREATE FUNCTION enforce_line_delivery_job_route() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  job agent_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM agent_jobs WHERE job_id = NEW.job_id;
  IF job.source_type = 'line'
     AND ROW(NEW.account_id, NEW.chat_type, NEW.chat_id, NEW.creation_epoch)
         IS DISTINCT FROM ROW(job.account_id, job.chat_type, job.chat_id, job.creation_epoch) THEN
    RAISE EXCEPTION 'LINE delivery route must match its job'
      USING ERRCODE = '23503', CONSTRAINT = 'agent_deliveries_job_route_fkey';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_deliveries_job_route_trigger
  BEFORE INSERT OR UPDATE OF job_id, account_id, chat_type, chat_id, creation_epoch
  ON agent_deliveries
  FOR EACH ROW EXECUTE FUNCTION enforce_line_delivery_job_route();

CREATE FUNCTION enforce_line_job_delivery_routes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'line' AND EXISTS (
    SELECT 1 FROM agent_deliveries d
    WHERE d.job_id = NEW.job_id
      AND ROW(d.account_id, d.chat_type, d.chat_id, d.creation_epoch)
          IS DISTINCT FROM ROW(NEW.account_id, NEW.chat_type, NEW.chat_id, NEW.creation_epoch)
  ) THEN
    RAISE EXCEPTION 'LINE job route must match its deliveries'
      USING ERRCODE = '23503', CONSTRAINT = 'agent_deliveries_job_route_fkey';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_jobs_delivery_route_trigger
  BEFORE UPDATE OF source_type, account_id, chat_type, chat_id, creation_epoch
  ON agent_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_line_job_delivery_routes();
