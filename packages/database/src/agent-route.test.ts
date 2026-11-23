import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { AgentRepository, type SessionKey } from './agent-repository.js';
import { AccountRepository } from './account-repository.js';
import { AccountSourceRepository } from './account-source-repository.js';
import { routeKeyFor } from './pending-turn-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AgentRepository routes and continuations (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let controlEpoch: number;
  let sequence = 0;

  const chatKey = (chatId: string) => ({ accountId: 'account-A', chatType: 'direct' as const, chatId });
  const sessionKey = (chatId: string, provider: 'claude' | 'codex'): SessionKey => ({ ...chatKey(chatId), provider, sourceType: 'line' });

  async function lineJob(chatId: string, overrides: { status?: string; provider?: string; generation?: number; foldedInto?: string; prompt?: string;
    grantId?: string; senderId?: string } = {}): Promise<string> {
    sequence += 1;
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_sender_id, prompt, workspace_path,
         generation, status, creation_epoch, folded_into, direct_friend_grant_id, direct_friend_grant_version, created_at)
       VALUES ($1, 'account-A', 'direct', $2, $3, 'line', $4, $5, $6, 'C:\\work', $7, $8, $9, $10, $11, $12, now() + ($13 || ' seconds')::interval)`,
      [jobId, chatId, overrides.provider ?? 'claude', `route-message-${sequence}`, overrides.senderId ?? null, overrides.prompt ?? `prompt ${sequence}`,
        overrides.generation ?? 0, overrides.status ?? 'running', controlEpoch, overrides.foldedInto ?? null, overrides.grantId ?? null,
        overrides.grantId ? 1 : null, String(sequence)]);
    return jobId;
  }

  async function chat(chatId: string): Promise<void> {
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('account-A', 'direct', $1) ON CONFLICT DO NOTHING", [chatId]);
  }

  async function sessionRow(chatId: string, provider: string) {
    return (await pool.query<{ generation: number; external_session_id: string | null; account_source_id: string | null }>(
      `SELECT generation, external_session_id, account_source_id FROM agent_sessions
       WHERE account_id = 'account-A' AND chat_type = 'direct' AND chat_id = $1 AND provider = $2 AND source_type = 'line'`, [chatId, provider])).rows[0];
  }

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('account-A');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'account-A'");
    controlEpoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl('account-A', controlEpoch);
  });
  afterAll(async () => { await close?.(); });

  it('binds the session to the source and refreshes the route without a switch', async () => {
    await agents.enqueueUiJob({ requestId: 'route-ui-1', provider: 'claude', prompt: 'hello', workspacePath: 'C:\\work' });
    const claimed = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(claimed.sessionKey).toMatchObject({ provider: 'claude' });
    const applied = await agents.applyRoute({ jobId: claimed.jobId, sessionKey: claimed.sessionKey, sessionGeneration: claimed.sessionGeneration!,
      provider: 'claude', sourceId: 'claude' });
    expect(applied).toEqual({ switched: false, sessionKey: claimed.sessionKey, generation: claimed.sessionGeneration });
    expect((await pool.query("SELECT account_source_id FROM agent_sessions WHERE provider = 'claude' AND source_type = 'ui'")).rows[0].account_source_id).toBe('claude');
    expect(await agents.jobAccountSource(claimed.jobId)).toBe('claude');
    expect(await agents.getRoute(routeKeyFor(AGENT_ROOM_KEY))).toEqual({ provider: 'claude', sourceId: 'claude', generation: claimed.sessionGeneration,
      previousProvider: null, previousGeneration: null });
    // The same call again keeps the route.
    expect((await agents.applyRoute({ jobId: claimed.jobId, sessionKey: claimed.sessionKey, sessionGeneration: claimed.sessionGeneration!,
      provider: 'claude', sourceId: 'claude' })).switched).toBe(false);
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [claimed.jobId]);
  });

  it('switches the provider: new generation, cleared provider session, job and follower moved, route remembers the previous run', async () => {
    const chatId = 'route-provider-switch';
    await chat(chatId);
    const lead = await lineJob(chatId);
    const follower = await lineJob(chatId, { status: 'queued', foldedInto: lead });
    await agents.bindSession({ ...sessionKey(chatId, 'claude'), externalSessionId: 'ext-claude', workspacePath: 'C:\\work', generation: 0 });
    await agents.bindSession({ ...sessionKey(chatId, 'codex'), externalSessionId: 'ext-codex', workspacePath: 'C:\\work', generation: 0 });
    const applied = await agents.applyRoute({ jobId: lead, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'codex', sourceId: 'codex' });
    expect(applied).toEqual({ switched: true, sessionKey: sessionKey(chatId, 'codex'), generation: 1, previous: { provider: 'claude', generation: 0 } });
    expect(await sessionRow(chatId, 'codex')).toEqual({ generation: 1, external_session_id: null, account_source_id: 'codex' });
    expect((await sessionRow(chatId, 'claude'))).toMatchObject({ generation: 0, external_session_id: 'ext-claude' });
    for (const jobId of [lead, follower]) {
      expect((await pool.query('SELECT provider, generation, account_source_id FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0])
        .toEqual({ provider: 'codex', generation: 1, account_source_id: 'codex' });
    }
    expect(await agents.getRoute(routeKeyFor(chatKey(chatId)))).toEqual({ provider: 'codex', sourceId: 'codex', generation: 1,
      previousProvider: 'claude', previousGeneration: 0 });
  });

  it('keeps a route that the claimed provider does not match, and switches back only on a new decision', async () => {
    const chatId = 'route-repeat';
    await chat(chatId);
    const first = await lineJob(chatId);
    await agents.applyRoute({ jobId: first, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'codex', sourceId: 'codex' });
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [first]);
    // The next job is enqueued with the chat preference (claude), but the router picks codex again.
    const second = await lineJob(chatId);
    expect(await agents.applyRoute({ jobId: second, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'codex', sourceId: 'codex' }))
      .toEqual({ switched: false, sessionKey: sessionKey(chatId, 'codex'), generation: 1 });
    expect((await pool.query('SELECT provider, generation, account_source_id FROM agent_jobs WHERE job_id = $1', [second])).rows[0])
      .toEqual({ provider: 'codex', generation: 1, account_source_id: 'codex' });
    expect((await sessionRow(chatId, 'codex')).generation).toBe(1);
    expect(await agents.getRoute(routeKeyFor(chatKey(chatId)))).toMatchObject({ provider: 'codex', generation: 1, previousProvider: 'claude', previousGeneration: 0 });
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE job_id = $1", [second]);
    // After a recovery the router picks claude again: this is a switch with a new claude generation.
    const third = await lineJob(chatId);
    expect(await agents.applyRoute({ jobId: third, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'claude', sourceId: 'claude' }))
      .toEqual({ switched: true, sessionKey: sessionKey(chatId, 'claude'), generation: 1, previous: { provider: 'codex', generation: 1 } });
    expect(await agents.getRoute(routeKeyFor(chatKey(chatId)))).toEqual({ provider: 'claude', sourceId: 'claude', generation: 1,
      previousProvider: 'codex', previousGeneration: 1 });
  });

  it('switches the source inside one provider and starts a new generation', async () => {
    const chatId = 'route-source-switch';
    await chat(chatId);
    const managed = await new AccountSourceRepository(pool).add({ provider: 'claude', label: 'second claude' });
    const first = await lineJob(chatId);
    await agents.bindSession({ ...sessionKey(chatId, 'claude'), externalSessionId: 'ext-first', workspacePath: 'C:\\work', generation: 0 });
    expect(await agents.applyRoute({ jobId: first, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'claude', sourceId: 'claude' }))
      .toMatchObject({ switched: false, generation: 0 });
    await pool.query("UPDATE agent_jobs SET status = 'failed' WHERE job_id = $1", [first]);
    const second = await lineJob(chatId);
    const applied = await agents.applyRoute({ jobId: second, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'claude', sourceId: managed.sourceId });
    expect(applied).toEqual({ switched: true, sessionKey: sessionKey(chatId, 'claude'), generation: 1, previous: { provider: 'claude', generation: 0 } });
    expect(await sessionRow(chatId, 'claude')).toEqual({ generation: 1, external_session_id: null, account_source_id: managed.sourceId });
    expect(await agents.getRoute(routeKeyFor(chatKey(chatId)))).toEqual({ provider: 'claude', sourceId: managed.sourceId, generation: 1,
      previousProvider: 'claude', previousGeneration: 0 });
    // A stale claim generation is refused.
    await expect(agents.applyRoute({ jobId: second, sessionKey: sessionKey(chatId, 'claude'), sessionGeneration: 0, provider: 'claude', sourceId: 'claude' }))
      .rejects.toThrow('generation changed');
  });

  it('lists the earlier jobs of the previous provider and generation with `from`', async () => {
    const chatId = 'route-transcript';
    await chat(chatId);
    for (const [text, answer] of [['old one', 'old answer one'], ['old two', 'old answer two']] as const) {
      const jobId = await lineJob(chatId, { status: 'completed', prompt: text });
      await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [jobId, answer]);
    }
    const current = await lineJob(chatId, { provider: 'codex', generation: 1, prompt: 'new turn' });
    expect(await agents.listTranscriptEvents({ jobId: current, generation: 1 })).toEqual([]);
    expect(await agents.listTranscriptEvents({ jobId: current, generation: 1, from: { provider: 'claude', generation: 0 } })).toEqual([
      { role: 'user', text: 'old one' }, { role: 'assistant', text: 'old answer one' },
      { role: 'user', text: 'old two' }, { role: 'assistant', text: 'old answer two' },
    ]);
    expect(await agents.listTranscriptEvents({ jobId: current, generation: 1, from: { provider: 'claude', generation: 7 } })).toEqual([]);
  });

  describe('enqueueContinuation', () => {
    const workerId = 'route-worker';

    async function failedLineJob(chatId: string) {
      await chat(chatId);
      const senderId = `sender-${chatId}`;
      const grantId = randomUUID();
      await pool.query(`INSERT INTO line_friend_whitelist_grants (grant_id, account_id, target_mid, capability, version, state)
        VALUES ($1, 'account-A', $2, 'AGENT_USE', 1, 'ACTIVE')`, [grantId, senderId]);
      await pool.query('UPDATE line_accounts SET worker_instance_id = $2, worker_binding_epoch = $3 WHERE account_id = $1', ['account-A', workerId, controlEpoch]);
      return { jobId: await lineJob(chatId, { status: 'failed', grantId, senderId, prompt: 'original work' }), grantId, senderId };
    }

    it('copies the failed job into one queued continuation', async () => {
      const chatId = 'continuation-ok';
      const origin = await failedLineJob(chatId);
      const projection = await agents.enqueueContinuation({ originJobId: origin.jobId, prompt: 'continue work', workerInstanceId: workerId, controlEpoch });
      expect(projection).toMatchObject({ sourceType: 'line', status: 'queued', accountId: 'account-A', chatId });
      const copy = (await pool.query(
        `SELECT provider, prompt, retry_of_job_id, source_message_id, source_sender_id, workspace_path, creation_epoch::int AS creation_epoch,
           direct_friend_grant_id, direct_friend_grant_version::int AS direct_friend_grant_version, status FROM agent_jobs WHERE job_id = $1`, [projection!.jobId])).rows[0];
      const originRow = (await pool.query('SELECT source_message_id FROM agent_jobs WHERE job_id = $1', [origin.jobId])).rows[0];
      expect(copy).toEqual({ provider: 'claude', prompt: 'continue work', retry_of_job_id: origin.jobId, source_message_id: originRow.source_message_id,
        source_sender_id: origin.senderId, workspace_path: 'C:\\work', creation_epoch: controlEpoch, direct_friend_grant_id: origin.grantId,
        direct_friend_grant_version: 1, status: 'queued' });
      expect(await agents.enqueueContinuation({ originJobId: origin.jobId, prompt: 'again' })).toBeNull();
      // A UI job continues too, with its own request id.
      await agents.enqueueUiJob({ requestId: 'continuation-ui', provider: 'claude', prompt: 'ui work', workspacePath: 'C:\\work' });
      const uiJob = (await pool.query("SELECT job_id FROM agent_jobs WHERE source_request_id = 'continuation-ui'")).rows[0].job_id;
      await pool.query("UPDATE agent_jobs SET status = 'failed' WHERE job_id = $1", [uiJob]);
      expect(await agents.enqueueContinuation({ originJobId: uiJob, prompt: 'ui continue' })).toMatchObject({ sourceType: 'ui', status: 'queued' });
    });

    it('refuses a LINE continuation when the control epoch changed', async () => {
      const origin = await failedLineJob('continuation-epoch');
      await pool.query('UPDATE account_control SET control_epoch = control_epoch + 1 WHERE singleton = true');
      try {
        expect(await agents.enqueueContinuation({ originJobId: origin.jobId, prompt: 'continue' })).toBeNull();
        expect(await agents.enqueueContinuation({ originJobId: origin.jobId, prompt: 'continue', controlEpoch: controlEpoch + 1 })).toBeNull();
      } finally {
        await pool.query('UPDATE account_control SET control_epoch = $1 WHERE singleton = true', [controlEpoch]);
      }
      expect((await pool.query('SELECT 1 FROM agent_jobs WHERE retry_of_job_id = $1', [origin.jobId])).rowCount).toBe(0);
      expect(await agents.enqueueContinuation({ originJobId: origin.jobId, prompt: 'continue', controlEpoch })).not.toBeNull();
    });
  });
});
