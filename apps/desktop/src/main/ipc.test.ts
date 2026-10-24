import { describe, expect, it, vi } from 'vitest';
import { createIpcAdapter, createReadAdapter } from './ipc.js';

const snapshot = { control: { epoch: 0, activeAccountId: null, phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const, components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] };

describe('renderer IPC boundary', () => {
  it('records a no-payload renderer fault even before a connected service exists', async () => {
    const onDiagnostic = vi.fn();
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', onDiagnostic });
    expect(await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'reportRendererFailure', requestId: 'render-1' }))
      .toMatchObject({ type: 'accepted', ok: true });
    expect(onDiagnostic).toHaveBeenCalledWith({ operation: 'renderer', stage: 'execute', category: 'unknown', recovery: 'reopen_app' }, { requestId: 'render-1' });
    expect(await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'reportRendererFailure', requestId: 'render-2', error: 'private-sentinel' }))
      .toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('records a safe read failure and contains arbitrary service exception text', async () => {
    const onDiagnostic = vi.fn();
    const adapter = createReadAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', onDiagnostic,
      service: { listWorkRecords: async () => { throw new Error('private-token-path-sentinel'); } } as never });
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listWorkRecords' }))
      .rejects.toThrow('Service read failed. See System Errors for diagnostic details.');
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'ipc', stage: 'read', category: 'unknown' }), { correlationId: expect.any(String) });
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listWorkRecords' })).rejects.toThrow('Service read failed.');
    expect(onDiagnostic.mock.calls[0]?.[1].correlationId).not.toBe(onDiagnostic.mock.calls[1]?.[1].correlationId);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private-token-path-sentinel');
  });

  it('rejects generic issuance for reserved local-client principals', async () => {
    const dispatch = vi.fn(async () => ({ type: 'error' as const, requestId: 'local', ok: false as const, code: 'unexpected', message: 'unexpected', retryable: false }));
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: { dispatch } });
    const result = await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'mcpIssueToken', requestId: 'local', deviceLabel: 'x', principalId: 'local-client:codex', accountScopes: ['account-a'], toolScopes: ['list_targets'], expiration: { mode: 'never' } });
    expect(result).toMatchObject({ type: 'error', code: 'LOCAL_CLIENT_PRINCIPAL_RESERVED' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects a request from another webContents or origin', async () => {
    const adapter = createIpcAdapter({
      webContentsId: 7,
      rendererUrl: 'file:///app/index.html',
      service: { dispatch: async () => ({ type: 'getSnapshot', requestId: 'r1', ok: true, snapshot }) },
    });
    const request = { type: 'getSnapshot', requestId: 'r1' };
    expect((await adapter({ senderId: 8, url: 'file:///app/index.html' }, request)).ok).toBe(false);
    expect((await adapter({ senderId: 7, url: 'https://evil.example' }, request)).ok).toBe(false);
  });

  it('rejects malformed input and invalid service output', async () => {
    const adapter = createIpcAdapter({
      webContentsId: 7,
      rendererUrl: 'file:///app/index.html',
      service: { dispatch: async () => ({ type: 'getSnapshot', requestId: 'wrong', ok: true, snapshot }) },
    });
    expect((await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'sendText', requestId: 'r1', text: 'hello' })).ok).toBe(false);
    expect((await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'getSnapshot', requestId: 'r1' })).ok).toBe(false);
  });

  it('accepts the dedicated administrator-pairing response for its request', async () => {
    const adapter = createIpcAdapter({
      webContentsId: 7,
      rendererUrl: 'file:///app/index.html',
      service: { dispatch: async (request) => ({
        type: 'lineAdminPairing', requestId: request.requestId, ok: true,
        token: '123456', expiresAt: '2026-10-16T06:00:00.000Z',
      }) },
    });

    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, {
      type: 'lineBeginAdminPairing', requestId: 'pair-1', accountId: 'account-a',
    })).resolves.toMatchObject({ type: 'lineAdminPairing', ok: true, token: '123456' });
  });

  it('resolves extension icons only through the trusted renderer identity and extension request', async () => {
    const resolveFileTypeIcon = vi.fn(async (extension: string) => extension === 'pdf' ? 'data:image/png;base64,AA==' : null);
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html',
      resolveFileTypeIcon, service: { dispatch: async () => { throw new Error('icon request must not dispatch'); } } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    await expect(adapter(sender, { type: 'resolveFileTypeIcon', requestId: 'icon-1', extension: 'pdf' }))
      .resolves.toEqual({ type: 'resolveFileTypeIcon', requestId: 'icon-1', ok: true, dataUrl: 'data:image/png;base64,AA==' });
    expect((await adapter({ ...sender, senderId: 8 }, { type: 'resolveFileTypeIcon', requestId: 'icon-2', extension: 'pdf' })).ok).toBe(false);
    expect((await adapter(sender, { type: 'resolveFileTypeIcon', requestId: 'icon-3', extension: 'C:\\secret' })).ok).toBe(false);
    expect(resolveFileTypeIcon).toHaveBeenCalledTimes(1);
    expect(resolveFileTypeIcon).toHaveBeenCalledWith('pdf');
  });

  it('accepts only an attachment UUID and delegates authoritative open', async () => {
    const seen: unknown[] = [];
    const adapter = createIpcAdapter({
      webContentsId: 7,
      rendererUrl: 'file:///app/index.html',
      service: { dispatch: async () => { throw new Error('attachment must not use generic dispatch'); }, openAttachment: async (id, senderId) => { seen.push([id, senderId]); return true; } },
    });
    const event = { senderId: 7, url: 'file:///app/index.html' };
    expect((await adapter(event, { type: 'openAttachment', requestId: 'r1', attachmentId: 'C:\\secret.txt' })).ok).toBe(false);
    expect((await adapter(event, { type: 'openAttachment', requestId: 'r2', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d' })).ok).toBe(true);
    expect(seen).toEqual([['2a653934-7064-4d90-a9f0-e6e24cf4f93d', 7]]);
  });

  it('opens only canonical HTTP(S) URLs for the trusted sender without requiring LINE service', async () => {
    const openExternalUrl = vi.fn(async (_url: string) => undefined);
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', openExternalUrl });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const request = (url: string) => ({ type: 'openExternalUrl', requestId: 'link-1', url });

    await expect(adapter(sender, request('https://Example.com/a path'))).resolves.toEqual({
      type: 'openExternalUrl', requestId: 'link-1', ok: true,
    });
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a%20path');
    for (const url of ['http://example.com', 'https://example.com']) {
      expect((await adapter(sender, request(url))).ok).toBe(true);
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'custom://example.com', 'https://user:pass@example.com', 'https://example.com\n.evil', 'https://example.com/' + 'a'.repeat(8192)]) {
      expect((await adapter(sender, request(url))).ok).toBe(false);
    }
    expect((await adapter({ ...sender, senderId: 8 }, request('https://example.com'))).ok).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledTimes(3);
  });

  it('returns an IPC error when opening an external URL fails', async () => {
    const openExternalUrl = vi.fn(async () => { throw new Error('browser unavailable'); });
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', openExternalUrl });
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, {
      type: 'openExternalUrl', requestId: 'link-fail', url: 'https://example.com',
    })).resolves.toMatchObject({ type: 'error', requestId: 'link-fail', ok: false });
  });

  it('records unexpected chat resource failures while returning a service error', async () => {
    const onDiagnostic = vi.fn();
    let cancellingStarted!: () => void;
    const started = new Promise<void>((resolve) => { cancellingStarted = resolve; });
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', onDiagnostic,
      service: { dispatch: async (request, signal) => {
        if (request.requestId === 'album-cancelled') return await new Promise<never>((_resolve, reject) => {
          cancellingStarted();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        if (request.requestId === 'album-failure-after-cancel') return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('independent worker failure')), { once: true });
        });
        throw new Error('unexpected resource failure');
      } } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const cancelled = adapter(sender, { type: 'openChatAlbum', requestId: 'album-cancelled', accountId: 'account-a',
      chatType: 'group', chatId: 'chat-a', albumId: 'album-a' });
    await started;
    await expect(adapter(sender, { type: 'cancelChatResourceRequest', requestId: 'album-cancel', targetRequestId: 'album-cancelled' }))
      .resolves.toMatchObject({ ok: true, cancelled: true });
    await expect(cancelled).resolves.toMatchObject({ type: 'error', code: 'CANCELLED' });
    expect(onDiagnostic).not.toHaveBeenCalled();

    const failedAfterCancel = adapter(sender, { type: 'openChatAlbum', requestId: 'album-failure-after-cancel', accountId: 'account-a',
      chatType: 'group', chatId: 'chat-a', albumId: 'album-a' });
    await expect(adapter(sender, { type: 'cancelChatResourceRequest', requestId: 'album-cancel-2', targetRequestId: 'album-failure-after-cancel' }))
      .resolves.toMatchObject({ ok: true, cancelled: true });
    await expect(failedAfterCancel).resolves.toMatchObject({ type: 'error', code: 'SERVICE_UNAVAILABLE' });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'ipc', stage: 'execute', category: 'unknown' }),
      { requestId: 'album-failure-after-cancel', accountId: 'account-a' });

    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'openChatAlbum', requestId: 'album-failure',
      accountId: 'account-a', chatType: 'group', chatId: 'chat-a', albumId: 'album-a' }))
      .resolves.toMatchObject({ type: 'error', code: 'SERVICE_UNAVAILABLE' });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'ipc', stage: 'execute', category: 'unknown' }),
      { requestId: 'album-failure', accountId: 'account-a' });
  });

  it('delegates manual attachment downloads with the complete conversation scope', async () => {
    const seen: unknown[] = [];
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      dispatch: async () => { throw new Error('manual attachment must use the scoped attachment service'); },
      async downloadAttachment(key, attachmentId) { seen.push([key, attachmentId]); return true; },
    } });
    const event = { senderId: 7, url: 'file:///app/index.html' };
    const response = await adapter(event, { type: 'downloadAttachment', requestId: 'download-1',
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d' });
    expect(response).toMatchObject({ type: 'accepted', ok: true });
    expect(seen).toEqual([[{ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, '2a653934-7064-4d90-a9f0-e6e24cf4f93d']]);
  });

  it('rejects a renderer supplied Agent workspace and delegates only the trusted contract', async () => {
    let delegated = false;
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      dispatch: async (request) => { delegated = true; return { type: 'submitAgentRoomPrompt', requestId: request.requestId, ok: true, jobId: 'job' }; },
      openAttachment: async () => false,
    } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    expect((await adapter(sender, { type: 'submitAgentRoomPrompt', requestId: 'r1', provider: 'codex', prompt: 'hi', workspacePath: 'C:\\attacker' })).ok).toBe(false);
    expect(delegated).toBe(false);
    expect((await adapter(sender, { type: 'submitAgentRoomPrompt', requestId: 'r2', provider: 'codex', prompt: 'hi' })).ok).toBe(true);
    expect(delegated).toBe(true);
  });

  it('resolves the current facade for every renderer request', async () => {
    const makeFacade = () => ({ dispatch: async (request: { requestId: string }) => ({ type: 'getSnapshot' as const,
      requestId: request.requestId, ok: true as const, snapshot }) });
    let current = makeFacade();
    const firstFacade = current;
    let firstCalls = 0;
    firstFacade.dispatch = async (request) => { firstCalls++; return { type: 'getSnapshot', requestId: request.requestId, ok: true, snapshot }; };
    const secondFacade = makeFacade();
    let secondCalls = 0;
    secondFacade.dispatch = async (request) => { secondCalls++; return { type: 'getSnapshot', requestId: request.requestId, ok: true, snapshot }; };
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', resolveService: () => current });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    await adapter(sender, { type: 'getSnapshot', requestId: 'before' });
    current = secondFacade;
    await adapter(sender, { type: 'getSnapshot', requestId: 'after' });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it('cancels only an active resource request from the same renderer sender and forgets it after settlement', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let activeSignal: AbortSignal | undefined;
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      dispatch: async (request, signal) => {
        activeSignal = signal; entered();
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { type: 'error', requestId: request.requestId, ok: false, code: 'CANCELLED', message: 'cancelled', retryable: false };
      },
    } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const pending = adapter(sender, { type: 'listChatNotes', requestId: 'read-1', accountId: 'a', chatType: 'group', chatId: 'c', cursor: null });
    await started;
    expect(activeSignal?.aborted).toBe(false);
    await expect(adapter(sender, { type: 'cancelChatResourceRequest', requestId: 'cancel-1', targetRequestId: 'read-1' }))
      .resolves.toMatchObject({ type: 'cancelChatResourceRequest', cancelled: true });
    expect(activeSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ type: 'error', requestId: 'read-1' });
    await expect(adapter(sender, { type: 'cancelChatResourceRequest', requestId: 'cancel-2', targetRequestId: 'read-1' }))
      .resolves.toMatchObject({ type: 'cancelChatResourceRequest', cancelled: false });
    await expect(adapter({ ...sender, senderId: 8 }, { type: 'cancelChatResourceRequest', requestId: 'cancel-3', targetRequestId: 'read-1' }))
      .resolves.toMatchObject({ type: 'error', code: 'UNTRUSTED_SENDER' });
  });
});

