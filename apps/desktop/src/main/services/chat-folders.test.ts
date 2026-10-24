import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatFolderRow } from '@line-agent/database';
import { ChatFolderError, ChatFolderService, isStrictlyInside, type ChatFolderStore } from './chat-folders.js';

let base: string;
let workspace: string;
let outside: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'chat-folders-')));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

function store(): ChatFolderStore {
  const rows = new Map<string, ChatFolderRow>();
  return {
    async ensureChatFolder(accountId, chatType, chatId) {
      const key = JSON.stringify([accountId, chatType, chatId]);
      if (!rows.has(key)) rows.set(key, { folderId: crypto.randomUUID(), accountId, chatType: chatType as ChatFolderRow['chatType'], chatId, title: 'Friendly Title' });
      return rows.get(key)!;
    },
    async getChatFolderForConversation(accountId, chatType, chatId) {
      return rows.get(JSON.stringify([accountId, chatType, chatId])) ?? null;
    },
  };
}

describe('chat folder layers under the configured workspace', () => {
  it('creates groups\\<folder_id> for groups/rooms and chats\\<folder_id> for friend 1:1, idempotently, named by folder id only', async () => {
    const service = new ChatFolderService(store(), { current: async () => workspace });
    const group = await service.resolve('acc', 'group', 'C-secret-group-id', 'test');
    const room = await service.resolve('acc', 'room', 'R1', 'test');
    const friend = await service.resolve('acc', 'direct', 'U-friend-mid', 'test');
    expect(group.path).toBe(join(workspace, 'groups', group.folder.folderId));
    expect(room.path).toBe(join(workspace, 'groups', room.folder.folderId));
    expect(friend.path).toBe(join(workspace, 'chats', friend.folder.folderId));
    expect(new Set([group.path, room.path, friend.path]).size).toBe(3);
    expect((await service.resolve('acc', 'group', 'C-secret-group-id', 'test')).path).toBe(group.path);
    expect(group.path).not.toContain('C-secret-group-id');
    // Metadata: account, chat type, hashed chat id, title; never the raw chat id.
    const metadata = JSON.parse(await readFile(join(group.path, '_chat.json'), 'utf8')) as Record<string, string>;
    expect(metadata).toMatchObject({ accountId: 'acc', chatType: 'group', title: 'Friendly Title' });
    expect(metadata.chatIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(metadata)).not.toContain('C-secret-group-id');
    expect(await readdir(group.path)).toEqual(['_chat.json']);
    expect(isStrictlyInside(workspace, group.path)).toBe(true);
    expect(isStrictlyInside(workspace, workspace)).toBe(false);
  });

  it('resolves under a new workspace on demand without migrating old folders', async () => {
    const current = { value: workspace };
    const service = new ChatFolderService(store(), { current: async () => current.value });
    const first = await service.resolve('acc', 'group', 'g', 'test');
    const second = join(base, 'workspace-two');
    await mkdir(second);
    current.value = second;
    const moved = await service.resolve('acc', 'group', 'g', 'test');
    expect(moved.path).toBe(join(second, 'groups', first.folder.folderId));
    expect((await readdir(first.path)).length).toBe(1);
  });

  it('resolves an existing archive folder without creating rows, directories, or metadata', async () => {
    const rows = store();
    const service = new ChatFolderService(rows, { current: async () => workspace });
    expect(await service.resolveExisting('acc', 'group', 'g')).toBeNull();
    await expect(readdir(join(workspace, 'groups'))).rejects.toMatchObject({ code: 'ENOENT' });
    const { folder, path } = await service.resolve('acc', 'group', 'g', 'test');
    await rm(join(path, '_chat.json'));
    await expect(service.resolveExisting('acc', 'group', 'g')).resolves.toEqual({ folder, path });
    expect(await readdir(path)).toEqual([]);
  });

  it('fails closed when the layer or the folder is a junction escaping the workspace (row 8 / 15)', async () => {
    const service = new ChatFolderService(store(), { current: async () => workspace });
    await symlink(outside, join(workspace, 'groups'), 'junction');
    await expect(service.resolve('acc', 'group', 'g', 'test')).rejects.toBeInstanceOf(ChatFolderError);
    expect(await readdir(outside)).toEqual([]);
    await rm(join(workspace, 'groups'), { recursive: true, force: true });

    await mkdir(join(workspace, 'chats'));
    const rows = store();
    const guarded = new ChatFolderService(rows, { current: async () => workspace });
    const folder = await rows.ensureChatFolder('acc', 'direct', 'friend', 'test');
    await symlink(outside, join(workspace, 'chats', folder.folderId), 'junction');
    await expect(guarded.resolve('acc', 'direct', 'friend', 'test')).rejects.toMatchObject({ code: 'CHAT_FOLDER_UNAVAILABLE' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a folder that is a junction to a sibling folder inside the same layer', async () => {
    const rows = store();
    const service = new ChatFolderService(rows, { current: async () => workspace });
    const a = await service.resolve('acc', 'group', 'A', 'test');
    const folderB = await rows.ensureChatFolder('acc', 'group', 'B', 'test');
    await symlink(a.path, join(workspace, 'groups', folderB.folderId), 'junction');
    await expect(service.resolve('acc', 'group', 'B', 'test')).rejects.toMatchObject({ code: 'CHAT_FOLDER_UNAVAILABLE' });
  });

  it('does not follow a planted _chat.json link when writing metadata', async () => {
    const rows = store();
    const service = new ChatFolderService(rows, { current: async () => workspace });
    const folder = await rows.ensureChatFolder('acc', 'group', 'g', 'test');
    await mkdir(join(workspace, 'groups', folder.folderId), { recursive: true });
    const target = join(outside, 'victim.txt');
    await writeFile(target, 'untouched');
    await symlink(target, join(workspace, 'groups', folder.folderId, '_chat.json'), 'file').catch(() => undefined);
    await service.resolve('acc', 'group', 'g', 'test');
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });

  it('inspects usage read-only: counts files and bytes, skips links and the metadata file, null when missing', async () => {
    const rows = store();
    const service = new ChatFolderService(rows, { current: async () => workspace });
    const { folder, path } = await service.resolve('acc', 'group', 'g', 'test');
    await writeFile(join(path, 'notes.md'), 'hello');
    await mkdir(join(path, 'sub'));
    await writeFile(join(path, 'sub', 'a.txt'), '12345678');
    expect(await service.inspect(folder)).toEqual({ path, fileCount: 2, bytes: 13 });
    expect((await service.inspect({ folderId: crypto.randomUUID(), chatType: 'group' })).path).toBeNull();
  });
});
