-- Agent send failure evidence: the diagnostic may carry a bounded text detail, and the error code list is the same as AUDIT_ERROR_CODES
-- (it now has the LINE server codes). The diagnostic operation and IPC action lists now hold every shared contract value
-- (the operation logout and the later IPC actions). Only the trigger function changes (same function as 074).
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
      'primary_admin_bound_external_monitor','runtime_error','album_photo_download',
      'line_ingest_slow_upstream','line_ingest_slow_main') THEN
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
      'phase','reason_code','result_code','error_code','dropped_count','masked_mid','diagnostic','latency'] <> '{}'::jsonb THEN
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
      ('DATABASE_WRITE_FAILED','FALLBACK_WRITE_FAILED','WORKER_STOP_FAILED','WORKER_STOP_TIMEOUT','AGENT_AUTH_FAILED',
       'SECRET_CLEAR_FAILED','UNKNOWN','RELATION_LIST_RPC_FAILED','RELATION_LIST_SHAPE_INVALID','RELATION_LIST_LIMIT',
       'RELATION_DETAIL_RPC_FAILED','RELATION_DETAIL_SHAPE_INVALID','RELATION_CANCELLED','RELATION_BINDING_REVOKED',
       'RELATION_RESPONSE_TIMEOUT','RELATION_WORKER_EXIT','RELATION_OUTCOME_UNKNOWN','ENROLLMENT_BINDING_CHANGED',
       'SIDE_EFFECT_DENIED','NOT_STARTED','TRANSPORT_OUTCOME_UNKNOWN','ENROLLMENT_PRECHECK_FAILED',
       'ENROLLMENT_GRANT_FAILED','ENROLLMENT_REPLY_FAILED','ENROLLMENT_REPLY_UNKNOWN','INVALID_COMMAND','QUEUE_FULL',
       'CATALOG_REFRESH_FAILED','WORKER_OPERATION_FAILED','HISTORY_READ_FAILED','CHAT_RESOURCE_READ_FAILED',
       'PROFILE_REFRESH_FAILED','MESSAGE_SEND_FAILED','MESSAGE_UNSEND_FAILED','MESSAGE_REACTION_FAILED',
       'FRIEND_RELATION_CHECK_FAILED','FRIEND_ADD_FAILED','PRIMARY_ADMIN_NOT_FRIEND',
       'ATTACHMENT_DOWNLOAD_OPERATION_FAILED','CREDENTIAL_RESTORE_FAILED','LINE_SYNC_FAILED',
       'LINE_TALK_ILLEGAL_ARGUMENT','LINE_TALK_AUTHENTICATION_FAILED','LINE_TALK_EXCESSIVE_ACCESS',
       'LINE_TALK_NOT_FOUND','LINE_TALK_INVALID_LENGTH','LINE_TALK_NOT_AVAILABLE_USER',
       'LINE_TALK_NOT_AUTHORIZED_DEVICE','LINE_TALK_INVALID_MID','LINE_TALK_NOT_A_MEMBER',
       'LINE_TALK_NO_SUCH_MESSAGE_BOX','LINE_TALK_NOT_AVAILABLE_MESSAGE_BOX','LINE_TALK_NOT_YOUR_MESSAGE',
       'LINE_TALK_ABUSE_BLOCK','LINE_TALK_NOT_FRIEND','LINE_TALK_NOT_ALLOWED_ADD_CONTACT',
       'LINE_TALK_EXCEED_FILE_MAX_SIZE','LINE_TALK_EXCEED_DAILY_QUOTA','LINE_TALK_NOT_SUPPORT_SEND_FILE',
       'LINE_TALK_EXPIRED_REVISION','LINE_TALK_MESSAGE_NOT_FOUND','LINE_TALK_FEATURE_RESTRICTED',
       'LINE_TALK_MESSAGE_NOT_DESTRUCTIBLE','LINE_TALK_E2EE_INVALID_PROTOCOL','LINE_TALK_E2EE_RETRY_ENCRYPT',
       'LINE_TALK_E2EE_UPDATE_SENDER_KEY','LINE_TALK_E2EE_UPDATE_RECEIVER_KEY','LINE_TALK_E2EE_INVALID_ARGUMENT',
       'LINE_TALK_E2EE_INVALID_VERSION','LINE_TALK_E2EE_SENDER_DISABLED','LINE_TALK_E2EE_RECEIVER_DISABLED',
       'LINE_TALK_E2EE_SENDER_NOT_ALLOWED','LINE_TALK_E2EE_RECEIVER_NOT_ALLOWED','LINE_TALK_E2EE_RESEND_FAIL',
       'LINE_TALK_E2EE_RESEND_OK','LINE_TALK_E2EE_UPDATE_PRIMARY_DEVICE','LINE_TALK_E2EE_PRIMARY_NOT_SUPPORT',
       'LINE_TALK_E2EE_RETRY_PLAIN','LINE_TALK_E2EE_RECREATE_GROUP_KEY','LINE_TALK_E2EE_GROUP_TOO_MANY_MEMBERS',
       'LINE_TALK_SERVER_BUSY','LINE_TALK_INCOMING_FRIEND_REQUEST_LIMIT','LINE_TALK_OUTGOING_FRIEND_REQUEST_LIMIT',
       'LINE_TALK_OUTGOING_FRIEND_REQUEST_QUOTA','LINE_TALK_DUPLICATED','LINE_TALK_SHOULD_RETRY',
       'LINE_TALK_MUST_REFRESH_V3_TOKEN','LINE_TALK_REFRESH_MEDIA_FLOW','LINE_TALK_DB_FAILED',
       'LINE_TALK_INVALID_STATE','LINE_TALK_INCOMPATIBLE_APP_VERSION','LINE_TALK_NOT_READY',
       'LINE_TALK_NOT_AVAILABLE_SESSION','LINE_TALK_NOT_AUTHORIZED_SESSION','LINE_TALK_SYSTEM_ERROR',
       'LINE_TALK_NO_AVAILABLE_VERIFICATION_METHOD','LINE_TALK_NOT_AUTHENTICATED',
       'LINE_TALK_INVALID_IDENTITY_CREDENTIAL','LINE_TALK_NOT_AVAILABLE_IDENTITY_IDENTIFIER',
       'LINE_TALK_INTERNAL_ERROR','LINE_TALK_NO_SUCH_IDENTITY_IDENFIER',
       'LINE_TALK_DEACTIVATED_ACCOUNT_BOUND_TO_THIS_IDENTITY','LINE_TALK_ILLEGAL_IDENTITY_CREDENTIAL',
       'LINE_TALK_UNKNOWN_CHANNEL','LINE_TALK_CHANNEL_DOES_NOT_MATCH','LINE_TALK_MESSAGE_DEFINED_ERROR',
       'LINE_TALK_USER_CANNOT_ACCEPT_PRESENTS','LINE_TALK_USER_NOT_STICKER_OWNER','LINE_TALK_MAINTENANCE_ERROR',
       'LINE_TALK_ACCOUNT_NOT_MATCHED','LINE_TALK_NOT_ALLOWED_CALL','LINE_TALK_BLOCK_FRIEND',
       'LINE_TALK_INCOMPATIBLE_VOIP_VERSION','LINE_TALK_INVALID_SNS_ACCESS_TOKEN',
       'LINE_TALK_EXTERNAL_SERVICE_NOT_AVAILABLE','LINE_TALK_NOT_CERTIFICATED',
       'LINE_TALK_NOT_ALLOWED_SECONDARY_DEVICE','LINE_TALK_INVALID_PIN_CODE','LINE_TALK_MUST_UPGRADE',
       'LINE_TALK_NOT_AVAILABLE_PIN_CODE_SESSION','LINE_TALK_NOT_YET_PHONE_NUMBER','LINE_TALK_BAD_CALL_NUMBER',
       'LINE_TALK_UNAVAILABLE_CALL_NUMBER','LINE_TALK_NOT_SUPPORT_CALL_SERVICE','LINE_TALK_CONGESTION_CONTROL',
       'LINE_TALK_NO_BALANCE','LINE_TALK_NOT_PERMITTED_CALLER_ID','LINE_TALK_NO_CALLER_ID_LIMIT_EXCEEDED',
       'LINE_TALK_CALLER_ID_VERIFICATION_REQUIRED','LINE_TALK_NO_CALLER_ID_LIMIT_EXCEEDED_AND_VERIFICATION_REQUIRED',
       'LINE_TALK_INVALID_ACCOUNT_MIGRATION_PINCODE_FORMAT','LINE_TALK_ACCOUNT_MIGRATION_PINCODE_NOT_MATCHED',
       'LINE_TALK_ACCOUNT_MIGRATION_PINCODE_BLOCKED','LINE_TALK_INVALID_PASSWORD_FORMAT',
       'LINE_TALK_PAID_CALL_REDEEM_FAILED','LINE_TALK_PREVENTED_JOIN_BY_TICKET',
       'LINE_TALK_SEND_MESSAGE_NOT_PERMITTED_FROM_LINE_AT','LINE_TALK_SEND_MESSAGE_NOT_PERMITTED_WHILE_AUTO_REPLY',
       'LINE_TALK_SECURITY_CENTER_NOT_VERIFIED','LINE_TALK_SECURITY_CENTER_BLOCKED_BY_SETTING',
       'LINE_TALK_SECURITY_CENTER_BLOCKED','LINE_TALK_TALK_PROXY_EXCEPTION',
       'LINE_TALK_HITOKOTO_BACKUP_NO_AVAILABLE_DATA','LINE_TALK_SUCCESS','LINE_TALK_CANCEL',
       'LINE_TALK_NOT_ALLOWED_ADD_FOLLOW','LINE_TALK_BANNED','LINE_TALK_NOT_AN_INVITEE','LINE_TALK_NOT_AN_OUTSIDER',
       'LINE_TALK_EMPTY_GROUP','LINE_TALK_EXCEED_FOLLOW_LIMIT','LINE_TALK_UNSUPPORTED_ACCOUNT_TYPE',
       'LINE_TALK_AGREEMENT_REQUIRED','LINE_TALK_OVER_MAX_CHATS_PER_USER','LINE_TALK_NOT_AVAILABLE_API',
       'LINE_TALK_INVALID_OTP','LINE_TALK_ALREADY_EXPIRED','LINE_TALK_USER_NOT_STICON_OWNER',
       'LINE_TALK_EXCEED_FOLLOWER_LIMIT','LINE_TALK_INCOMPATIBLE_APP_TYPE','LINE_TALK_NOT_PREMIUM',
       'LINE_TALK_BITMAX_ACCOUNT_EXIST','LINE_RELATION_ADD_UNKNOWN','LINE_RELATION_ADD_INVALID_TARGET_USER',
       'LINE_RELATION_ADD_AGE_VALIDATION','LINE_RELATION_ADD_TOO_MANY_FRIENDS','LINE_RELATION_ADD_TOO_MANY_REQUESTS',
       'LINE_RELATION_ADD_MALFORMED_REQUEST','LINE_RELATION_ADD_TRACKING_META_QRCODE_FAVORED',
       'LINE_RELATION_ADD_TRACKING_META_UPGRADE_FAVORED') THEN
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
  IF NEW.details ? 'latency' THEN
    IF jsonb_typeof(NEW.details->'latency') <> 'object'
      OR (NEW.details->'latency') - ARRAY['lineToMainMs','mainIngestMs','queueLength','messageCount','reemitCount'] <> '{}'::jsonb
      OR NOT (NEW.details->'latency' ?& ARRAY['lineToMainMs','mainIngestMs','queueLength','messageCount','reemitCount']) THEN
      RAISE EXCEPTION 'invalid ingest latency';
    END IF;
    FOR item IN SELECT value FROM jsonb_each(NEW.details->'latency')
    LOOP
      IF jsonb_typeof(item) <> 'number' OR (item #>> '{}')::numeric < 0 OR (item #>> '{}')::numeric <> trunc((item #>> '{}')::numeric)
        OR (item #>> '{}')::numeric > 31536000000 THEN
        RAISE EXCEPTION 'invalid ingest latency value';
      END IF;
    END LOOP;
  END IF;
  IF NEW.details ? 'diagnostic' THEN
    IF jsonb_typeof(NEW.details->'diagnostic') <> 'object'
      OR (NEW.details->'diagnostic') - ARRAY['operation','stage','category','recovery','outcome','statusCode','reason','provider','failureKind','upstreamStatus','upstreamCode','ipcAction','detail'] <> '{}'::jsonb
      OR COALESCE(NEW.details->'diagnostic'->>'operation' NOT IN ('init','adoptDownloadAuth','loginQr','loginToken','setSecretState','poll','ackBatch','history','chatResourceRead','refreshOwnProfile','cancelChatResourceRead','sendText','manualSendText','sendMedia','unsendMessage','reactMessage','checkFriendRelation','addFriendByMid','downloadAttachment','cancelAttachmentDownload','revokeControl','stop','ipc','database','attachment','agent','mcp','external_monitor','chat_resource','startup','shutdown','snapshot','audit_sink','line_ingest','delivery','secret_store','provider_auth','native_reader','renderer','catalog_refresh','unknown','note_list','note_detail','album_list','album_photos','photo_download','logout'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'stage' NOT IN ('admission','bootstrap','dispatch','execute','response','persist','publish','read','write','spawn','parse','cancel','cleanup','shutdown','recover','authenticate','queue','store','download','prepare','unknown','archive_contains','facade_checkpoint_fence','facade_startup_selection','reader_resource_verification','private_directory_preparation','reader_request_resources','owner_admission_marker','child_identity','protocol_source_ready','directory_callback_ack','first_poll_callback_ack'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'category' NOT IN ('unavailable','invalid_input','unsupported','invalid_response','timeout','cancelled','denied','stale_binding','authentication_required','persistence_failed','transport_failed','process_start_failed','process_exit','event_publish_failed','queue_full','outcome_unknown','unknown'), true)
      OR COALESCE(NEW.details->'diagnostic'->>'recovery' NOT IN ('retry','reconnect','relogin','check_configuration','reopen_app','wait','none','inspect_outcome'), true) THEN
      RAISE EXCEPTION 'invalid safe diagnostic';
    END IF;
    IF NEW.details->'diagnostic' ? 'detail' AND (jsonb_typeof(NEW.details->'diagnostic'->'detail') <> 'string'
      OR NEW.details->'diagnostic'->>'detail' !~ '^[A-Za-z0-9_.:-]{1,160}$') THEN
      RAISE EXCEPTION 'invalid diagnostic detail';
    END IF;
    IF NEW.details->'diagnostic' ? 'ipcAction' AND COALESCE(NEW.details->'diagnostic'->>'ipcAction' NOT IN ('getSnapshot','reportRendererFailure','searchAgentJobs','lineAddAccountQr','lineLoginQr','lineReplaceAgentQr','lineLogout','refreshLineAvatar','lineSetAutoLogin','lineBeginAdminPairing','lineStart','externalImportStart','externalImportStop','previewExternalAdminBinding','startExternalMonitorAsAdmin','officialLineApproveSigner','lineSyncHistory','submitAgentRoomPrompt','stopAgentRoomJob','retryAgentRoomJob','getAgentRoomJobEvents','listMessages','listAttachments','listChatNotes','getChatNote','listChatAlbums','listChatAlbumPhotos','downloadChatAlbumPhoto','openChatAlbum','openReadableChatAlbumFolder','cancelChatResourceRequest','sendText','replyText','sendManualMedia','unsendMessage','getManualUnsendWindow','setManualUnsendWindow','stopJob','retryJob','newSession','getJobEvents','searchMessages','openExternalUrl','openAttachment','downloadAttachment','revealAttachment','resolveFileTypeIcon','subscribeEvents','setConversationAgent','switchControl','setDefaultAgent','setWorkspace','getConversationSettings','setConversationSettings','getAutoResponderSettings','setAutoResponderSettings','agentLogin','agentLogout','agentRefreshStatus','mcpGetStatus','mcpLocalClientStatus','mcpLocalClientConnect','mcpLocalClientDisconnect','mcpListTokens','mcpIssueToken','mcpRevokeToken','mcpCallInternalTool','getAgentPermissions','getAgentPermissionDefaults','setAgentPermissionDefault','revokeAgentWhitelistUser','setAgentPermission','getAgentExecutionPolicy','setAgentExecutionPolicy','listAgentToolAllowlist','removeAgentToolAllowlistEntry','clearAgentToolAllowlist','decideAgentApproval','listPendingAgentApprovals','setAgentFolderLink','createChatFolder','openChatFolder','listAgentSchedules','createAgentSchedule','updateAgentSchedule','deleteAgentSchedule','listAgentScheduleRuns','listAgentScheduleTargets','getChromeLoginAvailability','detectChromeLtsm','chooseChromeLtsmFolder','openChromeExtensionStore','getAgentPersona','setAgentPersona','getAgentExtensions','saveAgentMcpServer','deleteAgentMcpServer','setAgentMcpServerEnabled','setAgentExtensionTools','listAgentMcpImportCandidates','importAgentMcpServers'), true) THEN
      RAISE EXCEPTION 'invalid diagnostic IPC action';
    END IF;
    IF NEW.details->'diagnostic' ? 'reason' AND COALESCE(NEW.details->'diagnostic'->>'reason' NOT IN ('external_monitor_authority_stale','external_monitor_checkpoint_changed','external_monitor_source_changed','external_monitor_reader_startup_failed','external_monitor_reader_failed','external_monitor_database_failed','external_monitor_unknown','bootstrap_failure','list_get_transport_failure','response_code_invalid','response_shape_invalid','normalization_failure','response_validation','timeout','cancellation','unknown','AGENT_IDENTITY_MISMATCH','LOGIN_TIMEOUT','LOGIN_IN_PROGRESS','LOGIN_ATTEMPT_REPLACED','LOGIN_FAILED'), true) THEN
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
    IF NEW.details->'diagnostic' ? 'failureKind' AND COALESCE(NEW.details->'diagnostic'->>'failureKind' NOT IN ('linejs_internal','effect_denied','type_error','range_error','timeout_error','abort_error','other'), true) THEN
      RAISE EXCEPTION 'invalid diagnostic failure kind';
    END IF;
    IF NEW.details->'diagnostic' ? 'upstreamStatus' AND
      (CASE WHEN jsonb_typeof(NEW.details->'diagnostic'->'upstreamStatus') <> 'number' THEN true
            WHEN (NEW.details->'diagnostic'->>'upstreamStatus')::numeric <> trunc((NEW.details->'diagnostic'->>'upstreamStatus')::numeric) THEN true
            ELSE (NEW.details->'diagnostic'->>'upstreamStatus')::numeric NOT BETWEEN 100 AND 599 END) THEN
      RAISE EXCEPTION 'invalid diagnostic upstream';
    END IF;
    IF NEW.details->'diagnostic' ? 'upstreamCode' AND
      (CASE WHEN jsonb_typeof(NEW.details->'diagnostic'->'upstreamCode') = 'string' THEN NEW.details->'diagnostic'->>'upstreamCode' NOT IN ('missing','non_numeric')
            WHEN jsonb_typeof(NEW.details->'diagnostic'->'upstreamCode') <> 'number' THEN true
            WHEN (NEW.details->'diagnostic'->>'upstreamCode')::numeric <> trunc((NEW.details->'diagnostic'->>'upstreamCode')::numeric) THEN true
            ELSE abs((NEW.details->'diagnostic'->>'upstreamCode')::numeric) > 1000000000 END) THEN
      RAISE EXCEPTION 'invalid diagnostic upstream';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
