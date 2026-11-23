import { describe, expect, it } from 'vitest';
import { ProviderQuotaRepository } from './provider-quota-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const snapshotAt = (fetchedAt: Date, usedPercent: number) => ({
  fetchedAt: fetchedAt.toISOString(), stale: false, error: null, availabilityKnown: true,
  windows: [{ usedPercent, resetsAt: null, blocksProvider: true }],
});

database('provider quota repository (failover state)', () => {
  it('sets lastUsageFetchedAt to the failure time on a quota failure (D20) and ignores other failure classes', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new ProviderQuotaRepository(pool);
      const failedAt = new Date('2026-11-19T10:00:00Z');
      expect(await repo.recordQuotaFailure({ sourceId: 'claude', kind: 'transient_rate_limit', observedAt: failedAt.toISOString(), recoveryAt: null, evidence: 'HTTP 429' }))
        .toEqual({ blocked: false });
      expect(await repo.recordQuotaFailure({ sourceId: 'claude', kind: 'non_quota', observedAt: failedAt.toISOString(), recoveryAt: null, evidence: 'timeout' }))
        .toEqual({ blocked: false });
      expect((await repo.get('claude'))?.blocked).toBe(false);
      await repo.recordQuotaFailure({ sourceId: 'claude', kind: 'quota_exhausted', observedAt: failedAt.toISOString(), recoveryAt: '2026-11-19T15:00:00Z', evidence: 'Authorization: Bearer secret-value' });
      expect(await repo.get('claude')).toMatchObject({
        blocked: true, blockedAt: failedAt.toISOString(), lastUsageFetchedAt: failedAt.toISOString(), recoveryAt: '2026-11-19T15:00:00.000Z',
        failureKind: 'quota_exhausted', failureCount: 1, lastProbeAt: null, evidence: 'provider failure (sensitive details redacted)',
      });
      await repo.recordQuotaFailure({ sourceId: 'claude', kind: 'quota_exhausted', observedAt: '2026-11-19T11:00:00Z', recoveryAt: null, evidence: 'limit again' });
      expect((await repo.get('claude'))?.failureCount).toBe(2);
      expect((await repo.list()).find((row) => row.sourceId === 'claude')?.blocked).toBe(true);
    } finally { await close(); }
  });

  it('unblocks on newer usage below ninety percent and keeps the block on older usage', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new ProviderQuotaRepository(pool);
      const failedAt = new Date('2026-11-19T10:00:00Z');
      await repo.recordQuotaFailure({ sourceId: 'codex', kind: 'quota_exhausted', observedAt: failedAt.toISOString(), recoveryAt: null, evidence: 'limit' });
      const older = await repo.observe({ sourceId: 'codex', requestedAt: failedAt.toISOString(), now: new Date('2026-11-19T10:05:00Z'),
        snapshot: snapshotAt(new Date('2026-11-19T09:59:00Z'), 5) });
      expect(older).toEqual({ blocked: true, unblocked: false });
      const newer = await repo.observe({ sourceId: 'codex', requestedAt: failedAt.toISOString(), now: new Date('2026-11-19T10:05:00Z'),
        snapshot: snapshotAt(new Date('2026-11-19T10:01:00Z'), 89) });
      expect(newer).toEqual({ blocked: false, unblocked: true });
      expect(await repo.get('codex')).toMatchObject({ blocked: false, recoveryAt: null, evidence: null, lastUsageFetchedAt: '2026-11-19T10:01:00.000Z' });
      const again = await repo.observe({ sourceId: 'codex', requestedAt: failedAt.toISOString(), now: new Date('2026-11-19T10:06:00Z'),
        snapshot: snapshotAt(new Date('2026-11-19T10:02:00Z'), 99) });
      expect(again).toEqual({ blocked: false, unblocked: false });
    } finally { await close(); }
  });

  it('lets only one caller win a probe claim', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repo = new ProviderQuotaRepository(pool);
      const failedAt = new Date('2026-11-19T10:00:00Z');
      expect(await repo.claimProbe('claude', failedAt)).toBe(false);
      await repo.recordQuotaFailure({ sourceId: 'claude', kind: 'quota_exhausted', observedAt: failedAt.toISOString(), recoveryAt: '2026-11-19T10:10:00Z', evidence: 'limit' });
      expect(await repo.claimProbe('claude', new Date('2026-11-19T10:09:59Z'))).toBe(false);
      const due = new Date('2026-11-19T10:10:00Z');
      const results = await Promise.all([repo.claimProbe('claude', due), repo.claimProbe('claude', due), repo.claimProbe('claude', due)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await repo.get('claude'))?.lastProbeAt).toBe(due.toISOString());
      expect(await repo.claimProbe('claude', new Date('2026-11-19T10:14:59Z'))).toBe(false);
      expect(await repo.claimProbe('claude', new Date('2026-11-19T10:15:00Z'))).toBe(true);
    } finally { await close(); }
  });
});
