import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { AccountSourceRepository, normalizedFallbackOrder, effectiveDefaultId, type AccountSource } from './account-source-repository.js';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { ProviderQuotaRepository } from './provider-quota-repository.js';
import { createTestDatabase } from './test-database.js';
import { migrate } from './migrate.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function row(sourceId: string, provider: 'claude' | 'codex', createdAt: number, extra: Partial<AccountSource> = {}): AccountSource {
  return { sourceId, provider, kind: sourceId === provider ? 'system' : 'managed', label: sourceId, isDefault: false, fallbackEnabled: true,
    fallbackPosition: null, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString(), ...extra };
}
const systemRows = (): AccountSource[] => [row('claude', 'claude', 0), row('codex', 'codex', 0)];

describe('normalizedFallbackOrder (CliTalkAgent llm_sources.rs cases)', () => {
  it('lists each provider default first, then its other sources by creation order', () => {
    const rows = [...systemRows(), row('acct-claude-a', 'claude', 10), row('acct-claude-b', 'claude', 20, { isDefault: true }),
      row('acct-codex-a', 'codex', 30), row('acct-codex-b', 'codex', 40, { isDefault: true })];
    expect(normalizedFallbackOrder(rows)).toEqual(['acct-claude-b', 'claude', 'acct-claude-a', 'acct-codex-b', 'codex', 'acct-codex-a']);
  });

  it('keeps the explicit order, and drops disabled sources', () => {
    const rows = [...systemRows(), row('acct-a', 'claude', 1), row('acct-b', 'codex', 2, { fallbackPosition: 1 }),
      row('acct-off', 'claude', 3, { fallbackEnabled: false, fallbackPosition: 2 })];
    expect(normalizedFallbackOrder(rows)).toEqual(['acct-b', 'claude', 'acct-a', 'codex']);
  });

  it('removes a system source whose rotation is disabled', () => {
    const rows = [row('claude', 'claude', 0, { fallbackEnabled: false }), row('codex', 'codex', 0)];
    expect(normalizedFallbackOrder(rows)).toEqual(['codex']);
  });

  it('uses the system source when no explicit default exists', () => {
    expect(effectiveDefaultId(systemRows(), 'claude')).toBe('claude');
    expect(effectiveDefaultId([...systemRows(), row('acct-x', 'codex', 5, { isDefault: true })], 'codex')).toBe('acct-x');
  });
});

