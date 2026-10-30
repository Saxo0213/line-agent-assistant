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
    const internalResponse = await internal.service.handleInternalJsonRpc(internal.token, 'endpoint', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_chat_album', arguments: { ...own, albumId: 'a1' } } });
    expect(internalResponse.httpStatus).toBe(200);
    expect((internalResponse.body as any).result.structuredContent).toMatchObject({ toolName: 'get_chat_album', accountId: 'acc-a', photos: [{ photoId: 'p1', available: true }] });
    expect(JSON.stringify((internalResponse.body as any).result.structuredContent)).not.toMatch(/private\/path|bytes/);
    expect(internal.reader.getAlbum).toHaveBeenCalledWith(own, 'a1', expect.any(AbortSignal));
    await internal.service.shutdown();

    const external = createService({ externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'] });
    const externalResponse = await external.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_chat_notes', arguments: own } });
    expect(externalResponse.httpStatus).toBe(200);
    expect((externalResponse.body as any).result.structuredContent).toMatchObject({ toolName: 'list_chat_notes', notes: [{ noteId: 'n1' }] });
    await external.service.shutdown();
  });

  it('discovers new tools only when a reader is wired and the external tool scope includes them', async () => {
    const withReader = createService({ externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'] });
    const external = await withReader.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    expect((external.body as any).result.tools.map((tool: { name: string }) => tool.name)).toContain('list_chat_notes');
    const internal = await withReader.service.handleInternalJsonRpc(withReader.token, 'endpoint', { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect((internal.body as any).result.tools.map((tool: { name: string }) => tool.name)).toContain('list_chat_notes');
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

  it.each(['internal', 'external'] as const)('denies %s results when login is lost during the archive read', async (kind) => {
    let finish!: (value: { notes: unknown[]; nextCursor: null; savedAt: string }) => void;
    let checks = 0;
    const deferredReader: McpChatResourceReader = { ...readResult, listNotes: vi.fn(() => new Promise<{ notes: unknown[]; nextCursor: null; savedAt: string }>((resolve) => { finish = resolve; })) };
    const service = createService({ reader: deferredReader, externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'],
      getBinding: async () => ++checks < 2 ? ({ accountId: 'acc-a', workerInstanceId: 'worker-a', controlEpoch: 1 }) : null });
    const call = kind === 'internal'
      ? service.service.handleInternalJsonRpc(service.token, 'endpoint', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_chat_notes', arguments: own } })
      : service.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_chat_notes', arguments: own } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ notes: [{ noteId: 'secret-note' }], nextCursor: null, savedAt: '2026-10-23T00:00:00.000Z' });
    const response = await call;
    expect(response.httpStatus).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('secret-note');
    await service.service.shutdown();
  });

  it.each(['internal', 'external'] as const)('denies %s results when the authenticated binding is replaced during the archive read', async (kind) => {
    let finish!: (value: { notes: unknown[]; nextCursor: null; savedAt: string }) => void;
    let checks = 0;
    const deferredReader: McpChatResourceReader = { ...readResult, listNotes: vi.fn(() => new Promise<{ notes: unknown[]; nextCursor: null; savedAt: string }>((resolve) => { finish = resolve; })) };
    const service = createService({ reader: deferredReader, externalScopes: ['list_chat_notes'], externalAccounts: ['acc-a'],
      getBinding: async () => ({ accountId: 'acc-a', workerInstanceId: ++checks < 2 ? 'worker-a' : 'worker-b', controlEpoch: 1 }) });
    const call = kind === 'internal'
      ? service.service.handleInternalJsonRpc(service.token, 'endpoint', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_chat_notes', arguments: own } })
      : service.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_chat_notes', arguments: own } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ notes: [{ noteId: 'secret-note' }], nextCursor: null, savedAt: '2026-10-23T00:00:00.000Z' });
    const response = await call;
    expect(response.httpStatus).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('secret-note');
    await service.service.shutdown();
  });
});
