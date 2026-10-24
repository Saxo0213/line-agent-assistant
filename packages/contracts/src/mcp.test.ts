import { describe, expect, it } from 'vitest';
import {
  IpcRequestSchema,
  IpcResultSchema,
  McpMessageRecordSchema,
  McpServerStatusSchema,
  McpTargetSummarySchema,
  McpTokenSummarySchema,
  McpToolInputUnionSchema,
  McpToolNameSchema,
  McpToolOutputUnionSchema,
  MCP_TOOL_EFFECTS,
  MCP_TOOL_NAMES,
} from './index.js';

describe('MCP contracts and IPC schemas', () => {
  it('accepts explicit limited and never expiration and rejects ambiguous or invalid lifetimes', () => {
    const base = { type: 'mcpIssueToken', requestId: 'expiry-test', deviceLabel: 'External',
      accountScopes: ['account-a'], toolScopes: ['list_targets'] };
    for (const expiration of [{ mode: 'never' }, { mode: 'limited', hours: 1 }, { mode: 'limited', hours: 8760 }]) {
      expect(IpcRequestSchema.safeParse({ ...base, expiration }).success).toBe(true);
    }
    for (const expiration of [undefined, null, { mode: 'never', hours: 24 }, { mode: 'limited' },
      { mode: 'limited', hours: 0 }, { mode: 'limited', hours: 8761 }, { mode: 'limited', hours: 1.5 },
      { mode: 'limited', hours: '24' }, { mode: 'unknown' }]) {
      expect(IpcRequestSchema.safeParse({ ...base, expiration }).success).toBe(false);
    }
    expect(IpcRequestSchema.safeParse({ ...base, expiration: { mode: 'never' }, expiresInHours: 24 }).success).toBe(false);
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

  it('validates non-secret MCP token summary and server status schemas', () => {
    const token = {
      tokenId: '11111111-1111-4111-8111-111111111111',
      principalId: 'external:laptop-1',
      deviceLabel: 'Analyst Laptop',
      accountScopes: ['account-admin', 'account-agent'],
      toolScopes: ['list_targets', 'query_target_messages'] as const,
      grantVersion: 1,
      state: 'ACTIVE' as const,
      expiresAt: '2026-10-20T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
      createdAt: '2026-10-17T00:00:00.000Z',
    };
    expect(McpTokenSummarySchema.parse(token).tokenId).toBe(token.tokenId);
    expect(McpTokenSummarySchema.parse({ ...token, expiresAt: null }).expiresAt).toBeNull();
    expect(
      McpTokenSummarySchema.safeParse({
        ...token,
        plaintextToken: 'la_mcp_' + 'A'.repeat(43),
      }).success,
    ).toBe(false);

    const status = {
      running: true,
      endpoint: 'http://127.0.0.1:38471/mcp',
      host: '127.0.0.1' as const,
      port: 38471,
      activeTokenCount: 2,
      inFlightRequests: 0,
      maxConcurrentRequests: 8,
    };
    expect(McpServerStatusSchema.parse(status).host).toBe('127.0.0.1');
    expect(McpServerStatusSchema.safeParse({ ...status, host: '0.0.0.0' }).success).toBe(false);
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
      }).toolName,
    ).toBe('query_target_messages');

    // IPC requests
    expect(IpcRequestSchema.safeParse({ type: 'mcpGetStatus', requestId: 'r-1' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'mcpListTokens', requestId: 'r-2' }).success).toBe(true);
    expect(
      IpcRequestSchema.safeParse({
        type: 'mcpIssueToken',
        requestId: 'r-3',
        deviceLabel: 'External CLI',
        accountScopes: ['account-a'],
        toolScopes: ['list_targets', 'query_target_messages'],
        expiration: { mode: 'limited', hours: 24 },
      }).success,
    ).toBe(true);
    expect(
      IpcRequestSchema.safeParse({
        type: 'mcpRevokeToken',
        requestId: 'r-4',
        tokenId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
    expect(
      IpcRequestSchema.safeParse({
        type: 'mcpCallInternalTool',
        requestId: 'r-5',
        tool: { name: 'list_targets', arguments: { limit: 10 } },
      }).success,
    ).toBe(true);

    // IPC results
    expect(
      IpcResultSchema.safeParse({
        type: 'mcpIssueToken',
        requestId: 'r-3',
        ok: true,
        token: {
          tokenId: '11111111-1111-4111-8111-111111111111',
          principalId: 'external:cli',
          deviceLabel: 'External CLI',
          accountScopes: ['account-a'],
          toolScopes: ['list_targets', 'query_target_messages'],
          grantVersion: 1,
          state: 'ACTIVE',
          expiresAt: '2026-10-18T00:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
          createdAt: '2026-10-17T00:00:00.000Z',
        },
        plaintextToken: 'la_mcp_' + 'A'.repeat(43),
      }).success,
    ).toBe(true);
  });
});