describe('desktop read boundary', () => {
  it('serves bounded system activity and error reads through the trusted renderer boundary', async () => {
    const calls: string[] = [];
    const adapter = createReadAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      listMessages: async () => ({ messages: [], olderCursor: null }), listAttachmentStates: async () => [], listAgentStatuses: async () => [], listWorkRecords: async () => [],
      listSystemActivity: async () => { calls.push('activity'); return { activity: [], partial: false }; },
      listSystemErrors: async () => { calls.push('errors'); return { errors: [], partial: true }; },
      controlState: async () => ({ activeAccountId: null, epoch: 0, pendingOutbound: 0 }),
    } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    await expect(adapter(sender, { type: 'listSystemActivity' })).resolves.toEqual({ type: 'listSystemActivity', activity: [], partial: false });
    await expect(adapter(sender, { type: 'listSystemErrors' })).resolves.toEqual({ type: 'listSystemErrors', errors: [], partial: true });
    await expect(adapter(sender, { type: 'listSystemActivity', path: 'C:\\secret' })).rejects.toThrow();
    expect(calls).toEqual(['activity', 'errors']);
  });

  it('serves the friend list for one account through the trusted renderer boundary', async () => {
    const asked: string[] = [];
    const adapter = createReadAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      listMessages: async () => ({ messages: [], olderCursor: null }), listAttachmentStates: async () => [], listAgentStatuses: async () => [], listWorkRecords: async () => [],
      listFriends: async (accountId) => { asked.push(accountId); return [{ mid: 'u1', name: 'Amy', avatarAvailable: false, hasConversation: false }]; },
      controlState: async () => ({ activeAccountId: null, epoch: 0, pendingOutbound: 0 }),
    } });
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listFriends', accountId: 'A' }))
      .resolves.toEqual({ type: 'listFriends', friends: [{ mid: 'u1', name: 'Amy', avatarAvailable: false, hasConversation: false }] });
    await expect(adapter({ senderId: 8, url: 'file:///app/index.html' }, { type: 'listFriends', accountId: 'A' })).rejects.toThrow();
    expect(asked).toEqual(['A']);
  });

  it('validates sender and clamps paginated messages to contract size', async () => {
    const lookups: unknown[] = [];
    const adapter = createReadAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service: {
      listMessages: async () => ({ messages: [], olderCursor: null }), listAttachmentStates: async (key, ids) => { lookups.push({ key, ids }); return []; }, listAgentStatuses: async () => [], listWorkRecords: async () => [], controlState: async () => ({ activeAccountId: null, epoch: 0, pendingOutbound: 0 }),
    } });
    await expect(adapter({ senderId: 8, url: 'file:///app/index.html' }, { type: 'listWorkRecords' })).rejects.toThrow();
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listMessages', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, cursor: null, limit: 1000 })).rejects.toThrow();
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listMessages', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, cursor: null, limit: 75 })).resolves.toEqual({ type: 'listMessages', page: { messages: [], olderCursor: null } });
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listAgentStatuses', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, messageIds: Array(226).fill('m') })).rejects.toThrow();
    const id = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listAttachmentStates', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, attachmentIds: [id] }))
      .resolves.toEqual({ type: 'listAttachmentStates', attachments: [] });
    expect(lookups).toEqual([{ key: { accountId: 'A', chatType: 'group', chatId: 'C' }, ids: [id] }]);
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listAttachmentStates', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, attachmentIds: Array(226).fill(id) })).rejects.toThrow();
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listAttachmentStates', key: { accountId: 'A', chatType: 'group', chatId: 'C' }, attachmentIds: ['not-a-uuid'] })).rejects.toThrow();
  });

  it('resolves the current facade for every renderer read', async () => {
    const makeFacade = () => ({ listMessages: async () => ({ messages: [], olderCursor: null }), listAttachmentStates: async () => [], listAgentStatuses: async () => [],
      listWorkRecords: async () => [], controlState: async () => ({ activeAccountId: null, epoch: 0, pendingOutbound: 0 }) });
    let current = makeFacade();
    let firstCalls = 0;
    current.controlState = async () => { firstCalls++; return { activeAccountId: null, epoch: 0, pendingOutbound: 0 }; };
    const first = current;
    const second = makeFacade();
    let secondCalls = 0;
    second.controlState = async () => { secondCalls++; return { activeAccountId: null, epoch: 0, pendingOutbound: 0 }; };
    const adapter = createReadAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', resolveService: () => current });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    await adapter(sender, { type: 'getControlState' });
    current = second;
    await adapter(sender, { type: 'getControlState' });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
});
