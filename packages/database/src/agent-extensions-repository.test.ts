import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_MCP_SECRET_MASK, type AgentMcpServerInput } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { AgentExtensionsError, AgentExtensionsRepository, type SecretCodec } from './agent-extensions-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
/** Reversible, obviously not plaintext: proves the repository only ever stores what the codec returns. */
const codec: SecretCodec = {
  seal: async (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join('')}`,
  open: async (sealed) => {
    if (!sealed.startsWith('sealed:')) throw new Error('not sealed');
    return Buffer.from(sealed.slice(7).split('').reverse().join(''), 'base64').toString('utf8');
  },
};
const stdio: AgentMcpServerInput = { name: 'files', transport: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: 'sk-secret-1' }, headers: {}, enabled: true, providers: ['claude', 'codex'] };
const http: AgentMcpServerInput = { name: 'remote', transport: 'http', args: [], env: {}, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer top-secret' }, enabled: true, providers: ['claude'] };

database('Agent MCP extensions repository (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: AgentExtensionsRepository;

  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); repo = new AgentExtensionsRepository(pool, codec); });
  afterAll(async () => { await close(); });

  it('stores env and header values only as sealed text and returns masked values', async () => {
    const created = await repo.save(stdio);
    const remote = await repo.save(http);
    expect(created.env).toEqual({ API_KEY: AGENT_MCP_SECRET_MASK });
    expect(remote.headers).toEqual({ Authorization: AGENT_MCP_SECRET_MASK });
    const dump = JSON.stringify((await pool.query('SELECT * FROM agent_mcp_servers')).rows);
    expect(dump).not.toContain('sk-secret-1');
    expect(dump).not.toContain('top-secret');
    expect(dump).toContain('sealed:');
    expect(JSON.stringify(await repo.list())).not.toContain('secret');
  });

  it('keeps stored values on an empty edit, replaces non-empty ones and drops removed keys', async () => {
    const [files] = (await repo.list()).filter((server) => server.name === 'files');
    await repo.save({ ...stdio, id: files!.id, env: { API_KEY: '', EXTRA: 'second' }, enabled: true });
    let resolved = await repo.resolveForRun();
    expect(resolved?.servers.find((server) => server.name === 'files')?.env).toEqual({ API_KEY: 'sk-secret-1', EXTRA: 'second' });
    await repo.save({ ...stdio, id: files!.id, env: { API_KEY: 'sk-secret-2' } });
    resolved = await repo.resolveForRun();
    expect(resolved?.servers.find((server) => server.name === 'files')?.env).toEqual({ API_KEY: 'sk-secret-2' });
    await expect(repo.save({ ...stdio, id: files!.id, env: { NEVER_SET: '' } })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('enforces unique and reserved names and validates the definition', async () => {
    await expect(repo.save(stdio)).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    await expect(repo.save({ ...stdio, name: 'linejs' })).rejects.toBeInstanceOf(AgentExtensionsError);
    await expect(repo.save({ ...stdio, name: 'claude_ai_x' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(pool.query("INSERT INTO agent_mcp_servers (id, name, transport, command, source, providers) VALUES (gen_random_uuid(), 'claude_ai_db', 'stdio', 'x', 'manual', '[\"claude\"]')")).rejects.toThrow();
    await expect(pool.query("INSERT INTO agent_mcp_servers (id, name, transport, command, source, providers) VALUES (gen_random_uuid(), 'linejs', 'stdio', 'x', 'manual', '[\"claude\"]')")).rejects.toThrow();
  });

  it('resolves only enabled servers and toggles, deletes and reports missing rows', async () => {
    const list = await repo.list();
    const remote = list.find((server) => server.name === 'remote')!;
    expect(remote.source).toBe('manual');
    await repo.setEnabled(remote.id, false);
    expect((await repo.resolveForRun())?.servers.map((server) => server.name)).toEqual(['files']);
    await repo.delete(remote.id);
    await expect(repo.delete(remote.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.setEnabled(remote.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await repo.list()).map((server) => server.name)).toEqual(['files']);
  });

  it('skips a server whose secrets cannot be opened and keeps the others', async () => {
    await repo.save({ ...http, name: 'broken' });
    await pool.query("UPDATE agent_mcp_servers SET secrets_cipher = 'garbage' WHERE name = 'broken'");
    expect((await repo.resolveForRun())?.servers.map((server) => server.name)).toEqual(['files']);
    await pool.query("DELETE FROM agent_mcp_servers WHERE name = 'broken'");
  });

  it('stores the built-in tool additions and returns null when nothing is enabled', async () => {
    expect(await repo.getTools()).toEqual({ webSearch: false, webFetch: false, bash: false, fileRead: false, fileWrite: false });
    await repo.setTools({ webSearch: true, webFetch: false, bash: false, fileRead: false, fileWrite: false });
    expect((await repo.resolveForRun())?.tools.webSearch).toBe(true);
    await pool.query('DELETE FROM agent_mcp_servers');
    expect((await repo.resolveForRun())?.servers).toEqual([]);
    await repo.setTools({ webSearch: false, webFetch: false, bash: false, fileRead: false, fileWrite: false });
    expect(await repo.resolveForRun()).toBeNull();
  });

  it('limits the number of stored servers', async () => {
    for (let index = 0; index < 32; index += 1) await repo.save({ ...http, name: `s${index}` });
    await expect(repo.save({ ...http, name: 'one-too-many' })).rejects.toMatchObject({ code: 'LIMIT' });
  });
});
