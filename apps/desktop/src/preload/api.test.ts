import { describe, expect, it } from 'vitest';
import { createDesktopApi } from './api.js';

describe('sandbox preload API', () => {
  it('uses the typed locale channel and validates the returned locale snapshot', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(channel, payload) {
      calls.push({ channel, payload });
      return { preference: 'ja', effectiveLocale: 'ja' };
    }, on() {}, removeListener() {} });
    await expect(api.getLocale()).resolves.toEqual({ preference: 'ja', effectiveLocale: 'ja' });
    await expect(api.setLocale('ko')).resolves.toEqual({ preference: 'ja', effectiveLocale: 'ja' });
    expect(calls).toEqual([
      { channel: 'line-agent:locale', payload: { type: 'getLocale' } },
      { channel: 'line-agent:locale', payload: { type: 'setLocale', preference: 'ko' } },
    ]);
  });
  it('propagates a failed language save without issuing a restart request', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(channel, payload) {
      calls.push({ channel, payload });
      throw new Error('disk full');
    }, on() {}, removeListener() {} });
    await expect(api.setLocale('ko')).rejects.toThrow('disk full');
    expect(calls).toEqual([{ channel: 'line-agent:locale', payload: { type: 'setLocale', preference: 'ko' } }]);
  });
  it('sends task search through the typed request channel and validates the bounded page', async () => {
    const calls: unknown[] = [];
    const job = { jobId: 'job-a', accountId: null, chatType: null, chatId: null, provider: 'claude', prompt: 'p', status: 'completed', createdAt: '2026-10-20T10:00:00.000Z' };
    const api = createDesktopApi({ async invoke(channel, payload) {
      calls.push({ channel, payload });
      return { type: 'searchAgentJobs', requestId: (payload as { requestId: string }).requestId, ok: true, jobs: [job], nextCursor: null };
    }, on() {}, removeListener() {} });
    await expect(api.searchAgentJobs({ searchPrompt: true, searchReply: true, limit: 25 })).resolves.toEqual({ jobs: [job], nextCursor: null });
    expect(calls).toEqual([{ channel: 'line-agent:request', payload: { type: 'searchAgentJobs', requestId: expect.any(String), query: { searchPrompt: true, searchReply: true, limit: 25 } } }]);
  });

  it('carries the embedded failure code on the thrown error and validates progress events', async () => {
    const id = (payload: unknown) => (payload as { requestId: string }).requestId;
    const listeners: Array<(event: unknown, payload: unknown) => void> = [];
    const api = createDesktopApi({ async invoke(_channel, payload) {
      return { type: 'error', requestId: id(payload), ok: false, message: '下載 PostgreSQL 失敗，請檢查網路後重試。', errorCode: 'pg_download_failed' };
    }, on(_channel, callback) { listeners.push(callback); }, removeListener() {} });
    await expect(api.startEmbeddedProvision()).rejects.toMatchObject({ message: '下載 PostgreSQL 失敗，請檢查網路後重試。', errorCode: 'pg_download_failed' });
    const seen: unknown[] = [];
    api.onSetupProgress((event) => seen.push(event));
    listeners[0]!({}, { phase: 'download', receivedBytes: 1, totalBytes: 2 });
    listeners[0]!({}, { phase: 'bogus' });
    expect(seen).toEqual([{ phase: 'download', receivedBytes: 1, totalBytes: 2 }]);
  });

  it('requests a file icon by extension only', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload);
      const request = payload as { requestId: string };
      return { type: 'resolveFileTypeIcon', requestId: request.requestId, ok: true, dataUrl: 'data:image/png;base64,AA==' };
    }, on() {}, removeListener() {} });
    await expect(api.resolveFileTypeIcon('pdf')).resolves.toBe('data:image/png;base64,AA==');
    await expect(api.resolveFileTypeIcon('C:\\private\\secret.pdf')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'resolveFileTypeIcon', extension: 'pdf' });
    expect(calls[0]).not.toHaveProperty('path');
  });

  it.each([{ mode: 'never' }, { mode: 'limited', hours: 168 }] as const)('forwards $mode expiration without legacy or hidden hours and accepts nullable summaries', async (expiration) => {
    const calls: unknown[] = [];
    const token = { tokenId: '11111111-1111-4111-8111-111111111111', principalId: 'external:fixture', deviceLabel: 'Fixture',
      accountScopes: ['account-A'], toolScopes: ['list_targets'], grantVersion: 1, state: 'ACTIVE',
      expiresAt: expiration.mode === 'never' ? null : '2026-10-25T00:00:00.000Z', revokedAt: null, lastUsedAt: null,
      createdAt: '2026-10-18T00:00:00.000Z' };
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload);
      return { type: 'mcpIssueToken', requestId: (payload as { requestId: string }).requestId, ok: true,
        token, plaintextToken: 'la_mcp_' + 'A'.repeat(43) };
    }, on() {}, removeListener() {} });
    expect((await api.mcpIssueToken({ deviceLabel: 'Fixture', accountScopes: ['account-A'], toolScopes: ['list_targets'], expiration })).token.expiresAt).toBe(token.expiresAt);
    expect(calls).toEqual([{ type: 'mcpIssueToken', requestId: expect.any(String), deviceLabel: 'Fixture',
      accountScopes: ['account-A'], toolScopes: ['list_targets'], expiration }]);
  });
  it('keeps local MCP config paths and credentials out of IPC results', async () => {
    const calls: unknown[] = [];
    const status = { client: 'claude-desktop', installed: true, connected: true, tokenId: '11111111-1111-4111-8111-111111111111', accountScopes: ['account-A'] };
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload);
      const request = payload as { requestId: string; type: string };
      if (request.type === 'mcpLocalClientStatus') return { type: request.type, requestId: request.requestId, ok: true, clients: [status] };
      if (request.type === 'mcpLocalClientDisconnect') return { type: request.type, requestId: request.requestId, ok: true };
      return { type: request.type, requestId: request.requestId, ok: true, status };
    }, on() {}, removeListener() {} });
    await expect(api.mcpLocalClientStatus()).resolves.toEqual([status]);
    await expect(api.mcpLocalClientConnect('claude-desktop', ['account-A'])).resolves.toEqual(status);
    await api.mcpLocalClientDisconnect('codex');
    expect(calls).toEqual([
      { type: 'mcpLocalClientStatus', requestId: expect.any(String) },
      { type: 'mcpLocalClientConnect', client: 'claude-desktop', accountScopes: ['account-A'], requestId: expect.any(String) },
      { type: 'mcpLocalClientDisconnect', client: 'codex', requestId: expect.any(String) },
    ]);
  });
  it('preserves safe local MCP error codes for zh-TW UI handling', async () => {
    const api = createDesktopApi({ async invoke(_channel, payload) {
      return { type: 'error', requestId: (payload as { requestId: string }).requestId, ok: false,
        code: 'LOCAL_MCP_CONFIG_CONFLICT', message: 'Codex config conflict', retryable: false };
    }, on() {}, removeListener() {} });
    await expect(api.mcpLocalClientConnect('codex', ['account-A'])).rejects.toMatchObject({ name: 'LOCAL_MCP_CONFIG_CONFLICT' });
  });
  it('exposes only bounded system activity and error reads', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload);
      return (payload as { type: string }).type === 'listSystemActivity'
        ? { type: 'listSystemActivity', partial: false, activity: [] }
        : { type: 'listSystemErrors', partial: false, errors: [] };
    }, on() {}, removeListener() {} });
    await expect(api.listSystemActivity()).resolves.toEqual({ partial: false, activity: [] });
    await expect(api.listSystemErrors()).resolves.toEqual({ partial: false, errors: [] });
    expect(calls).toEqual([{ type: 'listSystemActivity' }, { type: 'listSystemErrors' }]);
  });

  it('bounds exact attachment state reads to UUID IDs and conversation scope', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(_channel, payload) { calls.push(payload); return { type: 'listAttachmentStates', attachments: [] }; }, on() {}, removeListener() {} });
    const scope = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const id = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    await expect(api.listAttachmentStates(scope, [id, id])).resolves.toEqual([]);
    expect(calls).toEqual([{ type: 'listAttachmentStates', key: scope, attachmentIds: [id] }]);
    await expect(api.listAttachmentStates(scope, Array(226).fill(id))).rejects.toThrow(/225/);
    await expect(api.listAttachmentStates(scope, ['bad-id'])).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('sends only attachment ID plus exact conversation scope for a manual download', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload); const body = payload as { requestId: string };
      return { type: 'accepted', requestId: body.requestId, ok: true };
    }, on() {}, removeListener() {} });
    await api.downloadAttachment({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, '2a653934-7064-4d90-a9f0-e6e24cf4f93d');
    expect(calls[0]).toEqual({ type: 'downloadAttachment', accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
      attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', requestId: expect.any(String) });
  });

  it('passes Agent room attachments as raw bytes and omits the field when there are none', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload); const body = payload as { requestId: string };
      return { type: 'submitAgentRoomPrompt', requestId: body.requestId, ok: true, jobId: 'job-1' };
    }, on() {}, removeListener() {} });
    const bytes = Uint8Array.from([1, 2, 3]);
    await api.submitAgentRoomPrompt({ provider: 'codex', prompt: '', attachments: [{ name: 'a.png', bytes }] });
    await api.submitAgentRoomPrompt({ provider: 'codex', prompt: 'plain', attachments: [] });
    expect(calls[0]).toEqual({ type: 'submitAgentRoomPrompt', provider: 'codex', prompt: '', attachments: [{ name: 'a.png', bytes }], requestId: expect.any(String) });
    expect((calls[0] as { attachments: { bytes: unknown }[] }).attachments[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect(calls[1]).toEqual({ type: 'submitAgentRoomPrompt', provider: 'codex', prompt: 'plain', requestId: expect.any(String) });
  });

  it('loads and saves the app-wide autoresponder settings through typed IPC', async () => {
    const calls: unknown[] = [];
    const api = createDesktopApi({
      async invoke(_channel, payload) {
        const body = payload as { requestId: string; type: string };
        calls.push(payload);
        if (body.type === 'getAutoResponderSettings') return { type: body.type, requestId: body.requestId, ok: true,
          settings: { version: 0, displayName: 'Agent', fallback: '我不知道你在說甚麼', rules: [] } };
        if (body.type === 'setAutoResponderSettings') return { type: body.type, requestId: body.requestId, ok: true, version: 1 };
        return { type: 'accepted', requestId: body.requestId, ok: true };
      }, on() {}, removeListener() {},
    });
    expect(await api.getAutoResponderSettings()).toMatchObject({ version: 0, displayName: 'Agent' });
    expect(await api.setAutoResponderSettings(0, { displayName: 'Agent', fallback: 'Unknown', rules: [] }))
      .toMatchObject({ type: 'setAutoResponderSettings', version: 1 });
    expect(calls).toMatchObject([
      { type: 'getAutoResponderSettings' },
      { type: 'setAutoResponderSettings', expectedVersion: 0, fallback: 'Unknown' },
    ]);
  });

  it('exposes only named allowlisted methods and sends no raw path to attachment open', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    const api = createDesktopApi({
      async invoke(channel, payload) { calls.push({ channel, payload }); const body = payload as { requestId: string; type: string };
        return body.type === 'openAttachment' ? { type: 'openAttachment', requestId: body.requestId, ok: true, opened: true }
          : { type: 'accepted', requestId: body.requestId, ok: true }; },
      on() {}, removeListener() {},
    });
    expect(Object.keys(api).sort()).not.toContain('onLocaleUpdated');
    await expect(api.openAttachment('C:\\secret.txt')).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await api.openAttachment('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(true);
    expect(calls[0]?.channel).toBe('line-agent:request');
    expect(calls[0]?.payload).toEqual({ type: 'openAttachment', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', requestId: expect.any(String) });
    await api.lineAddAccountQr();
    expect(calls[1]?.payload).toEqual({ type: 'lineAddAccountQr', requestId: expect.any(String) });
    await api.lineLoginQr('account-a');
    expect(calls[2]?.payload).toEqual({ type: 'lineLoginQr', accountId: 'account-a', requestId: expect.any(String) });
    await api.lineSyncHistory!({ accountId: 'account-a', chatType: 'direct', chatId: 'u-peer' }, null, 50);
    expect(calls[3]?.payload).toEqual({ type: 'lineSyncHistory', accountId: 'account-a', chatType: 'direct', chatId: 'u-peer', cursor: null, limit: 50, requestId: expect.any(String) });
    await api.agentRefreshStatus('codex');
    expect(calls[4]?.payload).toEqual({ type: 'agentRefreshStatus', provider: 'codex', requestId: expect.any(String) });
    await api.externalImportStop('account-a');
    expect(calls[5]?.payload).toEqual({ type: 'externalImportStop', accountId: 'account-a', requestId: expect.any(String) });
    await api.officialLineApproveSigner();
    expect(calls[6]?.payload).toEqual({ type: 'officialLineApproveSigner', requestId: expect.any(String) });
  });

  it('sends only approvalId and decision for an approval card, lists pending approvals, and forwards approval events', async () => {
    const calls: unknown[] = [];
    const approval = { approvalId: 'appr-1', jobId: 'job-1', tool: 'Bash', summary: 'npm test', deadline: '2026-10-21T00:00:00.000Z', canRemember: true };
    let listener: ((_event: unknown, payload: unknown) => void) | undefined;
    const api = createDesktopApi({ async invoke(_channel, payload) {
      calls.push(payload);
      const request = payload as { requestId: string; type: string };
      if (request.type === 'listPendingAgentApprovals') return { type: request.type, requestId: request.requestId, ok: true, approvals: [approval] };
      return { type: 'error', requestId: request.requestId, ok: false, code: 'APPROVAL_NOT_PENDING', message: 'gone', retryable: false };
    }, on(_channel, callback) { listener = callback; }, removeListener() {} });
    await expect(api.decideAgentApproval!('appr-1', 'always')).resolves.toMatchObject({ type: 'error', code: 'APPROVAL_NOT_PENDING' });
    await expect(api.listPendingAgentApprovals!()).resolves.toEqual([approval]);
    await expect(api.decideAgentApproval!('appr-1', 'forever' as never)).rejects.toThrow();
    expect(calls).toEqual([
      { type: 'decideAgentApproval', approvalId: 'appr-1', decision: 'always', requestId: expect.any(String) },
      { type: 'listPendingAgentApprovals', requestId: expect.any(String) },
    ]);
    const events: unknown[] = [];
    api.onEvent((event) => events.push(event));
    listener?.(null, { type: 'agentApprovalRequested', approval });
    listener?.(null, { type: 'agentApprovalResolved', approvalId: 'appr-1', jobId: 'job-1', outcome: 'timeout' });
    listener?.(null, { type: 'agentExecutionPolicyChanged' });
    listener?.(null, { type: 'agentApprovalRequested', approval: { ...approval, deadline: 'soon' } });
    expect(events.map((event) => (event as { type: string }).type)).toEqual(['agentApprovalRequested', 'agentApprovalResolved', 'agentExecutionPolicyChanged']);
  });

  it('opens a message URL through the typed request channel', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    const api = createDesktopApi({ async invoke(channel, payload) {
      calls.push({ channel, payload });
      const body = payload as { requestId: string };
      return { type: 'openExternalUrl', requestId: body.requestId, ok: true };
    }, on() {}, removeListener() {} });
    await expect(api.openExternalUrl('https://example.com')).resolves.toMatchObject({ type: 'openExternalUrl', ok: true });
    expect(calls).toEqual([{ channel: 'line-agent:request', payload: {
      type: 'openExternalUrl', url: 'https://example.com', requestId: expect.any(String),
    } }]);
  });

  it('forwards account scope through the existing message search request', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    const api = createDesktopApi({
      async invoke(channel, payload) {
        calls.push({ channel, payload });
        const body = payload as { requestId: string };
        return { type: 'searchMessages', requestId: body.requestId, ok: true, messages: [] };
      },
      on() {}, removeListener() {},
    });

    await api.searchMessages({ accountId: 'account-A', text: 'older', limit: 100 });

    expect(calls[0]?.channel).toBe('line-agent:request');
    expect(calls[0]?.payload).toEqual({ type: 'searchMessages', query: { accountId: 'account-A', text: 'older', limit: 100 }, requestId: expect.any(String) });
  });

  it('preserves search ownership through the contract parser, including older payloads', async () => {
    const base = { accountId: 'account-A', chatType: 'community', chatId: 'chat', messageId: 'own', senderId: 'native-self',
      senderName: null, text: 'original', occurredAt: '2026-10-23T10:00:00.000Z' };
    const messages = [{ ...base, isOwn: true }, { ...base, messageId: 'peer', isOwn: false }, { ...base, messageId: 'legacy' }];
    const api = createDesktopApi({
      async invoke(_channel, payload) { return { type: 'searchMessages', requestId: (payload as { requestId: string }).requestId, ok: true, messages }; },
      on() {}, removeListener() {},
    });
    expect(await api.searchMessages({ limit: 100 })).toEqual(messages);
  });

  it('preserves the explicit uncertain manual-send classification', async () => {
    const api = createDesktopApi({ async invoke(_channel, payload) {
      const request = payload as { requestId: string };
      return { type: 'error', requestId: request.requestId, ok: false, code: 'LINE_SEND_OUTCOME_UNKNOWN', message: 'unknown', retryable: false };
    }, on() {}, removeListener() {} });
    await expect(api.sendText({ accountId: 'a', chatType: 'group', chatId: 'c' }, 'hello'))
      .resolves.toMatchObject({ ok: false, code: 'LINE_SEND_OUTCOME_UNKNOWN' });
  });

  it('rejects malformed send responses and correlation mismatches for conservative renderer handling', async () => {
    const malformed = createDesktopApi({ async invoke() { return { type: 'accepted', ok: true }; }, on() {}, removeListener() {} });
    await expect(malformed.sendText({ accountId: 'a', chatType: 'group', chatId: 'c' }, 'hello')).rejects.toThrow();
    const mismatched = createDesktopApi({ async invoke() { return { type: 'accepted', requestId: 'wrong', ok: true }; }, on() {}, removeListener() {} });
    await expect(mismatched.sendText({ accountId: 'a', chatType: 'group', chatId: 'c' }, 'hello')).rejects.toThrow('IPC correlation mismatch');
  });
});
