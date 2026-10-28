import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { PROJECT_FOLDERS_PER_CHAT_MAX, ProjectFolderRepository, type ProjectFolderKey } from './project-folder-repository.js';
import { AGENT_PERMISSION_IDS } from '@line-agent/contracts';
import { allPermissions, deriveToolPolicy } from './agent-permissions.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const KEY: ProjectFolderKey = { accountId: 'acc', chatType: 'group', chatId: 'g1' };
const OTHER: ProjectFolderKey = { accountId: 'acc', chatType: 'direct', chatId: 'admin' };

database('Project folder repository (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: ProjectFolderRepository;
  const audits = async () => (await pool.query<{ actor: string; detail: { action: string; path?: string; paths?: string[] } }>(
    "SELECT actor, detail FROM agent_permission_audit WHERE audit_kind = 'PROJECT_FOLDER' ORDER BY audit_id")).rows;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new ProjectFolderRepository(pool);
  });
  afterAll(async () => { await close(); });

  it('binds read-only, lists, updates the mode in place and is idempotent', async () => {
    const created = await repo.bind(KEY, 'D:\\Company\\Projects', 'READ', 'mid-admin');
    expect(created).toMatchObject({ status: 'created', row: { path: 'D:\\Company\\Projects', mode: 'READ', createdBy: 'mid-admin' } });
    expect(await repo.bind(KEY, 'D:\\Company\\Projects', 'READ', 'mid-admin')).toMatchObject({ status: 'unchanged' });
    expect(await repo.bind(KEY, 'D:\\Company\\Projects', 'READ_WRITE', 'mid-admin')).toMatchObject({ status: 'updated', row: { mode: 'READ_WRITE' } });
    expect((await repo.list(KEY)).map((row) => [row.path, row.mode])).toEqual([['D:\\Company\\Projects', 'READ_WRITE']]);
    expect(await repo.list(OTHER)).toEqual([]);
  });

  it('keeps chats separate and refuses a ninth folder', async () => {
    for (let index = 2; index <= PROJECT_FOLDERS_PER_CHAT_MAX; index += 1) {
      expect((await repo.bind(KEY, `D:\\Company\\P${index}`, 'READ', 'mid-admin')).status).toBe('created');
    }
    expect(await repo.bind(KEY, 'D:\\Company\\Extra', 'READ', 'mid-admin')).toEqual({ status: 'limit' });
    // An existing path can still change mode when the chat is full; another chat has its own count.
    expect(await repo.bind(KEY, 'D:\\Company\\P2', 'READ_WRITE', 'mid-admin')).toMatchObject({ status: 'updated' });
    expect((await repo.bind(OTHER, 'D:\\Company\\Extra', 'READ', 'mid-admin')).status).toBe('created');
    expect(await repo.list(KEY)).toHaveLength(PROJECT_FOLDERS_PER_CHAT_MAX);
  });

  it('unbinds one path, then every path of the chat', async () => {
    expect(await repo.unbind(KEY, 'D:\\Company\\P2', 'mid-admin')).toBe(true);
    expect(await repo.unbind(KEY, 'D:\\Company\\P2', 'mid-admin')).toBe(false);
    const removed = await repo.unbindAll(KEY, 'mid-admin');
    expect(removed).toHaveLength(PROJECT_FOLDERS_PER_CHAT_MAX - 1);
    expect(await repo.list(KEY)).toEqual([]);
    expect(await repo.unbindAll(KEY, 'mid-admin')).toEqual([]);
    expect((await repo.list(OTHER)).map((row) => row.path)).toEqual(['D:\\Company\\Extra']);
  });

  it('audits bind, update, unbind, unbind-all and skipped mounts', async () => {
    await repo.recordSkipped(OTHER, 'D:\\Company\\Extra', 'missing');
    const rows = await audits();
    const actions = rows.map((row) => row.detail.action);
    expect(actions.filter((action) => action === 'bind')).toHaveLength(PROJECT_FOLDERS_PER_CHAT_MAX + 1);
    expect(actions).toEqual(expect.arrayContaining(['update', 'unbind', 'unbind_all', 'skipped']));
    expect(rows.find((row) => row.detail.action === 'skipped')).toMatchObject({ actor: 'system:agent-job', detail: { path: 'D:\\Company\\Extra' } });
    expect(rows.find((row) => row.detail.action === 'unbind_all')?.detail.paths).toHaveLength(PROJECT_FOLDERS_PER_CHAT_MAX - 1);
    expect(rows.find((row) => row.detail.action === 'bind')?.actor).toBe('mid-admin');
  });

  it('rejects an unknown mode at the database level', async () => {
    await expect(pool.query(
      "INSERT INTO agent_project_folders (account_id, chat_type, chat_id, path, mode, created_by) VALUES ('acc','group','g9','D:\\x','WRITE','a')")).rejects.toThrow();
  });
});

describe('project folder permissions', () => {
  it('registers both permissions with a DENY default and resolves the tool policy with no project folders', () => {
    expect(AGENT_PERMISSION_IDS).toEqual(expect.arrayContaining(['project_folder.read', 'project_folder.write']));
    expect(deriveToolPolicy({ principal: { kind: 'admin', userId: 'u' }, permissions: allPermissions('ALLOW') }).projectDirs).toEqual([]);
    expect(deriveToolPolicy({ principal: { kind: 'user', senderMid: 'u' }, permissions: allPermissions('DENY') }).projectDirs).toEqual([]);
  });
});
