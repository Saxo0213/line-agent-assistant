import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  AgentRunRequestSchema,
  AccountModeSchema,
  AppSnapshotSchema,
  AgentStatusIconsSchema,
  DEFAULT_AGENT_STATUS_ICONS,
  ChatTypeSchema,
  WritableChatTypeSchema,
  ArchiveChatTypeSchema,
  ArchiveConversationKeySchema,
  NativeConversationMetadataSchema,
  ConversationKeySchema,
  InboundEnvelopeSchema,
  MessageContentSchema,
  IpcEventSchema,
  IpcRequestSchema,
  IpcResultSchema,
  MessageSearchResultSchema,
  LineAccountSummarySchema,
  WorkerCommandSchema,
  WorkerEventSchema,
  WorkerWriteAuthorizationSchema,
  LineWorkerCommandSchema,
  toJsonSafe,
} from '@line-agent/contracts';

const directEnvelope = {
  eventId: 'event-1',
  accountId: '9223372036854775807',
  chatId: 'chat-1',
  chatType: 'direct',
  senderId: 'user-1',
  messageId: 'message-1',
  kind: 'text',
  text: 'hello',
  mentionIds: [],
  mentionRanges: [],
  replyToMessageId: null,
  ingestion: { source: 'live', cursor: 'cursor-1' },
  occurredAt: '2026-10-15T00:00:00.000Z',
  attachments: [],
  raw: { id: '9223372036854775807' },
} as const;

describe('LINE envelope', () => {
  it('accepts each normalized content variant and rejects malformed values', () => {
    const values = [
      { format: 1, type: 'contact', mid: null, displayName: 'Name' },
      { format: 1, type: 'location', title: null, address: null, latitude: null, longitude: null },
      { format: 1, type: 'rich', variant: 'flex', altText: null },
      { format: 1, type: 'media', durationMs: 12 },
      { format: 1, type: 'event', nativeContentType: 6, text: null },
      { format: 1, type: 'unsent' },
      { format: 1, type: 'unsupported', nativeContentType: 42, fallbackText: null },
    ];
    for (const value of values) expect(MessageContentSchema.safeParse(value).success).toBe(true);
    expect(MessageContentSchema.safeParse({ format: 1, type: 'location', latitude: '0' }).success).toBe(false);
    expect(MessageContentSchema.safeParse({ format: 2, type: 'event', nativeContentType: 6, text: null }).success).toBe(false);
    expect(MessageContentSchema.safeParse({ format: 1, type: 'unsent', extra: true }).success).toBe(false);
    expect(MessageContentSchema.safeParse({ format: 1, type: 'event', nativeContentType: 6, text: null, call: null }).success).toBe(true);
    expect(MessageContentSchema.safeParse({ format: 1, type: 'event', nativeContentType: 6, text: null,
      call: { media: 'audio', result: 'NORMAL', durationMs: 74000 } }).success).toBe(true);
    for (const call of [{ media: null, result: 'not valid', durationMs: null }, { media: 'video', result: null, durationMs: -1 }]) {
      expect(MessageContentSchema.safeParse({ format: 1, type: 'event', nativeContentType: 6, text: null, call }).success).toBe(false);
    }
  });
  it('keeps raw, raw.native and catalog payloads out of the IPC message DTO', () => {
    const row = { accountId: 'account-A', chatType: 'group', chatId: 'chat-A', messageId: 'message-A', senderId: 'sender-A', text: null,
      occurredAt: '2026-10-17T00:00:00.000Z', kind: 'event', sticker: null, content: { format: 1, type: 'event', nativeContentType: 6, text: null } };
    const parse = (extra: Record<string, unknown>) => IpcResultSchema.safeParse({ type: 'listMessages', requestId: 'list-raw', ok: true, nextCursor: null, messages: [{ ...row, ...extra }] }).success;
    expect(parse({})).toBe(true);
    for (const leak of [{ raw: {} }, { native: {} }, { nativePayload: {} }, { catalog: [] }]) expect(parse(leak)).toBe(false);
  });
  it('accepts a direct live message with string IDs', () => {
    expect(InboundEnvelopeSchema.parse(directEnvelope).accountId).toBe('9223372036854775807');
  });

  it('accepts a group history message with verified mention ranges and attachments', () => {
    const group = {
      ...directEnvelope,
      chatType: 'group',
      text: '@Agent hello',
      mentionIds: ['agent-1'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-1' }],
      replyToMessageId: 'message-0',
      ingestion: { source: 'history', cursor: 'cursor-2' },
      attachments: [{ id: 'attachment-1', kind: 'image', name: 'photo.png', mimeType: 'image/png', sizeBytes: 12 }],
    };
    expect(InboundEnvelopeSchema.parse(group).ingestion.source).toBe('history');
  });

  it('rejects numeric external IDs and BigInt raw values', () => {
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, messageId: 42 }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, raw: { id: 42n } }).success).toBe(false);
  });

  it('rejects invalid ingestion and unverified mention ranges', () => {
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, ingestion: { source: 'other', cursor: null } }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, text: '@Agent', mentionIds: ['agent-1'], mentionRanges: [{ start: 0, end: 7, userId: 'agent-1' }] }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, text: '@Agent', mentionIds: [], mentionRanges: [{ start: 0, end: 6, userId: 'agent-1' }] }).success).toBe(false);
  });

  it('accepts only bounded contact descriptors on native contact envelopes', () => {
    const contact = { ...directEnvelope, kind: 'contact' as const, contact: { mid: 'u-target', displayName: 'Target' } };
    expect(InboundEnvelopeSchema.parse(contact).contact).toEqual({ mid: 'u-target', displayName: 'Target' });
    expect(InboundEnvelopeSchema.safeParse({ ...contact, contact: { mid: '', displayName: 'Target' } }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...contact, contact: { mid: 'u-target', displayName: 'x'.repeat(257) } }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...contact, kind: 'text', contact: { mid: 'u-target', displayName: null } }).success).toBe(false);
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, kind: 'text', contact: { mid: 'u-target', displayName: null } }).success).toBe(false);
  });
});

