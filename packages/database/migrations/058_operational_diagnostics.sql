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
      'agent_codex_logout','agent_claude_logout','external_monitor_toggle','audit_sink_failed','audit_sink_recovered',
      'friend_enrollment','friend_relation_initial','friend_add_attempt','friend_relation_recheck',
      'friend_authorization_precheck','friend_grant_commit','worker_operation_error','line_catalog_refresh',
      'primary_admin_bound_external_monitor','runtime_error') THEN
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
      'phase','reason_code','result_code','error_code','dropped_count','masked_mid','diagnostic'] <> '{}'::jsonb THEN
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
       'AGENT_AUTH_FAILED','SECRET_CLEAR_FAILED','UNKNOWN','RELATION_LIST_RPC_FAILED','RELATION_LIST_SHAPE_INVALID',
       'RELATION_LIST_LIMIT','RELATION_DETAIL_RPC_FAILED','RELATION_DETAIL_SHAPE_INVALID','RELATION_CANCELLED',
       'RELATION_BINDING_REVOKED','RELATION_RESPONSE_TIMEOUT','RELATION_WORKER_EXIT','RELATION_OUTCOME_UNKNOWN',
       'ENROLLMENT_BINDING_CHANGED','SIDE_EFFECT_DENIED','NOT_STARTED','TRANSPORT_OUTCOME_UNKNOWN',
       'ENROLLMENT_PRECHECK_FAILED','ENROLLMENT_GRANT_FAILED','ENROLLMENT_REPLY_FAILED','ENROLLMENT_REPLY_UNKNOWN',
       'INVALID_COMMAND','QUEUE_FULL','CATALOG_REFRESH_FAILED','WORKER_OPERATION_FAILED','HISTORY_READ_FAILED',
       'CHAT_RESOURCE_READ_FAILED','PROFILE_REFRESH_FAILED','MESSAGE_SEND_FAILED','MESSAGE_UNSEND_FAILED',
       'MESSAGE_REACTION_FAILED','FRIEND_RELATION_CHECK_FAILED','FRIEND_ADD_FAILED',
       'ATTACHMENT_DOWNLOAD_OPERATION_FAILED','CREDENTIAL_RESTORE_FAILED','LINE_SYNC_FAILED') THEN
    RAISE EXCEPTION 'invalid audit error code';
  END IF;
  IF NEW.details ? 'result_code' AND NEW.details->>'result_code' NOT IN
      ('worker_stopped','secret_removed','agent_auth_action_completed','audit_sink_recovered','relation_friend',
       'relation_not_friend','relation_unknown','add_added','add_unknown','add_failed','precheck_ready',
       'authorization_active','grant_committed','authorization_active_reply_sent','authorization_active_reply_failed',
       'authorization_active_reply_unknown','authorization_denied','catalog_refresh_recovered') THEN
    RAISE EXCEPTION 'invalid audit result code';
  END IF;
  FOR item IN SELECT value FROM jsonb_each(NEW.details)
  LOOP
    IF jsonb_typeof(item) = 'string' AND length(item #>> '{}') > 128 THEN
      RAISE EXCEPTION 'audit value exceeds 128 characters';
    END IF;
  END LOOP;
  IF NEW.details ? 'diagnostic' THEN
    IF jsonb_typeof(NEW.details->'diagnostic') <> 'object'
      OR (NEW.details->'diagnostic') - ARRAY['operation','stage','category','recovery','outcome','statusCode','reason','provider'] <> '{}'::jsonb
      OR COALESCE(NEW.details->'diagnostic'->>'operation' NOT IN ('init','adoptDownloadAuth','loginQr','loginToken','setSecretState','poll','ackBatch','history','chatResourceRead','refreshOwnProfile','cancelChatResourceRead','sendText','manualSendText','sendMedia','unsendMessage','reactMessage','checkFriendRelation','addFriendByMid','downloadAttachment','cancelAttachmentDownload','revokeControl','stop','ipc','database','attachment','agent','mcp','external_monitor','chat_resource','startup','shutdown','snapshot','audit_sink','line_ingest','delivery','secret_store','provider_auth','native_reader','renderer','catalog_refresh','unknown','note_list','note_detail','album_list','album_photos','photo_download'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'stage' NOT IN ('admission','bootstrap','dispatch','execute','response','persist','publish','read','write','spawn','parse','cancel','cleanup','shutdown','recover','authenticate','queue','store','download','prepare','unknown','facade_checkpoint_fence','facade_startup_selection','reader_resource_verification','private_directory_preparation','reader_request_resources','owner_admission_marker','child_identity','protocol_source_ready','directory_callback_ack','first_poll_callback_ack'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'category' NOT IN ('unavailable','invalid_input','unsupported','invalid_response','timeout','cancelled','denied','stale_binding','authentication_required','persistence_failed','transport_failed','process_start_failed','process_exit','event_publish_failed','queue_full','outcome_unknown','unknown'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'recovery' NOT IN ('retry','reconnect','relogin','check_configuration','reopen_app','wait','none','inspect_outcome'), true) THEN
      RAISE EXCEPTION 'invalid safe diagnostic';
    END IF;
    IF NEW.details->'diagnostic' ? 'reason' AND COALESCE(NEW.details->'diagnostic'->>'reason' NOT IN ('external_monitor_authority_stale','external_monitor_checkpoint_changed','external_monitor_source_changed','external_monitor_reader_startup_failed','external_monitor_reader_failed','external_monitor_database_failed','external_monitor_unknown','bootstrap_failure','list_get_transport_failure','response_code_invalid','response_shape_invalid','normalization_failure','response_validation','timeout','cancellation','unknown','LOGIN_TIMEOUT','LOGIN_IN_PROGRESS','LOGIN_ATTEMPT_REPLACED','LOGIN_FAILED'), true) THEN
      RAISE EXCEPTION 'invalid diagnostic reason';
    END IF;
    IF NEW.details->'diagnostic' ? 'provider' AND COALESCE(NEW.details->'diagnostic'->>'provider' NOT IN ('codex','claude'), true) THEN
      RAISE EXCEPTION 'invalid diagnostic provider';
    END IF;
    IF NEW.details->'diagnostic' ? 'outcome' AND COALESCE(NEW.details->'diagnostic'->>'outcome' NOT IN ('not_started','failed','unknown','recovered'), true) THEN
      RAISE EXCEPTION 'invalid diagnostic outcome';
    END IF;
    IF NEW.details->'diagnostic' ? 'statusCode' AND
      (jsonb_typeof(NEW.details->'diagnostic'->'statusCode') <> 'number'
       OR (NEW.details->'diagnostic'->>'statusCode')::numeric <> trunc((NEW.details->'diagnostic'->>'statusCode')::numeric)
       OR abs((NEW.details->'diagnostic'->>'statusCode')::numeric) > 1000000000) THEN
      RAISE EXCEPTION 'invalid diagnostic status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
