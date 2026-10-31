import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { allPermissions, McpDomainError, type McpTokenRepository, type MessageRepository } from '@line-agent/database';
import type { McpToolName } from '@line-agent/contracts';
import { McpService } from './mcp-service.js';
import type { McpChatResourceReader } from './mcp-chat-resource-reader.js';

const own = { accountId: 'acc-a', chatType: 'group' as const, chatId: 'chat-a' };
const linked = { accountId: 'acc-a', chatType: 'group' as const, chatId: 'chat-linked' };
const readResult: McpChatResourceReader = {
  listNotes: vi.fn(async () => ({ notes: [{ noteId: 'n1', savedAt: '2026-10-23T00:00:00.000Z' }], nextCursor: null, savedAt: '2026-10-23T00:00:00.000Z' })),
  getNote: vi.fn(async () => ({ note: { noteId: 'n1', markdown: 'note body' }, savedAt: '2026-10-23T00:00:00.000Z' })),
  listAlbums: vi.fn(async (key) => ({ albums: [{ albumId: 'a1', chatId: key.chatId, title: 'Album', photoCount: 1, createTime: null, updateTime: null }], nextCursor: null, savedAt: '2026-10-23T00:00:00.000Z' })),
  getAlbum: vi.fn(async (key) => ({ album: { albumId: 'a1', chatId: key.chatId, title: 'Album', photoCount: 1, createTime: null, updateTime: null, path: 'private/path' }, photos: [{ photoId: 'p1', available: true, bytes: new Uint8Array([1, 2, 3]) }], savedAt: '2026-10-23T00:00:00.000Z' })),
};

function client() {
  return { query: vi.fn(async () => ({ rowCount: 1, rows: [{}] })) } as unknown as PoolClient;
}

function createService(options: { externalScopes?: McpToolName[]; externalAccounts?: string[]; liveLogin?: boolean; reader?: McpChatResourceReader | null;
  getBinding?: () => Promise<{ accountId: string; workerInstanceId: string; controlEpoch: number } | null> } = {}) {
  const db = client();
  const callReader = options.reader === undefined ? readResult : options.reader;
  const tokens = {
    verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend: false }),
    verifyInternalAgent: async () => allPermissions('ALLOW'),
    executeForInternalAgent: async (input: { requestedAccountId?: string; requestedChat?: { chatType?: string; chatId?: string }; execute(context: unknown): Promise<{ data: unknown }> }) => {
      if (input.requestedAccountId && input.requestedAccountId !== 'acc-a') throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      const targetId = input.requestedChat?.chatId;
      if (targetId && targetId !== own.chatId && targetId !== linked.chatId) throw new McpDomainError('SCOPE_DENIED', 'The requested conversation is unavailable.');
      return (await input.execute({ client: db, principalId: 'internal:chat_scoped', authorizedAccountIds: ['acc-a'],
        conversationScope: own, extraConversationScopes: [linked], ownLineNamesOnly: true })).data;
    },
    executeLocalClientRead: async (input: { toolName: McpToolName | null; requestedAccountId?: string; execute(context: unknown): Promise<{ data: unknown }> }) => {
      if (input.toolName && !((options.externalScopes ?? []).includes(input.toolName))) throw new McpDomainError('SCOPE_DENIED', 'Tool scope denied.');
      if (input.requestedAccountId && !(options.externalAccounts ?? []).includes(input.requestedAccountId)) throw new McpDomainError('SCOPE_DENIED', 'Account scope denied.');
      return (await input.execute({ client: db, authorizedAccountIds: options.externalAccounts ?? [], toolScopes: options.externalScopes ?? [] })).data;
    },
    recordAudit: async () => undefined,
  } as unknown as McpTokenRepository;
  const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, ...(callReader ? { chatResources: callReader } : {}),
    getLiveLoginBinding: options.getBinding ?? (async () => options.liveLogin === false ? null : ({ accountId: 'acc-a', workerInstanceId: 'worker-a', controlEpoch: 1 })) });
  const { token } = service.internalCapabilities.mint({ jobId: 'job-a', generation: 1, accountId: 'acc-a', endpointInstance: 'endpoint' });
  return { service, token, db, reader: callReader ?? readResult };
}

