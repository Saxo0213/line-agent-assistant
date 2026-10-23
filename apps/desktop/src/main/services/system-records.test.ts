import { describe, expect, it } from 'vitest';
import type { SafeAuditRecord } from '@line-agent/database';
import type { AttachmentActivityRecord, TerminalAttachmentErrorRecord } from '@line-agent/database';
import { SystemErrorsResultSchema } from '../../desktop-protocol.js';
import { projectSystemActivity, projectSystemErrors, systemActivityResult, systemErrorsResult } from './system-records.js';
import { AUDIT_ACTIONS, AUDIT_ERROR_CODES } from './operational-audit.js';

const audit = (values: Partial<SafeAuditRecord> = {}): SafeAuditRecord => ({ action: 'app_start', phase: 'succeeded',
  initiator: 'system', correlationId: 'private-correlation', createdAt: '2026-10-17T10:00:00.000Z', ...values });

describe('system record projection', () => {
  it('labels every known audit action without using the unknown-action fallback', () => {
    const rows = projectSystemActivity(AUDIT_ACTIONS.map((action) => audit({ action, phase: 'observed' })), []);
    expect(rows).toHaveLength(AUDIT_ACTIONS.length);
    expect(rows.every((row) => row.kind === 'audit' && row.action !== '系統作業')).toBe(true);
  });
  it('keeps every audit error code valid in the IPC result schema', () => {
    const events = AUDIT_ERROR_CODES.map((errorCode) => audit({ phase: 'observed', errorCode }));
    const result = { errors: projectSystemErrors(events, []), partial: false };
    expect(SystemErrorsResultSchema.safeParse(result).success).toBe(true);
  });
  it('projects safe localized activity and current attachment status only', () => {
    const attachment: AttachmentActivityRecord = { accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
      kind: 'image', status: 'queued', retryCount: 0, updatedAt: '2026-10-17T10:01:00.000Z' };
    const rows = projectSystemActivity([audit({ accountId: 'private-account', requestId: 'private-request' })], [attachment]);
    expect(rows).toEqual([
      { kind: 'attachment', createdAt: attachment.updatedAt, action: '圖片下載', status: '等待下載', attachmentKind: 'image', retryCount: 0,
        key: { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' } },
      { kind: 'audit', createdAt: '2026-10-17T10:00:00.000Z', action: '系統啟動', phase: '已完成' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private-(?:correlation|account|request)/);
  });

  it('shows only failures and allowlists every displayed code', () => {
    const rows = projectSystemErrors([
      audit({ phase: 'failed', errorCode: 'SECRET_CUSTOMER_VALUE', reasonCode: 'unknown' }),
      audit({ phase: 'succeeded' }),
      audit({ phase: 'failed', reasonCode: 'auth_invalidated' }),
    ], [{ accountId: 'account-A', chatType: 'direct', chatId: 'peer-A', kind: 'file', status: 'expired', retryCount: 3, updatedAt: '2026-10-17T10:01:00.000Z' }]);
    expect(rows).toEqual([
      { createdAt: '2026-10-17T10:01:00.000Z', action: '附件下載', code: 'ATTACHMENT_EXPIRED' },
      { createdAt: '2026-10-17T10:00:00.000Z', action: '系統啟動', code: 'UNKNOWN_ERROR' },
      { createdAt: '2026-10-17T10:00:00.000Z', action: '系統啟動', code: 'AUTH_INVALIDATED' },
    ]);
  });

  it('projects scoped LINE worker diagnostics and accepts their IPC codes', () => {
    const events = [
      audit({ action: 'worker_operation_error', phase: 'observed', errorCode: 'INVALID_COMMAND' }),
      audit({ action: 'worker_operation_error', phase: 'observed', errorCode: 'QUEUE_FULL' }),
      audit({ action: 'worker_operation_error', phase: 'observed', errorCode: 'WORKER_OPERATION_FAILED' }),
      audit({ action: 'line_catalog_refresh', phase: 'observed', errorCode: 'CATALOG_REFRESH_FAILED' }),
      audit({ action: 'line_catalog_refresh', phase: 'observed', resultCode: 'catalog_refresh_recovered' }),
      audit({ action: 'friend_relation_initial', phase: 'observed', errorCode: 'RELATION_LIST_SHAPE_INVALID' }),
    ];
    expect(projectSystemErrors(events, [])).toEqual([
      { createdAt: events[0]!.createdAt, action: 'LINE 操作失敗', code: 'INVALID_COMMAND' },
      { createdAt: events[1]!.createdAt, action: 'LINE 操作失敗', code: 'QUEUE_FULL' },
      { createdAt: events[2]!.createdAt, action: 'LINE 操作失敗', code: 'WORKER_OPERATION_FAILED' },
      { createdAt: events[3]!.createdAt, action: 'LINE 聯絡人／群組清單更新', code: 'CATALOG_REFRESH_FAILED' },
      { createdAt: events[5]!.createdAt, action: '新增使用者：確認 LINE 好友關係', code: 'RELATION_LIST_SHAPE_INVALID' },
    ]);
    expect(projectSystemActivity([events[4]!], [])).toMatchObject([{ kind: 'audit', createdAt: events[4]!.createdAt,
      action: 'LINE 聯絡人／群組清單更新' }]);
    expect(SystemErrorsResultSchema.safeParse({ errors: projectSystemErrors(events, []), partial: false }).success).toBe(true);
  });

  it('drops invalid timestamps and keeps retryable attachment failures out of system errors', () => {
    const retryable = { accountId: 'account-A', chatType: 'direct', chatId: 'peer-A', kind: 'file', status: 'failed', retryCount: 1, updatedAt: '2026-10-17T10:00:00.000Z' } as TerminalAttachmentErrorRecord;
    const badTime = audit({ phase: 'failed', createdAt: 'no date' });
    expect(projectSystemErrors([badTime], [retryable])).toEqual([]);
  });

  it('returns partial source data and reports unavailable when both activity sources fail', () => {
    const availableAudit = { available: true, partial: false, value: [audit()] };
    const unavailableAttachments = { available: false, partial: false, value: [] as AttachmentActivityRecord[] };
    expect(systemActivityResult(availableAudit, unavailableAttachments)).toMatchObject({ partial: true, activity: [{ kind: 'audit' }] });
    expect(() => systemActivityResult({ ...availableAudit, available: false, value: [] }, unavailableAttachments))
      .toThrow('SYSTEM_ACTIVITY_UNAVAILABLE');
  });

  it('returns partial error data and reports unavailable when both error sources fail', () => {
    const availableAudit = { available: false, partial: true, events: [] as SafeAuditRecord[] };
    const availableAttachments = { available: true, partial: false, value: [] as TerminalAttachmentErrorRecord[] };
    expect(systemErrorsResult(availableAudit, availableAttachments)).toEqual({ errors: [], partial: true });
    expect(() => systemErrorsResult({ ...availableAudit, available: false, partial: false }, { ...availableAttachments, available: false }))
      .toThrow('SYSTEM_ERRORS_UNAVAILABLE');
  });
});
