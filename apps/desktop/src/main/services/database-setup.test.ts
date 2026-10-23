import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSetupService } from './database-setup.js';

const connection = { host: 'localhost', port: 5432, username: 'postgres', password: 'p@ ss:/', ssl: 'disable' as const };

describe('DatabaseSetupService', () => {
  it('lists connectable databases without exposing credentials', async () => {
    const query = vi.fn(async () => ({ rows: [{ datname: 'line_agent' }, { datname: 'postgres' }] }));
    const end = vi.fn(async () => undefined);
    const service = new DatabaseSetupService({
      createPool: (url) => {
        expect(url).toBe('postgresql://postgres:p%40%20ss%3A%2F@localhost:5432/postgres?sslmode=disable');
        return { query, end };
      },
      migrate: vi.fn(), save: vi.fn(), ensureDirectory: vi.fn(), migrationDirectory: 'migrations',
    });
    await expect(service.listDatabases(connection)).resolves.toEqual(['line_agent', 'postgres']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_database'));
    expect(end).toHaveBeenCalledOnce();
  });

  it('returns the application-owned attachment folder before first setup', async () => {
    const service = new DatabaseSetupService({ createPool: vi.fn(), migrate: vi.fn(), save: vi.fn(), ensureDirectory: vi.fn(),
      migrationDirectory: 'migrations', load: async () => null, defaultAttachmentRoot: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\attachments',
      defaultAgentWorkspace: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\agent-workspace' });
    await expect(service.status()).resolves.toEqual({ configured: false,
      attachmentRoot: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\attachments',
      agentWorkspace: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\agent-workspace', connection: null });
  });

  it('creates only a validated database name and returns the refreshed list', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT')
      ? { rows: [{ datname: 'line_agent' }, { datname: 'postgres' }] } : { rows: [] });
    const service = new DatabaseSetupService({ createPool: () => ({ query, end: async () => undefined }),
      migrate: vi.fn(), save: vi.fn(), ensureDirectory: vi.fn(), migrationDirectory: 'migrations' });
    await expect(service.createDatabase(connection, 'line_agent')).resolves.toEqual(['line_agent', 'postgres']);
    expect(query).toHaveBeenCalledWith('CREATE DATABASE "line_agent"');
    await expect(service.createDatabase(connection, 'bad; DROP DATABASE postgres')).rejects.toThrow(/name/i);
  });

  it('migrates the selected database before saving encrypted bootstrap settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'database-setup-order-'));
    const pool = { query: vi.fn(async () => ({ rows: [{ ok: 1 }] })), end: vi.fn(async () => undefined) };
    const order: string[] = [];
    const service = new DatabaseSetupService({ createPool: () => pool,
      migrate: vi.fn(async () => { order.push('migrate'); }),
      save: vi.fn(async () => { order.push('save'); }),
      ensureDirectory: async (directory) => { await mkdir(directory, { recursive: true }); order.push('directory'); }, migrationDirectory: 'migrations' });
    try {
      const attachmentRoot = join(root, 'attachments'), agentWorkspace = join(root, 'agent-workspace');
      await service.saveConfiguration(connection, 'line_agent', attachmentRoot, agentWorkspace);
      expect(order).toEqual(['directory', 'directory', 'migrate', 'save']);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('app_settings'), [JSON.stringify(await realpath(agentWorkspace))]);
      expect(pool.end).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('creates the setup workspace, validates it, and persists its canonical identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'database-setup-workspace-'));
    try {
      const workspace = join(root, 'created-workspace');
      const expectedCanonical = await realpath(root).then((canonicalRoot) => join(canonicalRoot, 'created-workspace'));
      const order: string[] = [];
      const pool = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('INSERT INTO app_settings')) order.push(`workspace:${String(parameters?.[0])}`);
        return { rows: [{ ok: 1 }] };
      }), end: vi.fn(async () => undefined) };
      const service = new DatabaseSetupService({ createPool: () => pool, migrate: async () => { order.push('migrate'); },
        save: async () => { order.push('save'); }, ensureDirectory: async (directory) => { await mkdir(directory, { recursive: true }); order.push('directory'); },
        migrationDirectory: 'migrations' });

      await service.saveConfiguration(connection, 'line_agent', join(root, 'attachments'), workspace);

      expect(order).toEqual(['directory', 'directory', 'migrate', `workspace:${JSON.stringify(expectedCanonical)}`, 'save']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
