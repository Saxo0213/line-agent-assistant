import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { McpTokenRepository } from './mcp-token-repository.js';
import { MessageRepository } from './message-repository.js';
import { migrate } from './migrate.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const migrationName = '040_shared_agent_room.sql';

database('migration 040: one shared Agent room', () => {
  it('merges UI history from two accounts into one account-less room without losing a job, and keeps LINE rows', async () => {
    const sourceDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 'linejs-shared-agent-room-'));
    let close: (() => Promise<void>) | undefined;
    try {
      for (const name of await readdir(sourceDirectory)) {
        // 072 extends the constraints 040 creates, so it can only run after 040.
        if (name !== migrationName && !name.startsWith('072_') && /^\d+_.*\.sql$/.test(name)) await copyFile(join(sourceDirectory, name), join(directory, name));
      }
      const created = await createTestDatabase(directory);
      close = created.close;
      const pool = created.pool;
      const accounts = new AccountRepository(pool);
      await accounts.ensureAccount('room-A');
      await accounts.ensureAccount('room-B');
      const local = { chatType: 'direct', chatId: '__local_agent_room__' };
      const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), b2: randomUUID(), line: randomUUID() };
      const job = (jobId: string, accountId: string, requestId: string, status: string, at: string, generation = 0) => pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_request_id, prompt, workspace_path, generation, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'codex','ui',$5,$6,'C:\\work',$7,$8,$9,$9)`,
        [jobId, accountId, local.chatType, local.chatId, requestId, `prompt ${requestId}`, generation, status, at]);
      await pool.query(
        `INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type, external_session_id, generation, workspace_path, updated_at) VALUES
         ('room-A','direct','__local_agent_room__','codex','ui','session-a-codex',2,'C:\\work','2026-10-20T10:00:00Z'),
         ('room-A','direct','__local_agent_room__','claude','ui',NULL,0,NULL,'2026-10-20T10:00:00Z'),
         ('room-B','direct','__local_agent_room__','codex','ui','session-b-codex',5,'C:\\work','2026-10-20T09:00:00Z')`);
      await job(ids.a1, 'room-A', 'dup', 'completed', '2026-10-20T08:00:00Z');
      await job(ids.b1, 'room-B', 'dup', 'completed', '2026-10-20T08:30:00Z');
      await job(ids.a2, 'room-A', 'a-running', 'running', '2026-10-20T09:30:00Z', 2);
      await job(ids.b2, 'room-B', 'b-queued', 'queued', '2026-10-20T10:30:00Z', 5);
      await pool.query(`INSERT INTO agent_events (job_id, event) VALUES ($1, '{"type":"cancelled"}'::jsonb)`, [ids.a1]);
      await pool.query(`INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, 'kept answer')`, [ids.b1]);
      await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('room-A','group','g1')`);
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ('room-A','line-msg','line-event','g1','group','sender','text','hi','live',now(),'{}'::jsonb)`);
      await pool.query(`INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type, generation) VALUES ('room-A','group','g1','codex','line',3)`);
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
         VALUES ($1,'room-A','group','g1','codex','line','line-msg','p','C:\\work',3,0,'queued')`, [ids.line]);

      await migrate(pool);

      const ui = await pool.query(
        `SELECT job_id, account_id, chat_type, chat_id, status, source_request_id FROM agent_jobs WHERE source_type = 'ui' ORDER BY created_at, queue_position`);
      expect(ui.rows.map((row) => row.job_id)).toEqual([ids.a1, ids.b1, ids.a2, ids.b2]);
      expect(ui.rows.every((row) => row.account_id === null && row.chat_type === null && row.chat_id === null)).toBe(true);
      expect(ui.rows.map((row) => row.status)).toEqual(['completed', 'completed', 'interrupted', 'queued']);
      expect(new Set(ui.rows.map((row) => row.source_request_id)).size).toBe(4);
      expect((await pool.query('SELECT count(*) FROM agent_events WHERE job_id = $1', [ids.a1])).rows[0].count).toBe('1');
      expect((await pool.query('SELECT final_text FROM agent_outputs WHERE job_id = $1', [ids.b1])).rows[0].final_text).toBe('kept answer');

      const sessions = await pool.query(`SELECT provider, external_session_id, generation, account_id FROM agent_sessions WHERE source_type = 'ui' ORDER BY provider`);
      expect(sessions.rows).toEqual([
        { provider: 'claude', external_session_id: null, generation: 0, account_id: null },
        { provider: 'codex', external_session_id: 'session-a-codex', generation: 5, account_id: null },
      ]);

      expect((await pool.query(`SELECT account_id, chat_id, status FROM agent_jobs WHERE job_id = $1`, [ids.line])).rows[0])
        .toEqual({ account_id: 'room-A', chat_id: 'g1', status: 'queued' });
      expect((await pool.query(`SELECT generation FROM agent_sessions WHERE source_type = 'line'`)).rows).toEqual([{ generation: 3 }]);

      // The migrated room is immediately usable: the queued job from the other account is claimable account-less.
      const agents = new AgentRepository(pool);
      expect(await agents.listQueuedConversations(32)).toContainEqual(AGENT_ROOM_KEY);
      expect(await agents.claimNext(AGENT_ROOM_KEY)).toMatchObject({ jobId: ids.b2, sourceType: 'ui', accountId: null });
      await migrate(pool);
    } finally {
      await close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

database('shared Agent room repository', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let tokens: McpTokenRepository;
  let messages: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    tokens = new McpTokenRepository(pool);
    messages = new MessageRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  const request = (requestId: string, provider: 'codex' | 'claude' = 'codex') => ({ requestId, provider, prompt: `ask ${requestId}`, workspacePath: 'C:\\work' });

  it('rejects a NULL-account LINE job and an account-bearing UI job at the database', async () => {
    await expect(pool.query(
      `INSERT INTO agent_jobs (job_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch)
       VALUES ($1,'codex','line','m1','p','C:\\work',0,0)`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO agent_sessions (provider, source_type) VALUES ('codex','line')`)).rejects.toMatchObject({ code: '23514' });
    await new AccountRepository(pool).ensureAccount('check-account');
    await expect(pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_request_id, prompt, workspace_path, generation)
       VALUES ($1,'check-account','direct','__local_agent_room__','codex','ui','r1','p','C:\\work',0)`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot act on a LINE job through the room key: cancel, retry and events all miss, and the job stays unchanged', async () => {
    await new AccountRepository(pool).ensureAccount('bypass-account');
    await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('bypass-account','group','bypass-chat')`);
    await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, ingestion_source, occurred_at, raw)
      VALUES ('bypass-account','bm-run','be-run','bypass-chat','group','s','text','live',now(),'{}'::jsonb),
             ('bypass-account','bm-fail','be-fail','bypass-chat','group','s','text','live',now(),'{}'::jsonb)`);
    const runningId = randomUUID(); const failedId = randomUUID();
    for (const [jobId, messageId, status] of [[runningId, 'bm-run', 'running'], [failedId, 'bm-fail', 'failed']] as const) {
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
         VALUES ($1,'bypass-account','group','bypass-chat','codex','line',$2,'p','C:\\work',0,0,$3)`, [jobId, messageId, status]);
    }
    await pool.query(`INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ('bypass-account','group','bypass-chat','codex','line')`);
    await agents.appendEvent(runningId, { type: 'text_delta', text: 'line secret' });
    const statuses = async () => (await pool.query('SELECT job_id, status FROM agent_jobs WHERE job_id = ANY($1) ORDER BY status', [[runningId, failedId]])).rows;
    const before = await statuses();
    for (const jobId of [runningId, failedId]) {
      expect(await agents.cancelJobForKey(AGENT_ROOM_KEY, jobId)).toBeNull();
      expect(await agents.retryJobForKey(AGENT_ROOM_KEY, jobId, 'C:\\work')).toBeNull();
      expect(await agents.listJobEvents(AGENT_ROOM_KEY, jobId)).toEqual([]);
      expect(await agents.getJobForKey(AGENT_ROOM_KEY, jobId)).toBeNull();
    }
    expect(await statuses()).toEqual(before);
    expect(before.map((row) => row.status).sort()).toEqual(['failed', 'running']);
    // The reverse direction stays closed too: a room job is invisible to a LINE key.
    const roomJob = await agents.enqueueUiJob(request('bypass-room'));
    const lineKey = { accountId: 'bypass-account', chatType: 'group' as const, chatId: 'bypass-chat' };
    expect(await agents.cancelJobForKey(lineKey, roomJob.jobId)).toBeNull();
    expect(await agents.listJobEvents(lineKey, roomJob.jobId)).toEqual([]);
    await agents.cancelJobForKey(AGENT_ROOM_KEY, roomJob.jobId);
  });

  it('works with zero LINE accounts: enqueue, discover, claim, complete without delivery rows', async () => {
    await pool.query('DELETE FROM line_accounts');
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe('0');
    const queued = await agents.enqueueUiJob(request('zero-1'));
    expect(await agents.enqueueUiJob(request('zero-1'))).toEqual({ disposition: 'duplicate', jobId: queued.jobId });
    expect(await agents.listQueuedConversations(32)).toEqual([AGENT_ROOM_KEY]);
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed).toMatchObject({ jobId: queued.jobId, status: 'running', sourceType: 'ui', accountId: null, chatType: null, chatId: null, sourceRequestId: 'zero-1' });
    expect(await agents.listQueuedConversations(32)).toEqual([]);
    expect(await agents.completeJob(queued.jobId, 'done', ['done'], 0)).toMatchObject({ status: 'completed', sourceType: 'ui', accountId: null });
    expect(await agents.listDeliveries(queued.jobId)).toEqual([]);
    expect(await agents.listJobEvents(AGENT_ROOM_KEY, queued.jobId)).toEqual([]);
    await agents.appendEvent(queued.jobId, { type: 'text_delta', text: 'hello' });
    expect(await agents.listJobEvents(AGENT_ROOM_KEY, queued.jobId)).toEqual([{ type: 'text_delta', text: 'hello' }]);
    expect(await agents.listJobEvents({ accountId: 'x', chatType: 'direct', chatId: 'y' }, queued.jobId)).toEqual([]);
  });

  it('keeps a per-provider account-less session: bind, resume validation, and stale generation after reset', async () => {
    const first = await agents.enqueueUiJob(request('session-1'));
    expect(await agents.bindSession({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui', workspacePath: 'C:\\work', externalSessionId: 'room-session', generation: 0 })).toBe(true);
    expect(await agents.lookupSession({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui', workspacePath: 'C:\\work' }))
      .toEqual({ externalSessionId: 'room-session', generation: 0 });
    expect(await agents.lookupSession({ ...AGENT_ROOM_KEY, provider: 'claude', sourceType: 'ui', workspacePath: 'C:\\work' })).toBeNull();
    await agents.claimNext(AGENT_ROOM_KEY);
    const resume = { jobId: first.jobId, provider: 'codex' as const, source: { type: 'ui' as const, requestId: 'session-1' },
      prompt: 'p', workspacePath: 'C:\\work', resumeSessionId: 'room-session' };
    expect(await agents.validateResumeSession(resume)).toEqual({ status: 'valid' });
    expect(await agents.validateResumeSession({ ...resume, resumeSessionId: 'other' })).toEqual({ status: 'invalid' });
    expect(await agents.validateResumeSession({ ...resume, workspacePath: 'C:\\elsewhere' })).toEqual({ status: 'workspace_mismatch' });
    const reset = await agents.resetGeneration({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' });
    expect(reset).toMatchObject({ generation: 1, cancelledJobIds: [first.jobId] });
    expect(await agents.bindSession({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui', workspacePath: 'C:\\work', externalSessionId: 'stale', generation: 0 })).toBe(false);
    expect(await agents.lookupSession({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui', workspacePath: 'C:\\work' })).toBeNull();
  });

  it('recovers after a restart: a running room job becomes interrupted and can be retried; queued work is rediscovered', async () => {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE status IN ('queued','running')");
    const running = await agents.enqueueUiJob(request('restart-1', 'claude'));
    await agents.claimNext(AGENT_ROOM_KEY);
    const waiting = await agents.enqueueUiJob(request('restart-2', 'claude'));
    expect(await agents.listQueuedConversations(32)).toEqual([]); // one running room job blocks the head
    expect(await agents.recoverInterruptedState()).toMatchObject({ interruptedJobs: 1 });
    expect((await agents.getJob(running.jobId))?.status).toBe('interrupted');
    expect(await agents.listQueuedConversations(32)).toEqual([AGENT_ROOM_KEY]);
    expect(await agents.claimNext(AGENT_ROOM_KEY)).toMatchObject({ jobId: waiting.jobId });
    await agents.failJob(waiting.jobId);
    expect(await agents.retryJobForKey(AGENT_ROOM_KEY, running.jobId, 'C:\\work')).toMatchObject({ jobId: running.jobId, status: 'queued', sourceType: 'ui' });
    expect(await agents.listQueuedConversations(32)).toEqual([AGENT_ROOM_KEY]);
    expect(await agents.cancelJobForKey({ accountId: 'x', chatType: 'direct', chatId: 'y' }, running.jobId)).toBeNull();
    expect(await agents.cancelJobForKey(AGENT_ROOM_KEY, running.jobId)).toMatchObject({ status: 'cancelled', accountId: null });
  });

  it('gives an account-less UI job full MCP scope with only an EXTERNAL_MONITOR account (no AGENT account) and refuses forged contexts', async () => {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE status IN ('queued','running')");
    await pool.query('DELETE FROM line_accounts');
    await pool.query(`INSERT INTO line_accounts (account_id, display_name, product_role, mode) VALUES ('monitor-only','Primary Admin','PRIMARY_ADMIN','MONITOR_ONLY')`);
    await pool.query(`INSERT INTO line_account_sources (source_id, account_id, source_type, generation, identity_digest, verified_account_mid)
      VALUES ($1,'monitor-only','EXTERNAL_MONITOR',1,repeat('a',64),'monitor-mid')`, [randomUUID()]);
    await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ('monitor-only','group','imported-group','Imported')`);
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('monitor-only','imp-1','imp-event','imported-group','group','someone','text','imported budget note','live',now(),'{}'::jsonb)`);
    const enqueued = await agents.enqueueUiJob(request('mcp-1'));
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBe(enqueued.jobId);
    const context = { sourceType: 'job' as const, jobId: enqueued.jobId, generation: claimed!.generation, accountId: null };
    const rows = await tokens.executeForInternalAgent({
      context, toolName: 'query_target_messages',
      execute: async ({ client, authorizedAccountIds, principalId }) => {
        const found = await messages.queryTargetMessages({ accountIds: authorizedAccountIds, target: 'imported-group' }, client);
        return { data: { found, principalId, authorizedAccountIds }, resultCount: found.length };
      },
    });
    expect(rows.principalId).toBe('internal:ui');
    expect(rows.authorizedAccountIds).toEqual(['monitor-only']);
    expect(rows.found.map((row) => row.text)).toEqual(['imported budget note']);
    const run = (ctx: Parameters<McpTokenRepository['verifyInternalAgent']>[0]['context']) => tokens.verifyInternalAgent({ context: ctx });
    await expect(run({ ...context, accountId: 'monitor-only' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ ...context, generation: claimed!.generation + 1 })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    // A LINE job can never be minted without its account (the DB forbids it), and a LINE job still needs an exact account match.
    await new AccountRepository(pool).ensureAccount('line-account');
    await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('line-account','group','lg')`);
    await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, ingestion_source, occurred_at, raw)
      VALUES ('line-account','lm','le','lg','group','s','text','live',now(),'{}'::jsonb)`);
    const lineJob = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
       VALUES ($1,'line-account','group','lg','codex','line','lm','p','C:\\work',0,0,'running')`, [lineJob]);
    await expect(run({ sourceType: 'job', jobId: lineJob, generation: 0, accountId: null })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: lineJob, generation: 0, accountId: 'other' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });
});
