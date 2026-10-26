import { describe, expect, it } from 'vitest';
import type { SafeAuditRecord } from '@line-agent/database';
import type { AttachmentActivityRecord, TerminalAttachmentErrorRecord } from '@line-agent/database';
import { SystemActivityResultSchema, SystemErrorsResultSchema } from '../../desktop-protocol.js';
import { projectSystemActivity, projectSystemErrors, systemActivityResult, systemErrorsResult } from './system-records.js';
import { AUDIT_ACTIONS, AUDIT_ERROR_CODES } from './operational-audit.js';

const audit = (values: Partial<SafeAuditRecord> = {}): SafeAuditRecord => ({ action: 'app_start', phase: 'succeeded',
  initiator: 'system', correlationId: 'private-correlation', createdAt: '2026-10-17T10:00:00.000Z', ...values });

describe('system record projection', () => {
  it('preserves distinct safe IPC actions and correlation IDs through the System Errors schema', () => {
    const events = (['lineLoginQr', 'lineLogout', 'getManualUnsendWindow'] as const).map((ipcAction, index) => audit({
      action: 'runtime_error', phase: 'observed', errorCode: 'UNKNOWN', correlationId: `reference-${index}`,
      diagnostic: { operation: 'ipc', stage: 'execute', category: 'unknown', recovery: 'retry', ipcAction },
    }));
    const projected = projectSystemErrors(events, []);
    const result = SystemErrorsResultSchema.parse({ errors: projected, partial: false });
    expect(result.errors.map((row) => row.diagnostic?.ipcAction)).toEqual(['lineLoginQr', 'lineLogout', 'getManualUnsendWindow']);
    expect(result.errors.map((row) => row.correlationId)).toEqual(['reference-0', 'reference-1', 'reference-2']);
    const unsafe = projectSystemErrors([audit({ errorCode: 'UNKNOWN', diagnostic: {
      operation: 'ipc', stage: 'execute', category: 'unknown', recovery: 'retry', ipcAction: 'PRIVATE_SENTINEL',
    } as never })], []);
    expect(JSON.stringify(unsafe)).not.toContain('PRIVATE_SENTINEL');
  });

  it('retains validated operation, stage, recovery and correlation while legacy rows remain unchanged', () => {
    const diagnostic = { operation: 'history', stage: 'read', category: 'timeout', recovery: 'retry' } as const;
    expect(projectSystemErrors([audit({ errorCode: 'HISTORY_READ_FAILED', diagnostic })], []))
      .toMatchObject([{ diagnostic, correlationId: 'private-correlation' }]);
    expect(projectSystemErrors([audit({ errorCode: 'HISTORY_READ_FAILED' })], [])[0]).not.toHaveProperty('diagnostic');
    expect(projectSystemErrors([audit({ errorCode: 'HISTORY_READ_FAILED', diagnostic: { ...diagnostic, operation: 'secret-sentinel' } as never })], [])[0])
      .not.toHaveProperty('diagnostic');
  });

  it('labels every known audit action without using the unknown-action fallback', () => {
    const rows = projectSystemActivity(AUDIT_ACTIONS.map((action) => audit({ action, phase: 'observed' })), []);
    expect(rows).toHaveLength(AUDIT_ACTIONS.length);
    expect(rows.every((row) => row.kind === 'audit' && row.action !== '系統作業')).toBe(true);
    expect(SystemActivityResultSchema.safeParse({ activity: rows, partial: false }).success).toBe(true);
  });
  it('keeps every audit error code valid in the IPC result schema', () => {
    for (let index = 0; index < AUDIT_ERROR_CODES.length; index += 100) {
      const events = AUDIT_ERROR_CODES.slice(index, index + 100).map((errorCode) => audit({ phase: 'observed', errorCode }));
      const result = { errors: projectSystemErrors(events, []), partial: false };
      expect(SystemErrorsResultSchema.safeParse(result).success).toBe(true);
    }
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
      audit({ action: 'worker_operation_error', phase: 'observed', errorCode: 'HISTORY_READ_FAILED' }),
      audit({ action: 'line_catalog_refresh', phase: 'observed', errorCode: 'CATALOG_REFRESH_FAILED' }),
      audit({ action: 'line_catalog_refresh', phase: 'observed', resultCode: 'catalog_refresh_recovered' }),
      audit({ action: 'friend_relation_initial', phase: 'observed', errorCode: 'RELATION_LIST_SHAPE_INVALID' }),
    ];
    expect(projectSystemErrors(events, [])).toEqual([
      { createdAt: events[0]!.createdAt, action: 'LINE 操作失敗', code: 'INVALID_COMMAND' },
      { createdAt: events[1]!.createdAt, action: 'LINE 操作失敗', code: 'QUEUE_FULL' },
      { createdAt: events[2]!.createdAt, action: 'LINE 操作失敗', code: 'WORKER_OPERATION_FAILED' },
      { createdAt: events[3]!.createdAt, action: 'LINE 操作失敗', code: 'HISTORY_READ_FAILED' },
      { createdAt: events[4]!.createdAt, action: 'LINE 聯絡人／群組清單更新', code: 'CATALOG_REFRESH_FAILED' },
      { createdAt: events[6]!.createdAt, action: '新增使用者：確認 LINE 好友關係', code: 'RELATION_LIST_SHAPE_INVALID' },
    ]);
    expect(projectSystemActivity([events[5]!], [])).toMatchObject([{ kind: 'audit', createdAt: events[5]!.createdAt,
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