database('AccountSourceRepository (real database)', () => {
  it('has the two system rows after the migration', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const sources = await new AccountSourceRepository(pool).list();
      expect(sources.map((s) => [s.sourceId, s.provider, s.kind, s.label, s.isDefault, s.createdAt])).toEqual([
        ['claude', 'claude', 'system', 'Claude', false, '1970-01-01T00:00:00.000Z'],
        ['codex', 'codex', 'system', 'Codex', false, '1970-01-01T00:00:00.000Z'],
      ]);
    } finally { await close(); }
  });

  it('adds managed sources with a generated id and keeps one default per provider', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new AccountSourceRepository(pool);
      const a = await repo.add({ provider: 'claude', label: 'Work' });
      const b = await repo.add({ provider: 'claude', label: 'Home' });
      expect(a.sourceId).toMatch(/^acct-[0-9a-f]{10}$/);
      expect(a.kind).toBe('managed');
      await repo.setDefault('claude', a.sourceId);
      await repo.setDefault('claude', b.sourceId);
      expect((await repo.list()).filter((s) => s.provider === 'claude' && s.isDefault).map((s) => s.sourceId)).toEqual([b.sourceId]);
      await expect(repo.setDefault('codex', b.sourceId)).rejects.toMatchObject({ code: 'provider_mismatch' });
      await expect(pool.query('UPDATE agent_account_sources SET is_default = true WHERE source_id = $1', [a.sourceId])).rejects.toThrow();
      await repo.setDefault('claude', 'claude');
      expect((await repo.list()).some((s) => s.isDefault)).toBe(false);
      expect((await repo.effectiveDefault('claude')).sourceId).toBe('claude');
      await expect(repo.rename('claude', 'Other')).rejects.toMatchObject({ code: 'system_source' });
      expect((await repo.rename(a.sourceId, '  Office  ')).label).toBe('Office');
    } finally { await close(); }
  });

  it('refuses to remove a system source or a source with a running job, then clears sessions and cascades quota rows', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new AccountSourceRepository(pool);
      const quota = new ProviderQuotaRepository(pool);
      const source = await repo.add({ provider: 'codex', label: 'Spare' });
      await repo.setDefault('codex', source.sourceId);
      expect(await repo.remove('codex')).toBe('system');
      expect(await repo.remove('acct-missing')).toBe('not_found');
      await quota.recordQuotaFailure({ sourceId: source.sourceId, kind: 'quota_exhausted', observedAt: new Date().toISOString(), recoveryAt: null, evidence: 'limit' });
      expect(await quota.get(source.sourceId)).toMatchObject({ provider: 'codex', blocked: true });
      await pool.query("INSERT INTO agent_sessions (provider, source_type, external_session_id, account_source_id) VALUES ('codex','ui','ext-1',$1)", [source.sourceId]);
      const jobId = randomUUID();
      await pool.query(`INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, status, account_source_id)
        VALUES ($1,'codex','ui',$2,'work','C:\\work',0,'running',$3)`, [jobId, randomUUID(), source.sourceId]);
      expect(await repo.remove(source.sourceId)).toBe('in_use');
      await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [jobId]);
      expect(await repo.remove(source.sourceId)).toBe('removed');
      expect(await repo.get(source.sourceId)).toBeNull();
      expect((await repo.effectiveDefault('codex')).sourceId).toBe('codex');
      expect((await pool.query('SELECT account_source_id, external_session_id FROM agent_sessions')).rows).toEqual([{ account_source_id: null, external_session_id: null }]);
      expect((await pool.query('SELECT account_source_id FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0]).toEqual({ account_source_id: null });
      expect(await quota.get(source.sourceId)).toBeNull();
    } finally { await close(); }
  });

  it('moves a source inside its own provider and stores the whole order', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new AccountSourceRepository(pool);
      const a = await repo.add({ provider: 'claude', label: 'A' });
      const x = await repo.add({ provider: 'codex', label: 'X' });
      const b = await repo.add({ provider: 'claude', label: 'B' });
      const order = async () => normalizedFallbackOrder(await repo.list());
      expect(await order()).toEqual(['claude', a.sourceId, b.sourceId, 'codex', x.sourceId]);
      await repo.move(b.sourceId, 'up');
      expect(await order()).toEqual(['claude', b.sourceId, a.sourceId, 'codex', x.sourceId]);
      await repo.move('claude', 'down');
      expect(await order()).toEqual([b.sourceId, 'claude', a.sourceId, 'codex', x.sourceId]);
      await repo.move(x.sourceId, 'up');
      expect(await order()).toEqual([b.sourceId, 'claude', a.sourceId, x.sourceId, 'codex']);
      await repo.move(a.sourceId, 'down');
      expect((await repo.list()).filter((s) => s.fallbackPosition !== null)).toHaveLength(5);
      await repo.setFallbackEnabled(a.sourceId, false);
      expect(await order()).not.toContain(a.sourceId);
      await expect(repo.move(a.sourceId, 'up')).rejects.toMatchObject({ code: 'not_in_rotation' });
    } finally { await close(); }
  });

  it('binds a session to the effective default once and keeps it when the default changes', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new AccountSourceRepository(pool);
      const agents = new AgentRepository(pool);
      await pool.query("INSERT INTO agent_sessions (provider, source_type) VALUES ('codex','ui')");
      const key = { ...AGENT_ROOM_KEY, provider: 'codex' as const, sourceType: 'ui' as const };
      const generation = (await pool.query<{ generation: number }>("SELECT generation FROM agent_sessions WHERE provider='codex'")).rows[0]!.generation;
      expect(await agents.bindSessionAccountSource(key, generation)).toBe('codex');
      const source = await repo.add({ provider: 'codex', label: 'Spare' });
      await repo.setDefault('codex', source.sourceId);
      expect(await agents.bindSessionAccountSource(key, generation)).toBe('codex');
      await pool.query('UPDATE agent_sessions SET account_source_id = NULL');
      expect(await agents.bindSessionAccountSource(key, generation)).toBe(source.sourceId);
    } finally { await close(); }
  });
});

