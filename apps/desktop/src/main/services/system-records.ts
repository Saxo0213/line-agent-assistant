import type { SafeAuditRecord } from '@line-agent/database';
import type { AttachmentActivityRecord, TerminalAttachmentErrorRecord } from '@line-agent/database';
import type { SystemActivity, SystemErrorRow } from '../../desktop-protocol.js';
import { parseSafeDiagnostic } from '@line-agent/contracts';
import { AUDIT_ACTIONS, AUDIT_ERROR_CODES, AUDIT_REASON_CODES, type AuditAction, type AuditErrorCode, type AuditReasonCode } from './operational-audit.js';

export type SystemActivityRow = SystemActivity;
type SystemActionLabel = SystemErrorRow['action'];
type AttachmentStatusLabel = Extract<SystemActivity, { kind: 'attachment' }>['status'];
type ReadProjection<T> = { available: boolean; partial: boolean; value: readonly T[] };

const actionLabels: Record<AuditAction, SystemActionLabel> = {
  runtime_error: '系統操作失敗',
  app_start: '系統啟動', app_stop: '系統關閉', service_start: '服務啟動', service_stop: '服務停止',
  worker_start: '工作程序啟動', worker_stop: '工作程序停止', worker_restart: '工作程序重新啟動',
  worker_quarantine: '工作程序隔離', worker_exited: '工作程序結束', line_login_started: 'LINE 登入開始',
  line_login_qr_ready: 'LINE QR Code 已準備', line_login_pin_ready: 'LINE PIN 已準備',
  line_login_succeeded: 'LINE 登入完成', line_login_failed: 'LINE 登入失敗', line_auth_invalidated: 'LINE 登入失效',
  secret_persisted: '登入資訊已更新', secret_clear: '清除登入資訊', account_control: '帳號控制變更',
  account_mode: '帳號模式變更', agent_provider_status: 'Agent 狀態變更', agent_codex_login: 'Codex 登入',
  agent_claude_login: 'Claude 登入', agent_codex_logout: 'Codex 登出', agent_claude_logout: 'Claude 登出',
  external_monitor_toggle: '外部監控設定變更', audit_sink_failed: '系統紀錄儲存失敗', audit_sink_recovered: '系統紀錄儲存恢復',
  worker_operation_error: 'LINE 操作失敗', line_catalog_refresh: 'LINE 聯絡人／群組清單更新',
  friend_enrollment: '新增使用者（好友授權）', friend_relation_initial: '新增使用者：確認 LINE 好友關係',
  friend_add_attempt: '新增使用者：加入 LINE 好友', friend_relation_recheck: '新增使用者：重新確認好友',
  friend_authorization_precheck: '新增使用者：授權預檢', friend_grant_commit: '新增使用者：寫入白名單',
  album_photo_download: '相簿照片下載',
  line_ingest_slow_upstream: 'LINE 訊息延遲（LINE 至本機）', line_ingest_slow_main: 'LINE 訊息延遲（本機佇列／寫入）',
};
const phaseLabels: Record<SafeAuditRecord['phase'], Extract<SystemActivity, { kind: 'audit' }>['phase']> = {
  requested: '已提出', succeeded: '已完成', failed: '失敗', observed: '已記錄',
};
const reasonErrorCodes: Record<AuditReasonCode, SystemErrorRow['code']> = {
  operator_action: 'OPERATOR_ACTION_FAILED', startup: 'STARTUP_FAILED', shutdown: 'SHUTDOWN_FAILED',
  worker_exit: 'WORKER_EXITED', auth_invalidated: 'AUTH_INVALIDATED', recovery: 'RECOVERY_FAILED',
  provider_status: 'PROVIDER_STATUS_FAILED', unknown: 'UNKNOWN_ERROR',
};
const attachmentLabels: Record<AttachmentActivityRecord['kind'], Extract<SystemActivity, { kind: 'attachment' }>['action']> = {
  image: '圖片下載', video: '影片下載', audio: '語音下載', file: '檔案下載',
};
const attachmentStatusLabels = (status: AttachmentActivityRecord['status'], retryCount: number): AttachmentStatusLabel => {
  switch (status) {
    case 'queued': return '等待下載';
    case 'downloading': return '下載中';
    case 'ready': return '已完成';
    case 'expired': return '已過期';
    case 'failed': return retryCount >= 3 ? '下載失敗' : '重試中';
  }
};
const normalizedTime = (value: string): string | null => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const actionLabel = (action: string): SystemActionLabel => AUDIT_ACTIONS.includes(action as AuditAction)
  ? actionLabels[action as AuditAction] : '系統作業';