describe('worker protocol', () => {
  it('validates durable cursor acknowledgement', () => {
    expect(WorkerCommandSchema.parse({ type: 'ackDurableCursor', accountId: 'account-1', cursor: 'cursor-1', disposition: 'inserted' }).type).toBe('ackDurableCursor');
    expect(WorkerCommandSchema.safeParse({ type: 'ackDurableCursor', accountId: 1, cursor: 'cursor-1', disposition: 'inserted' }).success).toBe(false);
  });

  it('requires a complete attachment result', () => {
    const ready = { type: 'attachmentResult', attachmentId: '11111111-1111-4111-8111-111111111111', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', accountId: 'account-1', chatType: 'group', chatId: 'chat-1', workerInstanceId: 'worker-1', status: 'ready', relativePath: 'account/2026-10/message-1/photo.png', sha256: 'a'.repeat(64), sizeBytes: 12, name: 'photo.png' };
    expect(WorkerEventSchema.parse(ready).type).toBe('attachmentResult');
    expect(WorkerEventSchema.safeParse({ ...ready, sha256: undefined }).success).toBe(false);
    expect(WorkerEventSchema.safeParse({ ...ready, relativePath: '../outside' }).success).toBe(false);
    for (const field of ['accountId', 'chatType', 'chatId', 'workerInstanceId'] as const) {
      const incomplete = { ...ready } as Record<string, unknown>;
      delete incomplete[field];
      expect(WorkerEventSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(WorkerEventSchema.safeParse({ ...ready, attachmentId: 'external-not-internal' }).success).toBe(false);
  });

  it('validates typed errors and secret rotation', () => {
    expect(WorkerEventSchema.parse({ type: 'error', code: 'NETWORK', message: 'offline', retryable: true }).type).toBe('error');
    expect(WorkerEventSchema.safeParse({ type: 'error', message: 'offline' }).success).toBe(false);
    expect(WorkerEventSchema.parse({ type: 'secretRotation', accountId: 'account-1', workerInstanceId: 'worker-1', secrets: { token: 'token', e2eeStorage: null } }).type).toBe('secretRotation');
    expect(WorkerEventSchema.safeParse({ type: 'secretRotation', accountId: 'account-1', secrets: { token: 'token', e2eeStorage: null } }).success).toBe(false);
  });

  it('requires immutable account, conversation, worker instance, and epoch fencing on writes', () => {
    const write = { type: 'sendText', requestId: 'request-1', accountId: 'account-1', chatType: 'group', chatId: 'chat-1', workerInstanceId: 'worker-1', controlEpoch: 7, text: 'hello' };
    expect(WorkerCommandSchema.parse(write).type).toBe('sendText');
    for (const field of ['accountId', 'chatType', 'workerInstanceId', 'controlEpoch'] as const) {
      const malformed = { ...write } as Record<string, unknown>;
      delete malformed[field];
      expect(WorkerCommandSchema.safeParse(malformed).success).toBe(false);
    }
    expect(WorkerCommandSchema.safeParse({ ...write, chatType: 'channel' }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ ...write, controlEpoch: -1 }).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({ ...write, accountId: 'forged', boundAccountId: 'account-1' }).success).toBe(false);
  });

  it('rejects forged account, wrong instance, stale epoch, and non-control write authority', () => {
    const request = { accountId: 'account-1', chatType: 'direct', chatId: 'chat-1', workerInstanceId: 'worker-1', controlEpoch: 8 };
    const binding = { accountId: 'account-1', workerInstanceId: 'worker-1', controlEpoch: 8, mode: 'ACTIVE_CONTROL' };
    expect(WorkerWriteAuthorizationSchema.safeParse({ request, binding }).success).toBe(true);
    expect(WorkerWriteAuthorizationSchema.safeParse({ request: { ...request, accountId: 'forged' }, binding }).success).toBe(false);
    expect(WorkerWriteAuthorizationSchema.safeParse({ request: { ...request, workerInstanceId: 'worker-old' }, binding }).success).toBe(false);
    expect(WorkerWriteAuthorizationSchema.safeParse({ request: { ...request, controlEpoch: 7 }, binding }).success).toBe(false);
    expect(WorkerWriteAuthorizationSchema.safeParse({ request, binding: { ...binding, mode: 'MONITOR_ONLY' } }).success).toBe(false);
    expect(WorkerWriteAuthorizationSchema.safeParse({ request, binding: { ...binding, mode: 'PAUSED' } }).success).toBe(false);
  });
});

describe('agent protocol', () => {
  const baseRequest = { jobId: 'job-1', provider: 'codex', prompt: 'hello', workspacePath: 'C:\\workspace', tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false } };

  it('requires the Main-resolved tool policy', () => {
    const { tools: _tools, ...withoutTools } = baseRequest;
    expect(AgentRunRequestSchema.safeParse({ ...withoutTools, source: { type: 'ui', accountId: 'a', chatType: 'direct', chatId: 'c', requestId: 'r' } }).success).toBe(false);
  });

  it('accepts LINE and UI sources', () => {
    expect(AgentRunRequestSchema.parse({ ...baseRequest, source: { type: 'line', accountId: 'account-1', chatType: 'group', chatId: 'chat-1', messageId: 'message-1' } }).source.type).toBe('line');
    expect(AgentRunRequestSchema.parse({ ...baseRequest, provider: 'claude', resumeSessionId: 'session-1', source: { type: 'ui', requestId: 'request-1' } }).source.type).toBe('ui');
    // The shared Agent room belongs to no account: a UI source carrying one is rejected.
    expect(AgentRunRequestSchema.safeParse({ ...baseRequest, source: { type: 'ui', accountId: 'account-1', chatType: 'direct', chatId: 'chat-1', requestId: 'request-1' } }).success).toBe(false);
    expect(AgentRunRequestSchema.safeParse({ ...baseRequest, source: { type: 'line', accountId: 1, chatId: 'chat-1', messageId: 'message-1' } }).success).toBe(false);
    expect(AgentRunRequestSchema.safeParse({ ...baseRequest, source: { type: 'ui' } }).success).toBe(false);
    expect(AgentRunRequestSchema.safeParse({ ...baseRequest, source: { type: 'line', accountId: 'account-1', chatId: 'chat-1', messageId: 'message-1' } }).success).toBe(false);
  });

  it('validates event variants including reserved approval', () => {
    expect(AgentEventSchema.parse({ type: 'approval_required', approvalId: 'approval-1', summary: 'write file' }).type).toBe('approval_required');
    expect(AgentEventSchema.safeParse({ type: 'completed', finalText: 3 }).success).toBe(false);
  });
});

describe('renderer IPC', () => {
  it('validates bounded task history search requests and cursor responses', async () => {
    const { IpcResultSchema } = await import('./ipc.js');
    const request = { type: 'searchAgentJobs', requestId: 'jobs', query: { keyword: 'needle', searchPrompt: true, searchReply: false, limit: 25,
      cursor: { createdAt: '2026-10-22T00:00:00.000Z', jobId: 'job-a' } } };
    expect(IpcRequestSchema.safeParse(request).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ ...request, query: { ...request.query, limit: 101 } }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...request, query: { ...request.query, keyword: 'needle', searchPrompt: false, searchReply: false } }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'searchAgentJobs', requestId: 'jobs', ok: true, jobs: [], nextCursor: null }).success).toBe(true);
  });

  it('requires exact conversation scope for manual attachment downloads', () => {
    expect(IpcRequestSchema.safeParse({ type: 'downloadAttachment', requestId: 'download-1',
      attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'downloadAttachment', requestId: 'download-1',
      attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', accountId: 'a', chatType: 'group', chatId: 'g' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'listMessages', requestId: 'list-community', accountId: 'a', chatType: 'community', chatId: 'c', before: null, limit: 20 }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'sendText', requestId: 'send-community', accountId: 'a', chatType: 'community', chatId: 'c', text: 'blocked' }).success).toBe(false);
    // The Agent room is account-less: the LINE-chat submitPrompt is gone and the room call refuses any chat key.
    expect(IpcRequestSchema.safeParse({ type: 'submitPrompt', requestId: 'agent-community', accountId: 'a', chatType: 'thread', chatId: 't', provider: 'codex', prompt: 'blocked' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'submitAgentRoomPrompt', requestId: 'room-1', provider: 'codex', prompt: 'hi' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'submitAgentRoomPrompt', requestId: 'room-2', accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'codex', prompt: 'hi' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'stopAgentRoomJob', requestId: 'room-3', jobId: 'job-1' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'retryAgentRoomJob', requestId: 'room-4', jobId: 'job-1' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'getAgentRoomJobEvents', requestId: 'room-5', jobId: 'job-1' }).success).toBe(true);
  });

  it('removes media resolution, preview, and revocation from renderer IPC', () => {
    for (const type of ['resolveLineMedia', 'previewAttachment', 'revokeLineMedia']) {
      expect(IpcRequestSchema.safeParse({ type, requestId: 'removed', target: {} }).success).toBe(false);
    }
    for (const type of ['resolveLineMedia', 'previewAttachment', 'revokeLineMedia']) {
      expect(IpcResultSchema.safeParse({ type, requestId: 'removed', ok: true }).success).toBe(false);
    }
  });

  it('uses a dedicated list-message result while keeping search rows strict and unchanged', () => {
    const result = IpcResultSchema.safeParse({ type: 'listMessages', requestId: 'list-sticker', ok: true,
      nextCursor: null, messages: [{ accountId: 'account-A', chatType: 'group', chatId: 'chat-A', messageId: 'message-A',
        senderId: 'sender-A', text: null, occurredAt: '2026-10-17T00:00:00.000Z', kind: 'sticker',
        sticker: { stickerId: '123456', animated: true, altText: 'Hello sticker' },
        content: { format: 1, type: 'rich', variant: 'flex', altText: null } }] });
    const search = MessageSearchResultSchema.safeParse({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
      messageId: 'message-A', senderId: 'sender-A', text: null, occurredAt: '2026-10-17T00:00:00.000Z',
      kind: 'sticker', sticker: { stickerId: '123456', animated: true, altText: 'Hello sticker' } });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'listMessages') expect(result.data.messages[0]?.content).toEqual({ format: 1, type: 'rich', variant: 'flex', altText: null });
    expect(IpcResultSchema.safeParse({ type: 'listMessages', requestId: 'list-malformed', ok: true, nextCursor: null,
      messages: [{ accountId: 'account-A', chatType: 'group', chatId: 'chat-A', messageId: 'message-A', senderId: 'sender-A',
        text: null, occurredAt: '2026-10-17T00:00:00.000Z', kind: 'location', sticker: null, content: { format: 1, type: 'location', latitude: 'bad' } }] }).success).toBe(false);
    expect(search.success).toBe(false);
  });

  it('allows an unspecified archived sender in read results while requiring a live actor ID', () => {
    const archivedMessage = { accountId: 'account-A', chatType: 'community', chatId: 'chat-A', messageId: 'native-message-A',
      senderId: '', text: null, occurredAt: '2026-10-17T00:00:00.000Z' };

    expect(MessageSearchResultSchema.safeParse(archivedMessage).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'listMessages', requestId: 'empty-sender-list', ok: true,
      nextCursor: null, messages: [{ ...archivedMessage, kind: 'text', sticker: null }] }).success).toBe(true);
    expect(InboundEnvelopeSchema.safeParse({ ...directEnvelope, senderId: '' }).success).toBe(false);
  });
  it('rejects malformed and unknown requests', () => {
    expect(IpcRequestSchema.parse({ type: 'getSnapshot', requestId: 'request-1' }).type).toBe('getSnapshot');
    expect(IpcRequestSchema.safeParse({ type: 'agentRefreshStatus', requestId: 'auth-refresh', provider: 'claude' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'openAttachment', requestId: 'request-2', path: 'C:\\secret' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'unknown', requestId: 'request-3' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'submitPrompt', requestId: 'request-4', chatId: 'chat-1', provider: 'codex', prompt: 'hi', workspacePath: 'C:\\work' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'newSession', requestId: 'request-5', accountId: 'account-1', chatId: 'chat-1', provider: 'codex' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'lineLoginToken', requestId: 'request-6', token: 'secret' }).success).toBe(false);
  });

  it('bounds the conversation settings IPC payload and validates scoped Agent status events', () => {
    const settings = { attachmentAutoAttemptLimit: 10, showAgentStatusMarkers: false, agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS };
    expect(IpcRequestSchema.safeParse({ type: 'setConversationSettings', requestId: 'settings-1', settings }).success).toBe(true);
    for (const value of [2, 11, 3.5, '7']) expect(IpcRequestSchema.safeParse({ type: 'setConversationSettings', requestId: 'settings-invalid', settings: { ...settings, attachmentAutoAttemptLimit: value } }).success).toBe(false);
    for (const symbol of ['', '   ', '\n', 'x'.repeat(17)]) {
      expect(AgentStatusIconsSchema.safeParse({ ...DEFAULT_AGENT_STATUS_ICONS, running: symbol }).success).toBe(false);
    }
    expect(AgentStatusIconsSchema.safeParse({ ...DEFAULT_AGENT_STATUS_ICONS, running: '🤖' }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ type: 'agentJobStatusChanged', accountId: 'a', chatType: 'group', chatId: 'c', sourceMessageId: 'm', jobId: 'j', status: 'completed', revision: '1792180000000000' }).success).toBe(true);
  });

  it('validates typed results and snapshot health', () => {
    const snapshot = {
      control: { epoch: 1, activeAccountId: null, phase: 'idle', targetAccountId: null },
      defaultProvider: 'claude',
      components: [{ name: 'database', status: 'degraded', message: 'PostgreSQL unavailable', lastSuccessAt: null, restartCount: 0 }],
      queueDepth: 0,
      accounts: [],
      conversations: [],
      jobs: [],
      providers: [],
    };
    expect(AppSnapshotSchema.parse(snapshot).queueDepth).toBe(0);
    expect(IpcResultSchema.parse({ type: 'getSnapshot', requestId: 'request-1', ok: true, snapshot }).ok).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'getSnapshot', requestId: 'request-1', ok: true, snapshot: { queueDepth: 'zero' } }).success).toBe(false);
  });

  it('validates a scoped history completion event with its next LINE cursor', () => {
    expect(IpcEventSchema.parse({ type: 'lineHistorySynced', requestId: 'history-1', accountId: 'account-1',
      chatType: 'direct', chatId: 'u-peer', nextCursor: 'cursor-1' })).toEqual({
      type: 'lineHistorySynced', requestId: 'history-1', accountId: 'account-1', chatType: 'direct',
      chatId: 'u-peer', nextCursor: 'cursor-1',
    });
  });
});

