import { describe, expect, it } from 'vitest';
import { AppSnapshotSchema, IpcEventSchema, IpcRequestSchema, IpcResultSchema } from './index.js';

describe('Task 5 IPC authority contract', () => {
  it('requires control epoch and phase in authoritative snapshots', () => {
    const base = { defaultProvider: 'claude', components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [],
      control: { epoch: 7, activeAccountId: 'a', phase: 'revoking', targetAccountId: 'b' } };
    expect(AppSnapshotSchema.safeParse(base).success).toBe(true);
    expect(AppSnapshotSchema.safeParse({ ...base, control: undefined }).success).toBe(false);
  });
  it('accepts the optional official-logout confirmation on login requests and the typed blocked result', () => {
    for (const request of [{ type: 'lineLoginQr', accountId: 'a' }, { type: 'lineStart', accountId: 'a' }, { type: 'lineAddAccountQr' }]) {
      expect(IpcRequestSchema.safeParse({ requestId: 'r', ...request }).success).toBe(true);
      expect(IpcRequestSchema.safeParse({ requestId: 'r', ...request, confirmOfficialLogout: true }).success).toBe(true);
      expect(IpcRequestSchema.safeParse({ requestId: 'r', ...request, confirmOfficialLogout: 'yes' }).success).toBe(false);
    }
    const blocked = { type: 'error', requestId: 'r', ok: false, code: 'OFFICIAL_LINE_SESSION_ACTIVE', message: 'm', retryable: false };
    expect(IpcResultSchema.safeParse({ ...blocked, detail: 'same_account' }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ ...blocked, detail: 'other' }).success).toBe(false);
  });
  it('rejects public control switching and renderer workspace paths', () => {
    expect(IpcRequestSchema.safeParse({ type: 'switchControl', requestId: 'r', accountId: 'b', expectedEpoch: 7 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'activateControl', requestId: 'r', accountId: 'b', expectedEpoch: 7 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'submitAgentRoomPrompt', requestId: 'r', provider: 'codex', prompt: 'hi', workspacePath: 'C:\\evil' }).success).toBe(false);
  });
  it('supports paged messages, attachments, filtered search and typed events', () => {
    const key = { accountId: 'a', chatType: 'group', chatId: 'g' };
    expect(IpcRequestSchema.safeParse({ type: 'listMessages', requestId: 'r', ...key, before: null, limit: 50 }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'listAttachments', requestId: 'r', ...key, before: null, limit: 50 }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'searchMessages', requestId: 'r', query: { accountId: 'a', hasAttachment: true, from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z', limit: 50 } }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'revealAttachment', requestId: 'r', attachmentId: 'id' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'previewAttachment', requestId: 'r', ...key, attachmentId: 'id' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'agentRefreshStatus', requestId: 'auth-refresh', provider: 'codex' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'subscribeEvents', requestId: 'r', topics: ['snapshot', 'agentEvent'] }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ type: 'controlChanged', control: { epoch: 8, activeAccountId: 'b', phase: 'idle', targetAccountId: null } }).success).toBe(true);
  });
  it('provides versioned app-wide autoresponder configuration requests', () => {
    expect(IpcRequestSchema.safeParse({ type: 'getAutoResponderSettings', requestId: 'get-rules' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'setAutoResponderSettings', requestId: 'save-rules',
      expectedVersion: 4, displayName: 'Agent', fallback: '我不知道你在說甚麼',
      rules: [{ trigger: 'hello', reply: 'Hi' }] }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'setAutoResponderSettings', requestId: 'bad-rules',
      expectedVersion: 4, displayName: 'Agent', fallback: 'fallback', rules: [{ trigger: 'x', reply: 'y' }],
      accountOverride: 'other-account' }).success).toBe(false);
  });
  it('accepts an explicit account-scoped external monitor stop request and a payload-free signer approval', () => {
    expect(IpcRequestSchema.safeParse({ type: 'externalImportStop', requestId: 'stop-monitor', accountId: 'account-a' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'officialLineApproveSigner', requestId: 'approve-signer' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'officialLineApproveSigner', requestId: 'approve-signer', thumbprint: 'A'.repeat(40) }).success).toBe(false);
  });
  it('bounds external browser URL requests and defines their success result', () => {
    expect(IpcRequestSchema.safeParse({ type: 'openExternalUrl', requestId: 'open-link', url: 'https://example.com' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'openExternalUrl', requestId: 'long-link', url: 'https://example.com/' + 'a'.repeat(8192) }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'openExternalUrl', requestId: 'open-link', ok: true }).success).toBe(true);
  });
  it('carries the affected conversation preview in a message event', () => {
    const conversation = { accountId: 'a', chatType: 'group', chatId: 'g', title: '工程群組', agentEnabled: false,
      defaultProvider: 'codex', unreadCount: 1, latestMessagePreview: '圖面.pdf',
      latestMessageAt: '2026-10-16T00:00:00.000Z', latestAttachmentStatus: 'ready' } as const;
    expect(IpcEventSchema.parse({ type: 'messageStored', key: { accountId: 'a', chatType: 'group', chatId: 'g' },
      messageId: 'm1', conversation })).toMatchObject({ conversation });
  });
  it('separates new-account QR login from existing-account relogin and accepts only local QR images', () => {
    expect(IpcRequestSchema.safeParse({ type: 'lineAddAccountQr', requestId: 'add' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineLoginQr', requestId: 'login', accountId: 'account-a' }).success).toBe(true);
    const base = { type: 'lineQr', accountId: 'account-a', loginAttemptId: 'attempt-a' } as const;
    expect(IpcEventSchema.safeParse({ ...base, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ ...base, imageDataUrl: 'https://example.test/qr.png' }).success).toBe(false);
    expect(IpcEventSchema.safeParse({ ...base, imageDataUrl: `data:image/png;base64,${'A'.repeat(300_000)}` }).success).toBe(false);
  });
});
