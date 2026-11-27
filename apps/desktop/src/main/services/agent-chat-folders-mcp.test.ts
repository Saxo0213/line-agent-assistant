import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { CHAT_DOWNLOAD_FOLDER_TOOL_NAMES } from '@line-agent/contracts';
import { McpDomainError, allPermissions, type MessageRepository } from '@line-agent/database';
import { AttachmentStorageService } from './attachment-storage-service.js';
import { McpService, type AgentChatFolderHandler } from './mcp-service.js';

type Rpc = (method: string, params?: unknown) => Promise<{ httpStatus: number; body: Record<string, unknown> | null }>;
const toolNames = async (rpc: Rpc) =>
  ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
const resultOf = (response: Awaited<ReturnType<Rpc>>) =>
  (response.body as { result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } }).result;
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_ID = '33333333-3333-4333-8333-333333333333';

function harness(options: { chatFolders?: boolean; deny?: boolean; storage?: AgentChatFolderHandler; scope?: 'full' | 'own_chat' } = {}) {
  const refusals: Array<string | undefined> = [];
  const status = { defaultFolder: { folderId: DEFAULT_ID, root: 'C:\\default', queued: 0, claimed: 0, completed: 1, failed: 0 },
    folders: [{ folderId: FOLDER_ID, root: 'C:\\invoices', description: 'invoices', queued: 0, claimed: 0, completed: 2, failed: 0 }], waitingClassification: 0, decisions: [] };
  const storage = options.storage ?? {
    fixedLocation: 'C:\\attachments',
    getStatus: vi.fn(async () => status),
    addFolder: vi.fn(async () => ({ ok: true as const, count: 2, root: 'D:\\new', folderId: FOLDER_ID, backfill: false })),
    addSubfolder: vi.fn(async () => ({ ok: true as const, count: 2, root: 'C:\\default\\2026\\invoices', folderId: FOLDER_ID, backfill: false })),
    setDefaultFolder: vi.fn(async () => ({ ok: true as const, count: 1, root: 'D:\\default', folderId: DEFAULT_ID, backfill: false })),
    removeFolder: vi.fn(async () => ({ ok: true as const, count: 0 })),
    setFolderDescription: vi.fn(async () => ({ ok: true as const, count: 0 })),
  } satisfies AgentChatFolderHandler;
  const tokens = {
    verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend: false, chatFolders: options.chatFolders ?? true,
      chatFolderScope: options.chatFolders === false ? null : options.scope ?? 'full' }),
    executeForInternalAgent: async (input: { execute: (context: unknown) => Promise<{ data: unknown; refused?: string }> }) => {
      if (options.deny) throw new McpDomainError('PERMISSION_DENIED', 'no');
      const client = { query: async (sql: string) => sql.includes('FROM agent_jobs')
        ? { rows: [{ account_id: 'acc', chat_type: 'group', chat_id: 'Cgroup' }] } : { rows: [{}], rowCount: 1 } };
      const result = await input.execute({ client, principalId: 'internal:primary_admin:1', authorizedAccountIds: ['acc'], chatFolderScope: options.scope ?? 'full' });
      refusals.push(result.refused);
      return result.data;
    },
    recordAudit: async () => undefined,
  } as never;
  const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, chatFolders: storage });
  const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: 'acc', endpointInstance: 'instance' });
  const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
  return { rpc, service, storage, refusals, call: (name: string, args: unknown) => rpc('tools/call', { name, arguments: args }) };
}

