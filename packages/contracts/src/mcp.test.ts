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

    // Missing target selector
    expect(
      McpToolInputUnionSchema.safeParse({
        name: 'query_target_messages_by_time',
        arguments: { from: '2026-10-15', to: '2026-10-17' },
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
});