export function projectSystemActivity(events: readonly SafeAuditRecord[], attachments: readonly AttachmentActivityRecord[]): SystemActivityRow[] {
  const rows: SystemActivityRow[] = [];
  for (const event of events) {
    const createdAt = normalizedTime(event.createdAt);
    if (!createdAt || !event.phase) continue;
    rows.push({ kind: 'audit', createdAt, action: actionLabel(event.action), phase: phaseLabels[event.phase] ?? '已記錄' });
  }
  for (const attachment of attachments) {
    const createdAt = normalizedTime(attachment.updatedAt);
    if (!createdAt) continue;
    rows.push({ kind: 'attachment', createdAt, action: attachmentLabels[attachment.kind],
      status: attachmentStatusLabels(attachment.status, attachment.retryCount), attachmentKind: attachment.kind,
      retryCount: attachment.retryCount, key: { accountId: attachment.accountId, chatType: attachment.chatType, chatId: attachment.chatId } });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export function systemActivityResult(audit: ReadProjection<SafeAuditRecord>, attachments: ReadProjection<AttachmentActivityRecord>) {
  if (!audit.available && !attachments.available) throw new Error('SYSTEM_ACTIVITY_UNAVAILABLE');
  return { activity: projectSystemActivity(audit.value, attachments.value),
    partial: !audit.available || !attachments.available || audit.partial };
}

function errorCode(event: SafeAuditRecord): SystemErrorRow['code'] {
  if (typeof event.errorCode === 'string' && event.errorCode.length > 0) {
    return AUDIT_ERROR_CODES.includes(event.errorCode as AuditErrorCode) && event.errorCode !== 'UNKNOWN'
      ? event.errorCode as SystemErrorRow['code'] : 'UNKNOWN_ERROR';
  }
  if (event.reasonCode && AUDIT_REASON_CODES.includes(event.reasonCode as AuditReasonCode)) {
    return reasonErrorCodes[event.reasonCode as AuditReasonCode] ?? 'UNKNOWN_ERROR';
  }
  return 'UNKNOWN_ERROR';
}

export function projectSystemErrors(events: readonly SafeAuditRecord[], attachments: readonly TerminalAttachmentErrorRecord[]): SystemErrorRow[] {
  const rows: SystemErrorRow[] = [];
  for (const event of events) {
    if (event.phase !== 'failed' && !(typeof event.errorCode === 'string' && event.errorCode.length > 0)) continue;
    const createdAt = normalizedTime(event.createdAt);
    if (!createdAt || !event.phase) continue;
    const diagnostic = parseSafeDiagnostic(event.diagnostic);
    rows.push({ createdAt, action: actionLabel(event.action), code: errorCode(event),
      ...(diagnostic ? { diagnostic, ...(/^[A-Za-z0-9_-]{1,128}$/.test(event.correlationId) ? { correlationId: event.correlationId } : {}) } : {}) });
  }
  for (const attachment of attachments) {
    if (attachment.status === 'failed' && attachment.retryCount < 3) continue;
    const createdAt = normalizedTime(attachment.updatedAt);
    if (!createdAt) continue;
    rows.push({ createdAt, action: '附件下載', code: attachment.status === 'expired' ? 'ATTACHMENT_EXPIRED' : 'ATTACHMENT_DOWNLOAD_FAILED' });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export function systemErrorsResult(audit: { available: boolean; partial: boolean; events: readonly SafeAuditRecord[] },
  attachments: ReadProjection<TerminalAttachmentErrorRecord>) {
  if (!audit.available && !attachments.available) throw new Error('SYSTEM_ERRORS_UNAVAILABLE');
  return { errors: projectSystemErrors(audit.events, attachments.value),
    partial: !audit.available || !attachments.available || audit.partial };
}