describe('download folder tools', () => {
  it('lets an admin job add, describe, set the default and remove folders of its own chat', async () => {
    const h = harness();
    expect(await toolNames(h.rpc)).toEqual(expect.arrayContaining([...CHAT_DOWNLOAD_FOLDER_TOOL_NAMES]));
    const key = { accountId: 'acc', chatType: 'group', chatId: 'Cgroup' };
    const added = resultOf(await h.call('add_chat_download_folder', { path: 'D:\\new', description: '  receipts  ' }));
    expect(added.isError).toBe(false);
    expect(added.structuredContent).toMatchObject({ ok: true, folderId: FOLDER_ID, root: 'D:\\new' });
    expect(h.storage.addFolder).toHaveBeenCalledWith(key, 'D:\\new', 'receipts');
    expect(resultOf(await h.call('set_chat_download_folder_description', { folderId: FOLDER_ID, description: 'bills' })).isError).toBe(false);
    expect(h.storage.setFolderDescription).toHaveBeenCalledWith(key, FOLDER_ID, 'bills');
    expect(resultOf(await h.call('set_chat_default_download_folder', { path: 'D:\\default' })).isError).toBe(false);
    expect(h.storage.setDefaultFolder).toHaveBeenCalledWith(key, 'D:\\default');
    expect(resultOf(await h.call('remove_chat_download_folder', { folderId: FOLDER_ID })).isError).toBe(false);
    expect(h.storage.removeFolder).toHaveBeenLastCalledWith(key, FOLDER_ID);
    expect(resultOf(await h.call('remove_chat_download_folder', { clearDefault: true })).isError).toBe(false);
    expect(h.storage.removeFolder).toHaveBeenLastCalledWith(key, DEFAULT_ID);
    const listed = resultOf(await h.call('list_chat_download_folders', {}));
    expect(listed.structuredContent).toMatchObject({ fixedLocation: 'C:\\attachments', defaultFolder: { folderId: DEFAULT_ID }, folders: [{ folderId: FOLDER_ID, description: 'invoices' }] });
    await h.service.shutdown();
  });

  it('does not offer the tools to a principal that may not use them, and refuses their calls', async () => {
    const denied = harness({ chatFolders: false, deny: true });
    for (const name of CHAT_DOWNLOAD_FOLDER_TOOL_NAMES) expect(await toolNames(denied.rpc)).not.toContain(name);
    const response = resultOf(await denied.call('add_chat_download_folder', { path: 'D:\\new', description: 'x' }));
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toEqual({ error: { code: 'chat_folder_not_permitted' } });
    expect(denied.storage.addFolder).not.toHaveBeenCalled();
    await denied.service.shutdown();
  });

  it('returns the real folder error code of an invalid path', async () => {
    const storage = new AttachmentStorageService({ repository: {} as never, messages: {} as never, attachmentRoot: 'C:\\attachments' });
    const h = harness({ storage });
    const response = resultOf(await h.call('add_chat_download_folder', { path: 'relative\\folder', description: 'x' }));
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toEqual({ error: { code: 'NOT_ABSOLUTE' } });
    await h.service.shutdown();
  });
});

