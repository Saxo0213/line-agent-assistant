import { describe, expect, it } from 'vitest';
import {
  IpcRequestSchema,
  IpcResultSchema,
  McpMessageRecordSchema,
  decodeMcpMessageCursor,
  encodeMcpMessageCursor,
  McpServerStatusSchema,
  McpTargetSummarySchema,
  McpToolInputUnionSchema,
  McpToolNameSchema,
  McpToolOutputUnionSchema,
  MCP_TOOL_EFFECTS,
  MCP_TOOL_NAMES,
  MCP_TOOL_PERMISSIONS,
  McpMessageKindSchema,
  normalizeMcpTimeBound,
} from './index.js';

describe('MCP contracts and IPC schemas', () => {
  it('has no MCP token request or result schema', () => {
    for (const payload of [
      { type: 'mcpIssueToken', requestId: 'r-1', deviceLabel: 'External', accountScopes: ['account-a'], toolScopes: ['list_targets'], expiration: { mode: 'never' } },
      { type: 'mcpListTokens', requestId: 'r-2' },
      { type: 'mcpRevokeToken', requestId: 'r-3', tokenId: '11111111-1111-4111-8111-111111111111' },
    ]) expect(IpcRequestSchema.safeParse(payload).success).toBe(false);
    for (const payload of [
      { type: 'mcpIssueToken', requestId: 'r-1', ok: true },
      { type: 'mcpListTokens', requestId: 'r-2', ok: true, tokens: [] },
      { type: 'mcpRevokeToken', requestId: 'r-3', ok: true, revoked: true },
    ]) expect(IpcResultSchema.safeParse(payload).success).toBe(false);
  });
  it('validates Phase 1 read-only MCP tool names', () => {
    expect(McpToolNameSchema.options).toEqual([
      'list_targets',
      'query_target_messages',
      'query_target_messages_by_time',
      'list_active_chats',
      'list_chat_notes', 'get_chat_note', 'list_chat_albums', 'get_chat_album',
    ]);
    expect(McpToolNameSchema.safeParse('send_text').success).toBe(false);
  });
  it('classifies every MCP tool as read or effect', () => {
    expect(Object.keys(MCP_TOOL_EFFECTS).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of MCP_TOOL_NAMES) expect(MCP_TOOL_EFFECTS[tool]).toBe('read');
  });

  it('clamps message query limits above 200 and validates paging cursors', () => {
    const base = { accountId: 'acc', chatType: 'group' as const, chatId: 'chat' };
    const byTime = { ...base, from: '2026-10-28' };
    for (const [name, args] of [['query_target_messages', base], ['query_target_messages_by_time', byTime]] as const) {
      const big = McpToolInputUnionSchema.parse({ name, arguments: { ...args, limit: 500 } });
      expect((big.arguments as { limit?: number }).limit).toBe(200);
      expect((McpToolInputUnionSchema.parse({ name, arguments: { ...args, limit: 50 } }).arguments as { limit?: number }).limit).toBe(50);
      expect((McpToolInputUnionSchema.parse({ name, arguments: args }).arguments as { limit?: number }).limit).toBeUndefined();
      expect(McpToolInputUnionSchema.safeParse({ name, arguments: { ...args, limit: 0 } }).success).toBe(false);
      const good = encodeMcpMessageCursor({ occurredAt: '2026-10-28T01:02:03.123456Z', messageId: 'm-1', queryHash: '0123456789abcdef' });
      expect(McpToolInputUnionSchema.safeParse({ name, arguments: { ...args, cursor: good } }).success).toBe(true);
      for (const cursor of ['', 'not a cursor', 'e30', good + 'A', btoa('{"t":"x","i":"m","h":"0123456789abcdef"}')]) {
        expect(McpToolInputUnionSchema.safeParse({ name, arguments: { ...args, cursor } }).success).toBe(false);
      }
    }
    const cursor = { occurredAt: '2026-10-28T01:02:03.123456Z', messageId: 'm-1', queryHash: '0123456789abcdef' };
    expect(decodeMcpMessageCursor(encodeMcpMessageCursor(cursor))).toEqual(cursor);
    expect(decodeMcpMessageCursor(encodeMcpMessageCursor({ ...cursor, queryHash: 'XYZ' }))).toBeNull();
    expect(decodeMcpMessageCursor(encodeMcpMessageCursor({ ...cursor, occurredAt: '2026-02-31T00:00:00.000000Z' }))).toBeNull();
  });

  it('requires explicit account and stable conversation selectors for archived Note and Album tools', () => {
    for (const name of ['list_chat_notes', 'list_chat_albums'] as const) {
      expect(McpToolInputUnionSchema.safeParse({ name, arguments: { accountId: 'acc', chatType: 'group', chatId: 'chat', limit: 50 } }).success).toBe(true);
      expect(McpToolInputUnionSchema.safeParse({ name, arguments: { chatType: 'group', chatId: 'chat' } }).success).toBe(false);
      expect(McpToolInputUnionSchema.safeParse({ name, arguments: { accountId: 'acc', chatType: 'group', chatId: 'chat', limit: 51 } }).success).toBe(false);
    }
    expect(McpToolInputUnionSchema.safeParse({ name: 'get_chat_note', arguments: { accountId: 'acc', chatType: 'group', chatId: 'chat', noteId: 'post-1' } }).success).toBe(true);
    expect(McpToolInputUnionSchema.safeParse({ name: 'get_chat_album', arguments: { accountId: 'acc', chatType: 'group', chatId: 'chat', albumId: 'album-1' } }).success).toBe(true);
    expect(McpToolInputUnionSchema.safeParse({ name: 'list_chat_albums', arguments: { accountId: 'acc', chatType: 'community', chatId: 'chat' } }).success).toBe(false);
  });

  it('validates the MCP server status schema', () => {
    const status = {
      running: true,
      endpoint: 'http://127.0.0.1:38471/mcp',
      host: '127.0.0.1' as const,
      port: 38471,
      inFlightRequests: 0,
      maxConcurrentRequests: 8,
    };
    expect(McpServerStatusSchema.parse(status).host).toBe('127.0.0.1');
    expect(McpServerStatusSchema.safeParse({ ...status, host: '0.0.0.0' }).success).toBe(false);
    expect(McpServerStatusSchema.safeParse({ ...status, activeTokenCount: 2 }).success).toBe(false);
  });

  it('requires at least one target selector for query_target_messages', () => {
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages',
        arguments: { accountId: 'account-a', limit: 20 },
      }).success,
    ).toBe(false);

    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages',
        arguments: { target: 'Alice', limit: 20 },
      }).success,
    ).toBe(true);

    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages',
        arguments: { chatId: 'chat-1' },
      }).success,
    ).toBe(true);

    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages',
        arguments: { senderName: 'Bob' },
      }).success,
    ).toBe(true);
  });

  it('requires target selector and valid non-inverted time bounds for query_target_messages_by_time', () => {
    // Missing time bounds
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { target: 'Alice' },
      }).success,
    ).toBe(false);

    // No target selector: allowed only with from (reads all chats)
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { from: '2026-10-15', to: '2026-10-17' },
      }).success,
    ).toBe(true);
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { from: '2026-10-15' },
      }).success,
    ).toBe(true);
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { to: '2026-10-17' },
      }).success,
    ).toBe(false);
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { accountId: 'account-a', limit: 20 },
      }).success,
    ).toBe(false);
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { from: 'not-a-date' },
      }).success,
    ).toBe(false);
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages',
        arguments: { accountId: 'account-a', limit: 20 },
      }).success,
    ).toBe(false);

    // Inverted time range (from > to)
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: {
          target: 'Alice',
          from: '2026-10-18T00:00:00.000Z',
          to: '2026-10-17T00:00:00.000Z',
        },
      }).success,
    ).toBe(false);

    // Invalid date string
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: {
          target: 'Alice',
          from: 'not-a-date',
        },
      }).success,
    ).toBe(false);

    // Valid ISO-8601 and YYYY-MM-DD ranges
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: {
          target: 'Alice',
          from: '2026-10-15',
          to: '2026-10-17',
        },
      }).success,
    ).toBe(true);
  });

  it('validates target summary, message record, and IPC request/result variants', () => {
    const target = {
      accountId: 'account-a',
      accountDisplayName: 'Admin LINE',
      chatType: 'group' as const,
      chatId: 'group-1',
      conversationTitle: 'Project Room',
      members: [{ memberId: 'u-1', displayName: 'Alice' }],
    };
    expect(McpTargetSummarySchema.parse(target).chatId).toBe('group-1');

    const message = {
      accountId: 'account-a',
      accountDisplayName: 'Admin LINE',
      chatType: 'group' as const,
      chatId: 'group-1',
      conversationTitle: 'Project Room',
      messageId: 'm-1',
      senderId: 'u-1',
      senderName: 'Alice',
      direction: 'inbound' as const,
      kind: 'text' as const,
      text: 'Hello team',
      recalled: false,
      occurredAt: '2026-10-17T10:00:00.000Z',
      attachments: [],
    };
    expect(McpMessageRecordSchema.parse(message).messageId).toBe('m-1');
    // Layer-1 payloads never cross the MCP surface.
    for (const leak of [{ raw: {} }, { native: {} }, { content: { format: 1, type: 'event', nativeContentType: 6, text: null } }]) {
      expect(McpMessageRecordSchema.safeParse({ ...message, ...leak }).success).toBe(false);
      expect(McpToolOutputUnionSchema.safeParse({ toolName: 'query_target_messages', messages: [{ ...message, ...leak }] }).success).toBe(false);
    }
    expect(
      McpToolOutputUnionSchema.parse({
        toolName: 'query_target_messages',
        messages: [message],
        hasMore: false,
        nextCursor: null,
        page: { returned: 1, limit: 50, hasMore: false, nextCursor: null },
      }).toolName,
    ).toBe('query_target_messages');

    // IPC requests
    expect(IpcRequestSchema.safeParse({ type: 'mcpGetStatus', requestId: 'r-1' }).success).toBe(true);
    expect(
      IpcRequestSchema.safeParse({
        type: 'mcpCallInternalTool',
        requestId: 'r-5',
        tool: { name: 'list_targets', arguments: { limit: 10 } },
      }).success,
    ).toBe(true);
  });
  it('reads a date-only MCP time bound as a full day in Taiwan time', () => {
    expect(normalizeMcpTimeBound('2026-10-30', 'from')).toBe('2026-10-29T16:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-10-30', 'to')).toBe('2026-10-30T15:59:59.999Z');
    expect(normalizeMcpTimeBound(' 2026-10-30 ', 'from')).toBe('2026-10-29T16:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-11-01', 'from')).toBe('2026-10-31T16:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-10-31', 'to')).toBe('2026-10-31T15:59:59.999Z');
    expect(normalizeMcpTimeBound('2027-01-01', 'from')).toBe('2026-12-31T16:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-12-31', 'to')).toBe('2026-12-31T15:59:59.999Z');
    expect(normalizeMcpTimeBound('2026-02-31', 'from')).toBeNull();
    expect(normalizeMcpTimeBound('2026-02-31', 'to')).toBeNull();
    expect(normalizeMcpTimeBound('', 'from')).toBeNull();
  });
  it('keeps the instant of an MCP time bound that has an offset', () => {
    expect(normalizeMcpTimeBound('2026-10-30T08:00:00+08:00', 'from')).toBe('2026-10-30T00:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-10-30T00:00:00Z', 'to')).toBe('2026-10-30T00:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-10-30T00:00:00-05:00', 'to')).toBe('2026-10-30T05:00:00.000Z');
    expect(normalizeMcpTimeBound('2026-10-30T00:00:00', 'from')).toBeNull();
  });
});

