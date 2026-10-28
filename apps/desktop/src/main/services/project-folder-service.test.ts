import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectFolderMode, ProjectFolderRow } from '@line-agent/database';
import type { SystemTextInput } from './agent-line-send-service.js';
import { PROJECT_FOLDER_TEXT, ProjectFolderService, type ProjectFolderStore } from './project-folder-service.js';
import type { ProjectPathPolicy } from './project-folder-path.js';

const windows = process.platform === 'win32' ? describe : describe.skip;
const KEY = { accountId: 'acc', chatType: 'group' as const, chatId: 'room-secret-id' };

function memoryStore() {
  const rows: ProjectFolderRow[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const audit: string[] = [];
  const store: ProjectFolderStore = {
    async list(key) { return rows.filter((row) => row.chatId === key.chatId && row.chatType === key.chatType); },
    async bind(key, path, mode: ProjectFolderMode, actor) {
      const current = rows.find((row) => row.chatId === key.chatId && row.path === path);
      if (current) {
        if (current.mode === mode) return { status: 'unchanged', row: current };
        current.mode = mode; audit.push(`update:${actor}`); return { status: 'updated', row: current };
      }
      if (rows.filter((row) => row.chatId === key.chatId).length >= 8) return { status: 'limit' };
      const row: ProjectFolderRow = { ...key, path, mode, createdBy: actor, createdAt: new Date(), updatedAt: new Date() };
      rows.push(row); audit.push(`bind:${actor}`); return { status: 'created', row };
    },
    async unbind(key, path) {
      const index = rows.findIndex((row) => row.chatId === key.chatId && row.path === path);
      if (index < 0) return false; rows.splice(index, 1); audit.push('unbind'); return true;
    },
    async unbindAll(key) {
      const removed = rows.filter((row) => row.chatId === key.chatId).map((row) => row.path);
      for (const path of removed) rows.splice(rows.findIndex((row) => row.path === path), 1);
      if (removed.length) audit.push('unbind_all');
      return removed;
    },
    async recordSkipped(_key, path, reason) { skipped.push({ path, reason }); },
  };
  return { store, rows, skipped, audit };
}

windows('ProjectFolderService', () => {
  let base: string;
  let policy: ProjectPathPolicy;
  let sent: SystemTextInput[];
  let memory: ReturnType<typeof memoryStore>;
  let service: ProjectFolderService;
  const dir = async (...parts: string[]) => { const path = join(base, ...parts); await mkdir(path, { recursive: true }); return path; };
  const run = async (command: Parameters<ProjectFolderService['handleCommand']>[2]) => { await service.handleCommand(KEY, 'mid-admin', command); return sent.at(-1)!.text; };
  const bind = (path: string, mode: ProjectFolderMode = 'READ') => run({ type: 'folder', action: 'bind', path, mode });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'folder-service-')));
    policy = { forbiddenTrees: [await dir('Windows')], protectedPaths: [await dir('app')], profileRoots: [] };
    sent = [];
    memory = memoryStore();
    service = new ProjectFolderService({ store: memory.store, policy,
      sendSystemText: async (input) => { sent.push(input); return { status: 'sent' }; } });
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('binds read-only, then updates the mode of the same path, and says so', async () => {
    const folder = await dir('Projects', 'Alpha 專案');
    expect(await bind(folder)).toBe(`已綁定專案資料夾：${folder}（唯讀）`);
    expect(await bind(folder)).toBe(`專案資料夾已綁定：${folder}（唯讀）`);
    expect(await bind(folder, 'READ_WRITE')).toBe(`已更新專案資料夾：${folder}（讀寫）`);
    expect(memory.rows).toHaveLength(1);
    expect(memory.audit).toEqual(['bind:mid-admin', 'update:mid-admin']);
  });

  it('stores the canonical path of a junction and sends the reply to the same chat as a project folder system message', async () => {
    const real = await dir('real');
    const link = join(base, 'link');
    await symlink(real, link, 'junction');
    await bind(link);
    expect(memory.rows.map((row) => row.path)).toEqual([real]);
    expect(sent[0]).toMatchObject({ principalId: 'system:project_folder', target: KEY });
    expect(sent[0]!.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects bad paths with a short reason and never echoes the chat id', async () => {
    const texts = [
      await bind(join(base, 'missing')), await bind('relative\\path'), await bind(join(base, 'Windows')), await bind(join(base, 'app')),
      await bind(await dir('a (b)')),
    ];
    expect(texts).toEqual([PROJECT_FOLDER_TEXT.notFound, PROJECT_FOLDER_TEXT.notAbsolute, PROJECT_FOLDER_TEXT.forbidden, PROJECT_FOLDER_TEXT.forbidden,
      PROJECT_FOLDER_TEXT.unsupportedChars]);
    expect(memory.rows).toEqual([]);
    expect(sent.every((item) => !item.text.includes('room-secret-id'))).toBe(true);
  });

  it('lists the bound folders with their mode, or says there are none', async () => {
    expect(await run({ type: 'folder', action: 'list' })).toBe(PROJECT_FOLDER_TEXT.none);
    const first = await dir('one');
    const second = await dir('two');
    await bind(first); await bind(second, 'READ_WRITE');
    expect(await run({ type: 'folder', action: 'list' })).toBe(`本聊天室的專案資料夾：\n1. ${first}（唯讀）\n2. ${second}（讀寫）`);
  });

  it('keeps at most 8 folders per chat', async () => {
    for (let index = 0; index < 8; index += 1) await bind(await dir(`p${index}`));
    expect(await bind(await dir('p8'))).toBe(PROJECT_FOLDER_TEXT.limit);
    expect(memory.rows).toHaveLength(8);
  });

  it('unbinds one path (also after the folder is gone, and by a different spelling), then all', async () => {
    const one = await dir('one'); const two = await dir('Two'); const three = await dir('three');
    await bind(one); await bind(two); await bind(three);
    expect(await run({ type: 'folder', action: 'off', path: one.toUpperCase() })).toBe(PROJECT_FOLDER_TEXT.removed(one));
    await rm(two, { recursive: true });
    expect(await run({ type: 'folder', action: 'off', path: two })).toBe(PROJECT_FOLDER_TEXT.removed(two));
    expect(await run({ type: 'folder', action: 'off', path: join(base, 'never') })).toBe(PROJECT_FOLDER_TEXT.notBound);
    expect(await run({ type: 'folder', action: 'off', path: null })).toBe(PROJECT_FOLDER_TEXT.removedAll(1));
    expect(await run({ type: 'folder', action: 'off', path: null })).toBe(PROJECT_FOLDER_TEXT.none);
    expect(await run({ type: 'folder', action: 'off', path: one })).toBe(PROJECT_FOLDER_TEXT.none);
  });

  it('answers a malformed command with the usage text', async () => {
    expect(await run({ type: 'folder', action: 'usage' })).toBe(PROJECT_FOLDER_TEXT.usage);
  });

  it('reports a store failure instead of staying silent, and keeps later commands working', async () => {
    const errors: unknown[] = [];
    const failing = new ProjectFolderService({ store: { ...memory.store, async list() { throw new Error('db down'); } }, policy,
      sendSystemText: async (input) => { sent.push(input); return { status: 'sent' }; }, onError: (error) => errors.push(error) });
    await failing.handleCommand(KEY, 'mid-admin', { type: 'folder', action: 'list' });
    expect(sent.at(-1)!.text).toBe(PROJECT_FOLDER_TEXT.failed);
    expect(errors).toHaveLength(1);
    await service.handleCommand(KEY, 'mid-admin', { type: 'folder', action: 'list' });
    expect(sent.at(-1)!.text).toBe(PROJECT_FOLDER_TEXT.none);
  });

  describe('resolveMounts (job start)', () => {
    it('returns the still-valid folders with their mode', async () => {
      const ro = await dir('ro'); const rw = await dir('rw');
      await bind(ro); await bind(rw, 'READ_WRITE');
      expect(await service.resolveMounts(KEY)).toEqual([{ path: ro, mode: 'READ' }, { path: rw, mode: 'READ_WRITE' }]);
      expect(memory.skipped).toEqual([]);
    });

    it('skips and audits a folder that vanished, without failing the others', async () => {
      const gone = await dir('gone'); const kept = await dir('kept');
      await bind(gone); await bind(kept);
      await rm(gone, { recursive: true });
      expect(await service.resolveMounts(KEY)).toEqual([{ path: kept, mode: 'READ' }]);
      expect(memory.skipped).toEqual([{ path: gone, reason: 'not_found' }]);
    });

    it('skips a folder whose canonical path changed (replaced by a junction elsewhere)', async () => {
      const original = await dir('project');
      const elsewhere = await dir('elsewhere');
      await bind(original);
      await rename(original, join(base, 'project-moved'));
      await symlink(elsewhere, original, 'junction');
      expect(await service.resolveMounts(KEY)).toEqual([]);
      expect(memory.skipped).toEqual([{ path: original, reason: 'path_changed' }]);
    });

    it('skips a folder that now resolves into a forbidden place', async () => {
      const original = await dir('project');
      await bind(original);
      await rm(original, { recursive: true });
      await symlink(join(base, 'Windows'), original, 'junction');
      expect(await service.resolveMounts(KEY)).toEqual([]);
      expect(memory.skipped.map((item) => item.reason)).toEqual(['forbidden']);
    });

    it('mounts nothing for a chat type that cannot have folders', async () => {
      expect(await service.resolveMounts({ accountId: 'acc', chatType: 'community', chatId: 'x' })).toEqual([]);
    });
  });
});
