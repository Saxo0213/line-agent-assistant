import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { WritableConversationKey } from '@line-agent/contracts';
import { AccountRepository, AgentRepository } from '../../../../../packages/database/src/index.js';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';

// Job folding (migration 099): messages that arrive while a turn runs are joined into the next claimed job.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const accountId = 'fold-account';
const BASE = Date.now() - 3_600_000;
const at = (seconds: number) => new Date(BASE + seconds * 1000);

database('agent job folding', () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;
  let agents: AgentRepository;
  let epoch = 0;
  let counter = 0;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    await new AccountRepository(pool).ensureAccount(accountId);
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [accountId]);
    epoch = Number((await pool.query('SELECT control_epoch FROM account_control WHERE singleton = true')).rows[0].control_epoch);
  });
  afterAll(async () => { await close?.(); });

  const chatKey = (chatId: string): WritableConversationKey => ({ accountId, chatType: 'direct', chatId });
  async function chat(): Promise<string> {
    const chatId = `chat-${++counter}-${randomUUID()}`;
    await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1,$2,$3,$4)', [accountId, 'direct', chatId, 'Fold']);
    await pool.query("INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ($1,'direct',$2,'claude','line')", [accountId, chatId]);
    return chatId;
  }
  async function job(chatId: string, input: { prompt: string; sender?: string; created: number; status?: string; completed?: number; provider?: string; generation?: number }): Promise<string> {
    const jobId = randomUUID();
    const messageId = `m-${jobId}`;
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1,$2,$3,$4,'direct',$5,'text',$6,'live',now(),'{}'::jsonb)`, [accountId, messageId, `ev-${messageId}`, chatId, input.sender ?? 'u1', input.prompt]);
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_sender_id, prompt, workspace_path,
         generation, creation_epoch, status, created_at, completed_at)
       VALUES ($1,$2,'direct',$3,$4,'line',$5,$6,$7,'C:\\trusted',$8,$9,$10,$11,$12)`,
      [jobId, accountId, chatId, input.provider ?? 'claude', messageId, input.sender ?? 'u1', input.prompt, input.generation ?? 0, epoch,
        input.status ?? 'queued', at(input.created), input.completed === undefined ? null : at(input.completed)]);
    return jobId;
  }
  const row = async (jobId: string) => (await pool.query('SELECT status, folded_into FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0] as { status: string; folded_into: string | null };

  it('rejects a self fold and clears the fold when the lead row is deleted', async () => {
    const chatId = await chat();
    const lead = await job(chatId, { prompt: 'lead', created: 1 });
    const follower = await job(chatId, { prompt: 'follower', created: 2 });
    await expect(pool.query('UPDATE agent_jobs SET folded_into = job_id WHERE job_id = $1', [lead])).rejects.toThrow(/agent_jobs_folded_into_not_self_check/);
    await pool.query('UPDATE agent_jobs SET folded_into = $1 WHERE job_id = $2', [lead, follower]);
    await pool.query('DELETE FROM agent_jobs WHERE job_id = $1', [lead]);
    expect((await row(follower)).folded_into).toBeNull();
  });

  it('folds only deferred-lead followers with the same sender, provider and generation, in creation order', async () => {
    const chatId = await chat();
    await job(chatId, { prompt: 'earlier turn', created: 0, status: 'completed', completed: 10 });
    const lead = await job(chatId, { prompt: 'lead', created: 5 });
    const first = await job(chatId, { prompt: 'first', created: 6 });
    const otherSender = await job(chatId, { prompt: 'other sender', created: 7, sender: 'u2' });
    const second = await job(chatId, { prompt: 'second', created: 8 });
    const otherProvider = await job(chatId, { prompt: 'other provider', created: 9, provider: 'codex' });
    const otherGeneration = await job(chatId, { prompt: 'other generation', created: 9, generation: 1 });
    const claimed = await agents.claimNext(chatKey(chatId));
    expect(claimed?.jobId).toBe(lead);
    expect(claimed?.foldedJobs?.map((item) => [item.jobId, item.prompt])).toEqual([[first, 'first'], [second, 'second']]);
    expect(claimed?.foldedJobs?.map((item) => item.sourceMessageId)).toEqual([`m-${first}`, `m-${second}`]);
    expect((await row(first)).folded_into).toBe(lead);
    expect((await row(second)).folded_into).toBe(lead);
    for (const other of [otherSender, otherProvider, otherGeneration]) expect((await row(other)).folded_into).toBeNull();
    // One turn runs at a time in a chat, and a folded row is never claimed.
    expect(await agents.claimNext(chatKey(chatId))).toBeNull();
  });

  it('folds nothing for the owner, a job that did not wait for another turn', async () => {
    const chatId = await chat();
    const owner = await job(chatId, { prompt: 'owner', created: 1 });
    const follower = await job(chatId, { prompt: 'follower', created: 2 });
    const claimed = await agents.claimNext(chatKey(chatId));
    expect(claimed?.jobId).toBe(owner);
    expect(claimed?.foldedJobs).toBeUndefined();
    expect((await row(follower)).folded_into).toBeNull();
  });

  it('never claims a queued job that is folded into another job', async () => {
    const chatId = await chat();
    const lead = await job(chatId, { prompt: 'lead', created: 1, status: 'completed', completed: 3 });
    const follower = await job(chatId, { prompt: 'follower', created: 2 });
    await pool.query('UPDATE agent_jobs SET folded_into = $1 WHERE job_id = $2', [lead, follower]);
    expect(await agents.claimNext(chatKey(chatId))).toBeNull();
    expect(await agents.listQueuedConversations()).not.toContainEqual(chatKey(chatId));
  });

  it('settles followers with the completed status and the lead text, and writes no delivery for them', async () => {
    const chatId = await chat();
    await job(chatId, { prompt: 'earlier turn', created: 0, status: 'completed', completed: 10 });
    const lead = await job(chatId, { prompt: 'lead', created: 5 });
    const first = await job(chatId, { prompt: 'first', created: 6 });
    const second = await job(chatId, { prompt: 'second', created: 7 });
    expect((await agents.claimNext(chatKey(chatId)))?.foldedJobs).toHaveLength(2);
    expect(await agents.settleFolded(lead)).toEqual([]);
    expect((await row(first)).status).toBe('queued');
    expect(await agents.completeJob(lead, 'one reply', ['one reply'], epoch)).not.toBeNull();
    const settled = await agents.settleFolded(lead);
    expect(settled.map((item) => item.jobId).sort()).toEqual([first, second].sort());
    expect(settled.every((item) => item.status === 'completed' && item.sourceType === 'line')).toBe(true);
    for (const follower of [first, second]) {
      expect((await row(follower)).status).toBe('completed');
      expect((await pool.query('SELECT final_text FROM agent_outputs WHERE job_id = $1', [follower])).rows).toEqual([{ final_text: 'one reply' }]);
      expect((await pool.query('SELECT count(*)::int AS n FROM agent_deliveries WHERE job_id = $1', [follower])).rows[0].n).toBe(0);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM agent_deliveries WHERE job_id = $1', [lead])).rows[0].n).toBe(1);
    expect(await agents.settleFolded(lead)).toEqual([]);
  });

  it('gives followers the failed status without outputs when the lead fails', async () => {
    const chatId = await chat();
    await job(chatId, { prompt: 'earlier turn', created: 0, status: 'completed', completed: 10 });
    const lead = await job(chatId, { prompt: 'lead', created: 5 });
    const follower = await job(chatId, { prompt: 'follower', created: 6 });
    await agents.claimNext(chatKey(chatId));
    await agents.failJob(lead);
    expect((await agents.settleFolded(lead)).map((item) => item.status)).toEqual(['failed']);
    expect((await row(follower)).status).toBe('failed');
    expect((await pool.query('SELECT 1 FROM agent_outputs WHERE job_id = $1', [follower])).rowCount).toBe(0);
  });

  it('cancels only the follower row when a follower is cancelled, and the lead keeps running', async () => {
    const chatId = await chat();
    await job(chatId, { prompt: 'earlier turn', created: 0, status: 'completed', completed: 10 });
    const lead = await job(chatId, { prompt: 'lead', created: 5 });
    const follower = await job(chatId, { prompt: 'follower', created: 6 });
    await agents.claimNext(chatKey(chatId));
    const cancelled = await agents.cancelJobForKey(chatKey(chatId), follower);
    expect(cancelled?.status).toBe('cancelled');
    expect(await row(follower)).toEqual({ status: 'cancelled', folded_into: null });
    expect((await row(lead)).status).toBe('running');
  });

  it('frees a follower of a lead that is retried', async () => {
    const chatId = await chat();
    const lead = await job(chatId, { prompt: 'lead', created: 1, status: 'failed', completed: 2 });
    const follower = await job(chatId, { prompt: 'follower', created: 3 });
    await pool.query('UPDATE agent_jobs SET folded_into = $1 WHERE job_id = $2', [lead, follower]);
    expect(await agents.retryJobForKey(chatKey(chatId), lead, 'C:\\trusted')).not.toBeNull();
    expect((await row(follower)).folded_into).toBeNull();
  });

  it('recovery frees followers of an unfinished lead and settles followers of an ended lead', async () => {
    const chatId = await chat();
    await job(chatId, { prompt: 'earlier turn', created: 0, status: 'completed', completed: 10 });
    const lead = await job(chatId, { prompt: 'lead', created: 5 });
    const follower = await job(chatId, { prompt: 'follower', created: 6 });
    expect((await agents.claimNext(chatKey(chatId)))?.foldedJobs).toHaveLength(1);
    const endedChat = await chat();
    const ended = await job(endedChat, { prompt: 'ended lead', created: 1, status: 'failed', completed: 2 });
    const stuck = await job(endedChat, { prompt: 'stuck', created: 3 });
    await pool.query('UPDATE agent_jobs SET folded_into = $1 WHERE job_id = $2', [ended, stuck]);
    await agents.recoverInterruptedState();
    expect((await row(lead)).status).toBe('interrupted');
    expect(await row(follower)).toEqual({ status: 'queued', folded_into: null });
    expect((await row(stuck)).status).toBe('failed');
  });
});