describe('list_active_chats and by-time message filters', () => {
  const parseActive = (args: Record<string, unknown>) => McpToolInputUnionSchema.safeParse({ name: 'list_active_chats', arguments: args });
  const parseByTime = (args: Record<string, unknown>) => McpToolInputUnionSchema.safeParse({ name: 'query_target_messages_by_time', arguments: args });
  const issue = (result: ReturnType<typeof parseActive>) => (result.success ? null : result.error.issues[0]?.message);

  it('registers list_active_chats as a read tool with the same permissions as the by-time query', () => {
    expect(MCP_TOOL_NAMES).toContain('list_active_chats');
    expect(MCP_TOOL_EFFECTS.list_active_chats).toBe('read');
    expect(MCP_TOOL_PERMISSIONS.list_active_chats).toEqual(MCP_TOOL_PERMISSIONS.query_target_messages_by_time);
  });

  it('accepts a minimal and a full list_active_chats input', () => {
    expect(parseActive({ from: '2026-10-30' }).success).toBe(true);
    const full = parseActive({
      from: '2026-10-30', to: '2026-10-31T10:00:00+08:00', accountId: ' acc ', chatType: 'group', excludeChatIds: [' c1 ', 'c2'],
      direction: 'inbound', kinds: ['text', 'image'], limit: 20,
    });
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.arguments).toMatchObject({ accountId: 'acc', excludeChatIds: ['c1', 'c2'], limit: 20 });
  });

  it('rejects every invalid list_active_chats input', () => {
    expect(parseActive({ from: '2026-10-30' }).success).toBe(true);
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['missing from', {}],
      ['only to', { to: '2026-10-30' }],
      ['empty from', { from: '  ' }],
      ['bad from', { from: 'yesterday' }],
      ['bad to', { from: '2026-10-30', to: '2026-13-40' }],
      ['reversed range', { from: '2026-10-31', to: '2026-10-30' }],
      ['limit zero', { from: '2026-10-30', limit: 0 }],
      ['fractional limit', { from: '2026-10-30', limit: 1.5 }],
      ['bad chat type', { from: '2026-10-30', chatType: 'channel' }],
      ['bad direction', { from: '2026-10-30', direction: 'both' }],
      ['bad kind', { from: '2026-10-30', kinds: ['gif'] }],
      ['bad excluded kind', { from: '2026-10-30', excludeKinds: ['gif'] }],
      ['empty kinds', { from: '2026-10-30', kinds: [] }],
      ['blank chat id', { from: '2026-10-30', excludeChatIds: ['  '] }],
      ['101 chat ids', { from: '2026-10-30', excludeChatIds: Array.from({ length: 101 }, (_, index) => 'c' + index) }],
      ['target selector', { from: '2026-10-30', chatId: 'c1' }],
      ['cursor', { from: '2026-10-30', cursor: 'abc' }],
      ['unknown key', { from: '2026-10-30', text: 'hello' }],
    ];
    for (const [label, args] of invalid) expect(parseActive(args).success, label).toBe(false);
    expect(issue(parseActive({ from: '2026-10-31', to: '2026-10-30' }))).toMatch(/from must be less than or equal to to/);
    expect(issue(parseActive({ from: '2026-10-30', kinds: ['text'], excludeKinds: ['image'] }))).toMatch(/kinds and excludeKinds cannot be used together/);
  });

  it('accepts exactly 100 excluded chat ids and clamps limit to 500', () => {
    expect(parseActive({ from: '2026-10-30', excludeChatIds: Array.from({ length: 100 }, (_, index) => 'c' + index) }).success).toBe(true);
    const big = parseActive({ from: '2026-10-30', limit: 100000 });
    expect(big.success && (big.data.arguments as { limit?: number }).limit).toBe(500);
    const edge = parseActive({ from: '2026-10-30', limit: 500 });
    expect(edge.success && (edge.data.arguments as { limit?: number }).limit).toBe(500);
    const omitted = parseActive({ from: '2026-10-30' });
    expect(omitted.success && (omitted.data.arguments as { limit?: number }).limit).toBeUndefined();
  });

  it('validates the list_active_chats output', () => {
    const chat = { accountId: 'a', accountDisplayName: null, chatType: 'group', chatId: 'c', conversationTitle: null, messageCount: 2, senderCount: 1, lastMessageAt: '2026-10-30T01:00:00.000Z' };
    const output = { toolName: 'list_active_chats', from: '2026-10-30T00:00:00.000Z', to: null, chats: [chat], truncated: false };
    expect(McpToolOutputUnionSchema.safeParse(output).success).toBe(true);
    expect(McpToolOutputUnionSchema.safeParse({ ...output, chats: [{ ...chat, text: 'leak' }] }).success).toBe(false);
    expect(McpToolOutputUnionSchema.safeParse({ ...output, truncated: undefined }).success).toBe(false);
  });

  it('accepts the four new filters on query_target_messages_by_time and rejects invalid ones', () => {
    const base = { from: '2026-10-30' };
    const valid = parseByTime({ ...base, excludeChatIds: ['c1'], direction: 'outbound', kinds: ['text'] });
    expect(valid.success).toBe(true);
    expect(parseByTime({ ...base, excludeKinds: ['sticker', 'event'] }).success).toBe(true);
    expect(parseByTime({ ...base, chatId: 'c1', direction: 'inbound' }).success).toBe(true);
    for (const kind of McpMessageKindSchema.options) expect(parseByTime({ ...base, kinds: [kind] }).success, kind).toBe(true);
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['bad direction', { ...base, direction: 'sideways' }],
      ['bad kind', { ...base, kinds: ['gif'] }],
      ['bad excluded kind', { ...base, excludeKinds: ['gif'] }],
      ['empty kinds', { ...base, kinds: [] }],
      ['blank chat id', { ...base, excludeChatIds: [''] }],
      ['101 chat ids', { ...base, excludeChatIds: Array.from({ length: 101 }, (_, index) => 'c' + index) }],
      ['non-string chat id', { ...base, excludeChatIds: [1] }],
      ['kinds with excludeKinds', { ...base, kinds: ['text'], excludeKinds: ['image'] }],
    ];
    for (const [label, args] of invalid) expect(parseByTime(args).success, label).toBe(false);
  });

  it('does not treat the new filters as a target selector and leaves query_target_messages unchanged', () => {
    expect(parseByTime({ excludeChatIds: ['c1'], direction: 'inbound', to: '2026-10-30' }).success).toBe(false);
    expect(parseByTime({ kinds: ['text'], to: '2026-10-30' }).success).toBe(false);
    expect(parseByTime({ excludeChatIds: ['c1'], direction: 'inbound', from: '2026-10-30' }).success).toBe(true);
    for (const extra of [{ excludeChatIds: ['c1'] }, { direction: 'inbound' }, { kinds: ['text'] }, { excludeKinds: ['text'] }]) {
      expect(McpToolInputUnionSchema.safeParse({ name: 'query_target_messages', arguments: { chatId: 'c1', ...extra } }).success).toBe(false);
    }
  });
});
