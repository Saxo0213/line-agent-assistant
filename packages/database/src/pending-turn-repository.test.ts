import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PendingTurnRepository, routeKeyFor, type PendingFailureInput } from './pending-turn-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const LINEAGE = routeKeyFor({ accountId: null });

database('PendingTurnRepository (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let pending: PendingTurnRepository;

  async function job(): Promise<string> {
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation)
       VALUES ($1, 'claude', 'ui', $2, 'work', 'C:\\work', 0)`, [jobId, `pending-${jobId}`]);
    return jobId;
  }

  async function failure(text: string, overrides: Partial<PendingFailureInput> = {}): Promise<PendingFailureInput> {
    return { originJobId: await job(), lineageKey: LINEAGE, userText: text, provider: 'claude', sourceId: 'claude',
      hadToolActivity: false, hadEffectiveOutput: false, error: 'weekly limit', ...overrides };
  }

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    pending = new PendingTurnRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('rejects blank and oversized turns', async () => {
    expect(await pending.recordFailure(await failure(' '))).toBeNull();
    expect(await pending.recordFailure(await failure('x'.repeat(100_001)))).toBeNull();
    expect(await pending.recordFailure(await failure('x'.repeat(100_000)))).not.toBeNull();
  });

  it('gives a safe turn the status pending and an unsafe turn needs_confirmation', async () => {
    const safe = (await pending.recordFailure(await failure('safe turn')))!;
    expect(safe).toMatchObject({ status: 'pending', attemptCount: 0, attemptedSourceIds: ['claude'], originSourceId: 'claude', activeJobId: safe.originJobId });
    const tool = (await pending.recordFailure(await failure('tool turn', { hadToolActivity: true })))!;
    const output = (await pending.recordFailure(await failure('output turn', { hadEffectiveOutput: true })))!;
    expect(tool.status).toBe('needs_confirmation');
    expect(output.status).toBe('needs_confirmation');
    expect(await pending.claimSafe(tool.pendingId, 'codex')).toBeNull();
    expect(await pending.claimSafe(output.pendingId, 'codex')).toBeNull();
  });

  it('updates the row of a second failure of the same turn and redacts the error', async () => {
    const first = (await pending.recordFailure(await failure('second failure')))!;
    const claimed = (await pending.claimSafe(first.pendingId, 'codex'))!;
    expect(claimed.status).toBe('replaying');
    const continuation = await job();
    expect(await pending.bindActiveJob(first.pendingId, continuation)).toBe(true);
    const second = (await pending.recordFailure({ originJobId: continuation, lineageKey: LINEAGE, userText: 'second failure', provider: 'codex',
      sourceId: 'codex', hadToolActivity: true, hadEffectiveOutput: false, error: 'Authorization: Bearer secret-token-value' }))!;
    expect(second.pendingId).toBe(first.pendingId);
    expect(second).toMatchObject({ status: 'needs_confirmation', lastProvider: 'codex', lastSourceId: 'codex', originProvider: 'claude',
      hadToolActivity: true, attemptCount: 1, attemptedSourceIds: ['claude', 'codex'], activeJobId: continuation });
    expect(second.lastError).not.toContain('secret-token-value');
    expect((await pending.snapshot()).filter((row) => row.originJobId === first.originJobId)).toHaveLength(1);
    await expect(pending.recordFailure({ originJobId: first.originJobId, lineageKey: 'other', userText: 'second failure', provider: 'claude',
      sourceId: 'claude', hadToolActivity: false, hadEffectiveOutput: false, error: 'x' })).rejects.toThrow('lineage mismatch');
  });

  it('lets only one concurrent claim win', async () => {
    const row = (await pending.recordFailure(await failure('hello')))!;
    const results = await Promise.all([pending.claimSafe(row.pendingId, 'codex'), pending.claimSafe(row.pendingId, 'codex')]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await pending.get(row.pendingId))).toMatchObject({ status: 'replaying', attemptCount: 1 });
  });

  it('does not claim for a source that was already attempted', async () => {
    const row = (await pending.recordFailure(await failure('attempted source')))!;
    expect(await pending.claimSafe(row.pendingId, 'claude')).toBeNull();
    expect((await pending.get(row.pendingId))).toMatchObject({ status: 'pending', attemptCount: 0 });
    expect(await pending.claimSafe(row.pendingId, 'codex')).not.toBeNull();
  });

  it('loads a replaying turn as needs_confirmation and a pending turn as exhausted after a restart', async () => {
    const replaying = (await pending.recordFailure(await failure('restart replaying')))!;
    await pending.claimSafe(replaying.pendingId, 'codex');
    const waiting = (await pending.recordFailure(await failure('restart pending')))!;
    const counts = await pending.recoverAfterRestart();
    expect(counts.needsConfirmation).toBeGreaterThanOrEqual(1);
    expect(counts.exhausted).toBeGreaterThanOrEqual(1);
    expect((await pending.get(replaying.pendingId))?.status).toBe('needs_confirmation');
    expect((await pending.get(waiting.pendingId))?.status).toBe('exhausted');
    const recoverable = (await pending.recoverableSnapshot(100)).map((row) => row.pendingId);
    expect(recoverable).toContain(waiting.pendingId);
    expect(recoverable).not.toContain(replaying.pendingId);
    expect(await pending.recoverAfterRestart()).toEqual({ needsConfirmation: 0, exhausted: 0 });
  });

  it('keeps a safe exhausted turn recoverable and supersedes a resend of the same lineage', async () => {
    const lineage = routeKeyFor({ accountId: 'account-A', chatType: 'direct', chatId: 'supersede-chat' });
    const row = (await pending.recordFailure(await failure('hello  world', { lineageKey: lineage })))!;
    await pending.markExhausted(row.pendingId);
    expect((await pending.recoverableSnapshot(100)).map((item) => item.pendingId)).toContain(row.pendingId);
    await pending.requireConfirmation(row.pendingId, 'tool activity');
    expect((await pending.recoverableSnapshot(100)).map((item) => item.pendingId)).not.toContain(row.pendingId);
    expect(await pending.supersedeMatching(routeKeyFor({ accountId: 'account-A', chatType: 'direct', chatId: 'other-chat' }), 'hello world')).toBe(false);
    expect(await pending.supersedeMatching(lineage, 'hello world')).toBe(true);
    expect(await pending.get(row.pendingId)).toMatchObject({ status: 'superseded', lastError: 'tool activity' });
  });

  it('does not strand a turn when a fresh recovery arrives during the pending transition', async () => {
    const row = (await pending.recordFailure(await failure('recover race', { sourceId: 'recover-source' })))!;
    expect(await pending.noteSourceRecovery('recover-source')).toBe(1);
    await pending.markExhausted(row.pendingId);
    const recoverable = (await pending.recoverableSnapshot(1000)).find((item) => item.pendingId === row.pendingId);
    expect(recoverable?.attemptedSourceIds).toEqual([]);
  });

  it('keeps the hard attempt cap across repeated fresh recoveries', async () => {
    const input = await failure('bounded recoveries', { sourceId: 'cap-source' });
    const row = (await pending.recordFailure(input))!;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await pending.noteSourceRecovery('cap-source');
      expect(await pending.claimSafe(row.pendingId, 'cap-source')).not.toBeNull();
      const again = (await pending.recordFailure({ ...input, originJobId: input.originJobId }))!;
      expect(again.pendingId).toBe(row.pendingId);
      await pending.markExhausted(row.pendingId);
    }
    await pending.noteSourceRecovery('cap-source');
    expect(await pending.claimSafe(row.pendingId, 'cap-source')).toBeNull();
    expect((await pending.recoverableSnapshot(1000)).map((item) => item.pendingId)).not.toContain(row.pendingId);
    expect(await pending.get(row.pendingId)).toMatchObject({ attemptCount: 8, status: 'exhausted' });
  });

  it('separates the route keys of the room and of different chats', () => {
    const keys = [routeKeyFor({ accountId: null }), routeKeyFor({ accountId: 'a', chatType: 'direct', chatId: 'x' }),
      routeKeyFor({ accountId: 'a', chatType: 'direct', chatId: 'y' }), routeKeyFor({ accountId: 'b', chatType: 'direct', chatId: 'x' }),
      routeKeyFor({ accountId: 'a', chatType: 'group', chatId: 'x' })];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('["ui"]');
    expect(keys[1]).toBe('["line","a","direct","x"]');
    expect(() => routeKeyFor({ accountId: null, chatType: 'schedule' })).toThrow();
  });
});