database('migration 101 backfill (real database)', () => {
  it('gives an old quota row source_id = provider and an old session with an external session account_source_id = provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-agent-migration-101-'));
    const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
    try {
      for (const name of (await readdir(migrations)).filter((n) => /^\d+_.*\.sql$/.test(n) && n < '101')) await cp(join(migrations, name), join(directory, name));
      const { pool, close } = await createTestDatabase(directory);
      try {
        await pool.query("INSERT INTO provider_quota_state(provider, blocked) VALUES ('claude', true)");
        await pool.query("INSERT INTO agent_sessions (provider, source_type, external_session_id) VALUES ('codex','ui','ext-9')");
        await pool.query("INSERT INTO agent_sessions (provider, source_type) VALUES ('claude','ui')");
        await migrate(pool);
        expect((await pool.query('SELECT source_id, provider, blocked FROM provider_quota_state')).rows).toEqual([{ source_id: 'claude', provider: 'claude', blocked: true }]);
        expect((await pool.query('SELECT provider, account_source_id FROM agent_sessions ORDER BY provider')).rows)
          .toEqual([{ provider: 'claude', account_source_id: null }, { provider: 'codex', account_source_id: 'codex' }]);
      } finally { await close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

database('migration 102 backfill (real database)', () => {
  it('clears chat preferences that the quota fallback wrote, keeps manual ones, and backfills blocked quota rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-agent-migration-102-'));
    const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
    try {
      for (const name of (await readdir(migrations)).filter((n) => /^\d+_.*\.sql$/.test(n) && n < '102')) await cp(join(migrations, name), join(directory, name));
      const { pool, close } = await createTestDatabase(directory);
      try {
        await new AccountRepository(pool).ensureAccount('account-A');
        const insertChat = (chatId: string, provider: string, from: string | null) => pool.query(
          `INSERT INTO conversations(account_id, chat_type, chat_id, title, default_provider, quota_fallback_from)
           VALUES ('account-A', 'direct', $1, $1, $2, $3)`, [chatId, provider, from]);
        await insertChat('fallback-chat', 'codex', 'claude');
        await insertChat('manual-chat', 'codex', null);
        await pool.query(`INSERT INTO provider_quota_state(source_id, provider, blocked, observed_at) VALUES ('claude', 'claude', true, '2026-11-01T00:00:00Z')`);
        await pool.query(`INSERT INTO provider_quota_state(source_id, provider, blocked) VALUES ('codex', 'codex', false)`);
        await migrate(pool);
        expect((await pool.query(`SELECT chat_id, default_provider FROM conversations WHERE chat_id IN ('fallback-chat', 'manual-chat') ORDER BY chat_id`)).rows)
          .toEqual([{ chat_id: 'fallback-chat', default_provider: null }, { chat_id: 'manual-chat', default_provider: 'codex' }]);
        expect((await pool.query(`SELECT source_id, blocked_at, failure_kind, failure_count FROM provider_quota_state ORDER BY source_id`)).rows).toEqual([
          { source_id: 'claude', blocked_at: new Date('2026-11-01T00:00:00Z'), failure_kind: 'quota_exhausted', failure_count: 1 },
          { source_id: 'codex', blocked_at: null, failure_kind: 'unknown', failure_count: 0 },
        ]);
      } finally { await close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