describe('MCP archived chat resource tools', () => {
  beforeEach(() => vi.clearAllMocks());
  it('serves successful internal and external JSON-RPC queries from the archive reader', async () => {
    const internal = createService();
    const internalTools = await internal.service.handleInternalJsonRpc(internal.token, 'endpoint', { jsonrpc: '2.0', id: 0, method: 'tools/list' });
    expect((internalTools.body as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['list_chat_albums', 'get_chat_album']));
    const internalResponse = await internal.service.handleInternalJsonRpc(internal.token, 'endpoint', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_chat_album', arguments: { ...own, albumId: 'a1' } } });
    expect(internalResponse.httpStatus).toBe(200);
    expect((internalResponse.body as any).result.structuredContent).toMatchObject({ toolName: 'get_chat_album', accountId: 'acc-a', photos: [{ photoId: 'p1', available: true }] });
    expect(JSON.stringify((internalResponse.body as any).result.structuredContent)).not.toMatch(/private\/path|bytes/);
    expect(internal.reader.getAlbum).toHaveBeenCalledWith(own, 'a1', expect.any(AbortSignal));
    await internal.service.shutdown();

    const external = createService({ externalScopes: ['list_chat_notes', 'list_chat_albums', 'get_chat_album'], externalAccounts: ['acc-a'] });
    const externalResponse = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_chat_notes', arguments: own } });
    expect(externalResponse.httpStatus).toBe(403);
    expect(externalResponse.body).toMatchObject({ error: { message: 'Chat notes are disabled.' } });
    expect(external.reader.listNotes).not.toHaveBeenCalled();
    const externalAlbums = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_chat_albums', arguments: own } });
    expect(externalAlbums.httpStatus).toBe(200);
    expect((externalAlbums.body as any).result.structuredContent).toMatchObject({ toolName: 'list_chat_albums', albums: [{ albumId: 'a1' }] });
    const externalAlbum = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_chat_album', arguments: { ...own, albumId: 'a1' } } });
    expect(externalAlbum.httpStatus).toBe(200);
    expect((externalAlbum.body as any).result.structuredContent).toMatchObject({ toolName: 'get_chat_album', photos: [{ photoId: 'p1', available: true }] });
    expect(JSON.stringify(externalAlbum.body)).not.toContain('private/path');
    await external.service.shutdown();
  });

  it('discovers new tools only when a reader is wired and the external tool scope includes them', async () => {
    const withReader = createService({ externalScopes: ['list_chat_notes', 'list_chat_albums', 'get_chat_album'], externalAccounts: ['acc-a'] });
    const external = await withReader.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    expect((external.body as any).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('list_chat_notes');
    expect((external.body as any).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('get_chat_note');
    expect((external.body as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['list_chat_albums', 'get_chat_album']));
    const internal = await withReader.service.handleInternalJsonRpc(withReader.token, 'endpoint', { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect((internal.body as any).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('list_chat_notes');
    expect((internal.body as any).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('get_chat_note');
    await withReader.service.shutdown();

    const noReader = createService({ externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'], reader: null });
    const hidden = await noReader.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    expect((hidden.body as any).result.tools.map((tool: { name: string }) => tool.name)).not.toContain('list_chat_notes');
    await noReader.service.shutdown();
  });

  it('denies cross-account and out-of-scope-tool requests before filesystem lookup', async () => {
    const external = createService({ externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'] });
    const crossAccount = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_chat_notes', arguments: { ...own, accountId: 'acc-b' } } });
    const outOfScopeTool = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_chat_note', arguments: { ...own, noteId: 'n1' } } });
    expect(crossAccount.httpStatus).toBe(403);
    expect(outOfScopeTool.httpStatus).toBe(403);
    expect(external.reader.listNotes).not.toHaveBeenCalled();
    expect(external.reader.getNote).not.toHaveBeenCalled();
    await external.service.shutdown();

    const internal = createService();
    const outsideLinkedChats = await internal.service.handleInternalJsonRpc(internal.token, 'endpoint', { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_chat_albums', arguments: { ...own, chatId: 'chat-other' } } });
    expect(outsideLinkedChats.httpStatus).toBe(403);
    expect(internal.reader.listAlbums).not.toHaveBeenCalled();
    const linkedChatCall = await internal.service.handleInternalJsonRpc(internal.token, 'endpoint', { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'list_chat_albums', arguments: linked } });
    expect(linkedChatCall.httpStatus).toBe(200);
    expect(internal.reader.listAlbums).toHaveBeenCalledWith(linked, 20, undefined, expect.any(AbortSignal));
    await internal.service.shutdown();

    const loggedOut = createService({ externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'], liveLogin: false });
    const offline = await loggedOut.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'list_chat_notes', arguments: own } });
    expect(offline.httpStatus).toBe(403);
    expect(loggedOut.reader.listNotes).not.toHaveBeenCalled();
    expect(loggedOut.db.query).not.toHaveBeenCalled();
    await loggedOut.service.shutdown();
  });

  it.each(['list_chat_notes', 'get_chat_note'] as const)('rejects direct internal and external calls to disabled %s', async (name) => {
    const service = createService({ externalScopes: [name], externalAccounts: ['acc-a'] });
    const args = name === 'list_chat_notes' ? own : { ...own, noteId: 'n1' };
    const internal = await service.service.handleInternalJsonRpc(service.token, 'endpoint', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name, arguments: args } });
    const external = await service.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
    expect(internal.httpStatus).toBe(403);
    expect(external.httpStatus).toBe(403);
    expect(internal.body).toMatchObject({ error: { message: 'Chat notes are disabled.' } });
    expect(external.body).toMatchObject({ error: { message: 'Chat notes are disabled.' } });
    expect(service.reader.listNotes).not.toHaveBeenCalled();
    expect(service.reader.getNote).not.toHaveBeenCalled();
    await service.service.shutdown();
  });

  it('continues serving external Album calls after Notes tools are disabled', async () => {
    const service = createService({ externalScopes: ['list_chat_notes', 'list_chat_albums'], externalAccounts: ['acc-a'] });
    const response = await service.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_chat_albums', arguments: own } });
    expect(response.httpStatus).toBe(200);
    expect((response.body as any).result.structuredContent).toMatchObject({ toolName: 'list_chat_albums', albums: [{ albumId: 'a1' }] });
    expect(service.reader.listAlbums).toHaveBeenCalledOnce();
    await service.service.shutdown();
  });
});
