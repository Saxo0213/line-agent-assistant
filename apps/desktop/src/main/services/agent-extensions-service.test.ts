import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentExtensionsRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentExtensionsService, AgentExtensionsServiceError, BackendSecretCodec } from './agent-extensions-service.js';
import type { SecretBackend } from './secret-store.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
/** XOR "protection": reversible and obviously not plaintext. */
const backend: SecretBackend = {
  protect: async (plain) => Uint8Array.from(plain, (byte) => byte ^ 0x5a),
  unprotect: async (cipher) => Uint8Array.from(cipher, (byte) => byte ^ 0x5a),
};

database('Agent extensions service (real database, fixture config files)', () => {
  let pool: Pool; let close: () => Promise<void>; let root: string; let service: AgentExtensionsService;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    root = await mkdtemp(join(tmpdir(), 'agent-extensions-service-'));
    await mkdir(join(root, 'Claude')); await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 's'], env: { API_KEY: 'sk-from-claude' } }, linejs: { command: 'x' } } }));
    await writeFile(join(root, 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { files: { command: 'node' }, remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer from-desktop' } } } }));
    await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.tomls]\ncommand = "node"\n[mcp_servers.tomls.env]\nTOKEN = "tok-toml"\n');
    service = new AgentExtensionsService(new AgentExtensionsRepository(pool, new BackendSecretCodec(backend)),
      () => ({ claudeCode: join(root, '.claude.json'), claudeDesktop: join(root, 'Claude', 'claude_desktop_config.json'), codex: join(root, '.codex', 'config.toml') }));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); await close(); });

  it('lists candidates with key names only', async () => {
    const listing = await service.listImportCandidates();
    expect(listing.sources.map((source) => [source.source, source.status])).toEqual([['claude-code', 'ok'], ['claude-desktop', 'ok'], ['codex', 'ok']]);
    const text = JSON.stringify(listing);
    for (const secret of ['sk-from-claude', 'from-desktop', 'tok-toml']) expect(text).not.toContain(secret);
    expect(listing.sources[0]!.candidates.find((entry) => entry.sourceName === 'files')).toMatchObject({ envKeys: ['API_KEY'], nameTaken: false });
    expect(listing.sources[0]!.candidates.find((entry) => entry.sourceName === 'linejs')?.issue).toBe('RESERVED_NAME');
  });

  it('imports the selection with encrypted secrets, skips clashes and leaves the source files untouched', async () => {
    const before = await readFile(join(root, '.claude.json'), 'utf8');
    const result = await service.importSelected([
      { source: 'claude-code', sourceName: 'files' }, { source: 'claude-desktop', sourceName: 'files' }, { source: 'claude-desktop', sourceName: 'remote' },
      { source: 'codex', sourceName: 'tomls' }, { source: 'claude-code', sourceName: 'linejs' }, { source: 'claude-code', sourceName: 'missing' },
    ]);
    expect(result.imported).toEqual(['files', 'remote', 'tomls']);
    expect(result.skipped).toEqual([
      { source: 'claude-desktop', sourceName: 'files', reason: 'NAME_TAKEN' },
      { source: 'claude-code', sourceName: 'linejs', reason: 'RESERVED_NAME' },
      { source: 'claude-code', sourceName: 'missing', reason: 'NOT_FOUND' },
    ]);
    expect(await readFile(join(root, '.claude.json'), 'utf8')).toBe(before);
    const state = await service.state();
    expect(state.servers.map((server) => [server.name, server.source])).toEqual([['files', 'claude-code'], ['remote', 'claude-desktop'], ['tomls', 'codex']]);
    const stored = JSON.stringify((await pool.query('SELECT * FROM agent_mcp_servers')).rows);
    for (const secret of ['sk-from-claude', 'from-desktop', 'tok-toml']) expect(stored).not.toContain(secret);
    expect(JSON.stringify(state)).not.toMatch(/sk-from-claude|from-desktop|tok-toml/);
    const again = await service.listImportCandidates();
    expect(again.sources[0]!.candidates.find((entry) => entry.sourceName === 'files')?.nameTaken).toBe(true);
  });

  it('resolves decrypted servers for an eligible run, honours enabled and keeps secrets on edits', async () => {
    const files = (await service.state()).servers.find((server) => server.name === 'files')!;
    const saved = await service.save({ id: files.id, name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 's'], env: { API_KEY: '' }, headers: {}, enabled: true, providers: ['claude'] });
    expect(saved.env).toEqual({ API_KEY: '********' });
    const resolved = await service.resolveForRun();
    expect(resolved?.servers.find((server) => server.name === 'files')).toMatchObject({ env: { API_KEY: 'sk-from-claude' }, providers: ['claude'] });
    await service.setEnabled(files.id, false);
    expect((await service.resolveForRun())?.servers.map((server) => server.name)).toEqual(['remote', 'tomls']);
  });

  it('reports repository errors as service errors', async () => {
    await expect(service.save({ name: 'remote', transport: 'http', args: [], env: {}, url: 'https://x.example', headers: {}, enabled: true, providers: ['claude'] }))
      .rejects.toBeInstanceOf(AgentExtensionsServiceError);
    await expect(service.delete('8f1b6f5e-6b0a-4c3a-9d49-2c2f5c9f9f10')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
