-- Allows the operational audit trail to record that the Primary Admin was bound from
-- the official LINE identity (External Monitor). The MID is stored masked only.
-- Same rules as 025_operational_audit.sql plus one action and one masked-MID field.
CREATE OR REPLACE FUNCTION validate_operational_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(NEW.details) <> 'object' THEN
    RAISE EXCEPTION 'audit details must be an object';
  END IF;
  IF NEW.action NOT IN ('app_start','app_stop','service_start','service_stop','worker_start','worker_stop','worker_restart',
      'worker_quarantine','worker_exited','line_login_started','line_login_qr_ready','line_login_pin_ready',
      'line_login_succeeded','line_login_failed','line_auth_invalidated','secret_persisted','secret_clear',
      'account_control','account_mode','agent_provider_status','agent_codex_login','agent_claude_login',
      'agent_codex_logout','agent_claude_logout','external_monitor_toggle',
      'audit_sink_failed','audit_sink_recovered','primary_admin_bound_external_monitor') THEN
    RAISE EXCEPTION 'invalid audit action';
  END IF;
  IF COALESCE(NEW.details->>'phase' NOT IN ('requested','succeeded','failed','observed'), true)
    OR COALESCE(length(NEW.details->>'correlation_id') NOT BETWEEN 1 AND 128, true) THEN
    RAISE EXCEPTION 'invalid audit phase or correlation id';
  END IF;
  IF octet_length(NEW.details::text) > 8192 THEN
    RAISE EXCEPTION 'audit record exceeds 8 KB';
  END IF;
  IF NEW.details - ARRAY['account_id','worker_instance_id','login_attempt_id','correlation_id','request_id','job_id',
      'phase','reason_code','result_code','error_code','dropped_count','masked_mid'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'audit record contains unsupported fields';
  END IF;
  IF NEW.details ? 'masked_mid' AND NEW.details->>'masked_mid' !~ '^u[0-9a-f]{4}…[0-9a-f]{4}$' THEN
    RAISE EXCEPTION 'invalid audit masked mid';
  END IF;
  IF NEW.details ? 'dropped_count' AND (jsonb_typeof(NEW.details->'dropped_count') <> 'number'
    OR (NEW.details->>'dropped_count')::bigint < 0) THEN
    RAISE EXCEPTION 'invalid audit dropped count';
  END IF;
  IF NEW.actor IS NULL OR NEW.actor NOT IN ('user','system','worker') THEN
    RAISE EXCEPTION 'invalid audit initiator';
  END IF;
  IF NEW.details ? 'reason_code' AND NEW.details->>'reason_code' NOT IN
      ('operator_action','startup','shutdown','worker_exit','auth_invalidated','recovery','provider_status','unknown') THEN
    RAISE EXCEPTION 'invalid audit reason code';
  END IF;
  IF NEW.details ? 'error_code' AND NEW.details->>'error_code' NOT IN
      ('DATABASE_WRITE_FAILED','FALLBACK_WRITE_FAILED','WORKER_STOP_FAILED','WORKER_STOP_TIMEOUT',
       'AGENT_AUTH_FAILED','SECRET_CLEAR_FAILED','UNKNOWN') THEN
    RAISE EXCEPTION 'invalid audit error code';
  END IF;
  IF NEW.details ? 'result_code' AND NEW.details->>'result_code' NOT IN
      ('worker_stopped','secret_removed','agent_auth_action_completed','audit_sink_recovered') THEN
    RAISE EXCEPTION 'invalid audit result code';
  END IF;
  FOR item IN SELECT value FROM jsonb_each(NEW.details)
  LOOP
    IF jsonb_typeof(item) = 'string' AND length(item #>> '{}') > 128 THEN
      RAISE EXCEPTION 'audit value exceeds 128 characters';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