describe('download folder tools for a whitelisted user (own chat)', () => {
  const errorCode = (response: Awaited<ReturnType<Rpc>>) => (JSON.parse(resultOf(response).content[0]!.text) as { error: { code: string } }).error.code;

  it('lists four tools without the default folder tool, adds a subfolder of its own chat and hides the fixed location', async () => {
    const h = harness({ scope: 'own_chat' });
    const names = await toolNames(h.rpc);
    expect(names).toEqual(expect.arrayContaining(['list_chat_download_folders', 'add_chat_download_folder', 'set_chat_download_folder_description', 'remove_chat_download_folder']));
    expect(names).not.toContain('set_chat_default_download_folder');
    const key = { accountId: 'acc', chatType: 'group', chatId: 'Cgroup' };
    const added = resultOf(await h.call('add_chat_download_folder', { path: '2026/invoices', description: ' bills ' }));
    expect(added.isError).toBe(false);
    expect(h.storage.addSubfolder).toHaveBeenCalledWith(key, '2026/invoices', 'bills');
    expect(h.storage.addFolder).not.toHaveBeenCalled();
    // Naming the own chat explicitly is the same chat and is allowed.
    expect(resultOf(await h.call('add_chat_download_folder', { accountId: 'acc', chatType: 'group', chatId: 'Cgroup', path: 'a', description: 'x' })).isError).toBe(false);
    expect(resultOf(await h.call('set_chat_download_folder_description', { folderId: FOLDER_ID, description: 'bills' })).isError).toBe(false);
    expect(resultOf(await h.call('remove_chat_download_folder', { folderId: FOLDER_ID })).isError).toBe(false);
    expect(h.storage.removeFolder).toHaveBeenCalledWith(key, FOLDER_ID);
    // The default folder is not a classification folder.
    expect(errorCode(await h.call('remove_chat_download_folder', { folderId: DEFAULT_ID }))).toBe('NOT_FOUND');
    expect(errorCode(await h.call('set_chat_download_folder_description', { folderId: DEFAULT_ID, description: 'x' }))).toBe('NOT_FOUND');
    const listed = resultOf(await h.call('list_chat_download_folders', {})).structuredContent!;
    expect(listed).toMatchObject({ defaultFolder: { folderId: DEFAULT_ID } });
    expect(listed).not.toHaveProperty('fixedLocation');
    await h.service.shutdown();
  });

  it('refuses another chat, the default folder tool and a cleared default folder, and reports each refusal for the audit', async () => {
    const h = harness({ scope: 'own_chat' });
    expect(errorCode(await h.call('add_chat_download_folder', { accountId: 'acc', chatType: 'group', chatId: 'Cother', path: 'a', description: 'x' }))).toBe('TARGET_NOT_ALLOWED');
    expect(errorCode(await h.call('list_chat_download_folders', { chatType: 'direct', chatId: 'Cgroup' }))).toBe('TARGET_NOT_ALLOWED');
    expect(h.refusals).toEqual(['SCOPE_DENIED', 'SCOPE_DENIED']);
    expect(errorCode(await h.call('set_chat_default_download_folder', { path: 'a' }))).toBe('ADMIN_ONLY');
    expect(errorCode(await h.call('remove_chat_download_folder', { clearDefault: true }))).toBe('ADMIN_ONLY');
    expect(h.refusals.slice(2)).toEqual(['PERMISSION_DENIED', 'PERMISSION_DENIED']);
    expect(h.storage.addSubfolder).not.toHaveBeenCalled();
    expect(h.storage.setDefaultFolder).not.toHaveBeenCalled();
    expect(h.storage.removeFolder).not.toHaveBeenCalled();
    await h.service.shutdown();
  });

  it('refuses a room member (no folder authority): no tools and a refused call', async () => {
    const member = harness({ chatFolders: false, deny: true });
    expect(await toolNames(member.rpc)).not.toContain('add_chat_download_folder');
    expect(errorCode(await member.call('add_chat_download_folder', { path: 'a', description: 'x' }))).toBe('chat_folder_not_permitted');
    expect(member.storage.addSubfolder).not.toHaveBeenCalled();
    await member.service.shutdown();
  });

  describe('AttachmentStorageService.addSubfolder', () => {
    const key = { accountId: 'acc', chatType: 'group' as const, chatId: 'Cgroup' };
    const setup = async () => {
      const base = await realpath(await mkdtemp(join(tmpdir(), 'subfolder-')));
      const root = join(base, 'default');
      await mkdir(root);
      const outside = join(base, 'outside');
      await mkdir(outside);
      const added: string[] = [];
      const defaultFolder = { accountId: 'acc', chatType: 'group' as const, chatId: 'Cgroup', folderId: DEFAULT_ID, root, description: '', kind: 'default' as const };
      const repository = {
        listFolders: async () => [defaultFolder],
        addFolder: async (_key: unknown, folderRoot: string) => {
          added.push(folderRoot);
          return { folders: [defaultFolder, { ...defaultFolder, folderId: FOLDER_ID, root: folderRoot, kind: 'classified' as const }] };
        },
      };
      const service = new AttachmentStorageService({ repository: repository as never, messages: {} as never, attachmentRoot: join(base, 'attachments') });
      return { base, root, outside, added, service, cleanup: () => rm(base, { recursive: true, force: true }) };
    };

    it('creates a subfolder inside the default folder and saves it', async () => {
      const s = await setup();
      try {
        const result = await s.service.addSubfolder(key, '2026/發票', 'invoices');
        expect(result).toMatchObject({ ok: true, root: join(s.root, '2026', '發票') });
        expect((await stat(join(s.root, '2026', '發票'))).isDirectory()).toBe(true);
        expect(s.added).toEqual([join(s.root, '2026', '發票')]);
      } finally { await s.cleanup(); }
    });

    it.each(['..', '../x', 'a/../b', '/abs', 'C:\\x', 'C:x', '\\\\server\\share', 'a\\b', '', 'a//b', 'CON', 'name.', 'name ', 'a<b', 'a:b'])('refuses %j', async (value) => {
      const s = await setup();
      try {
        expect(await s.service.addSubfolder(key, value, 'x')).toEqual({ ok: false, code: 'INVALID_SUBFOLDER' });
        expect(s.added).toEqual([]);
      } finally { await s.cleanup(); }
    });

    it('refuses a junction or link that leaves the default folder and creates nothing outside', async () => {
      const s = await setup();
      try {
        await symlink(s.outside, join(s.root, 'link'), 'junction');
        expect(await s.service.addSubfolder(key, 'link/escape', 'x')).toEqual({ ok: false, code: 'OUTSIDE_DEFAULT_FOLDER' });
        expect(await s.service.addSubfolder(key, 'link', 'x')).toEqual({ ok: false, code: 'OUTSIDE_DEFAULT_FOLDER' });
        expect(await readdir(s.outside)).toEqual([]);
        expect(s.added).toEqual([]);
      } finally { await s.cleanup(); }
    });
  });
});