describe('multi-account domain', () => {
  it('validates complete conversation keys and account modes', () => {
    expect(ConversationKeySchema.parse({ accountId: 'account-1', chatType: 'room', chatId: 'chat-1' })).toEqual({ accountId: 'account-1', chatType: 'room', chatId: 'chat-1' });
    expect(ConversationKeySchema.safeParse({ accountId: 'account-1', chatId: 'chat-1' }).success).toBe(false);
    expect(AccountModeSchema.options).toEqual(['ACTIVE_CONTROL', 'MONITOR_ONLY', 'PAUSED']);
  });

  it('represents source archive categories without granting community or thread write routes', () => {
    expect(ArchiveChatTypeSchema.parse('community')).toBe('community');
    expect(ArchiveChatTypeSchema.parse('thread')).toBe('thread');
    expect(ArchiveConversationKeySchema.parse({ accountId: 'account-1', chatType: 'community', chatId: 'community-1' }))
      .toEqual({ accountId: 'account-1', chatType: 'community', chatId: 'community-1' });
    expect(ArchiveConversationKeySchema.parse({ accountId: 'account-1', chatType: 'thread', chatId: 'thread-1' }))
      .toEqual({ accountId: 'account-1', chatType: 'thread', chatId: 'thread-1' });
    expect(ChatTypeSchema.parse('community')).toBe('community');
    expect(ChatTypeSchema.parse('thread')).toBe('thread');
    expect(WritableChatTypeSchema.safeParse('community').success).toBe(false);
    expect(ConversationKeySchema.parse({ accountId: 'account-1', chatType: 'thread', chatId: 'thread-1' }))
      .toEqual({ accountId: 'account-1', chatType: 'thread', chatId: 'thread-1' });
    expect(WritableChatTypeSchema.safeParse('thread').success).toBe(false);
    expect(NativeConversationMetadataSchema.parse({ midType: 7, parentChatId: 'parent-chat', communityId: 'community-id' }))
      .toEqual({ midType: 7, parentChatId: 'parent-chat', communityId: 'community-id' });
    expect(NativeConversationMetadataSchema.safeParse({ midType: 7, parentChatId: 'x'.repeat(257), communityId: null }).success).toBe(false);

    expect(WorkerCommandSchema.safeParse({ type: 'sendText', requestId: 'send-1', accountId: 'account-1',
      workerInstanceId: 'worker-1', controlEpoch: 1, chatType: 'community', chatId: 'community-1', text: 'blocked' }).success).toBe(false);
    expect(LineWorkerCommandSchema.safeParse({ type: 'sendText', requestId: 'send-2', accountId: 'account-1',
      workerInstanceId: 'worker-1', controlEpoch: 1, writeGrantVersion: 1, chatType: 'thread', chatId: 'thread-1',
      text: 'blocked', replyToMessageId: null }).success).toBe(false);
  });

  it('projects a nullable persisted product role for pending and authenticated account slots', () => {
    const account = { accountId: 'agent-slot', displayName: 'Agent', status: 'disconnected',
      lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'AGENT' };
    expect(LineAccountSummarySchema.parse(account).productRole).toBe('AGENT');
    expect(LineAccountSummarySchema.parse({ ...account, productRole: null }).productRole).toBeNull();
    expect(LineAccountSummarySchema.safeParse({ ...account, productRole: 'OWNER' }).success).toBe(false);
  });
});

describe('JSON-safe conversion', () => {
  it('converts nested BigInt values to decimal strings', () => {
    expect(toJsonSafe({ id: 9223372036854775807n, nested: [{ id: -2n }] })).toEqual({ id: '9223372036854775807', nested: [{ id: '-2' }] });
  });

  it('preserves already JSON-safe values', () => {
    const value = { text: 'hello', count: 2, ok: true, missing: null, nested: [1, 'x'] };
    expect(toJsonSafe(value)).toEqual(value);
  });
});
