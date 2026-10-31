import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type InboundEnvelope } from '@line-agent/contracts';
import { AgentRepository, queuedConversationDiscoverySql } from './agent-repository.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { SettingsRepository } from './settings-repository.js';
import { ProviderQuotaRepository } from './provider-quota-repository.js';
import { createTestDatabase } from './test-database.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let sequence = 1000;
function envelope(chatId = 'agent-chat'): InboundEnvelope {
  const id = ++sequence;
  return { eventId: `event-${id}`, accountId: 'account-A', chatId, chatType: 'direct', senderId: 'sender', messageId: `message-${id}`, kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: `cursor-${id}` }, occurredAt: '2026-10-15T10:00:00.000Z', attachments: [], raw: {} };
}
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\work' };
let controlEpoch: number;

describe('AgentRepository status lookup deadlines', () => {
  it('enforces the five second total deadline starting before connection acquisition', async () => {
    vi.useFakeTimers();
    try {
      let resolveConnection!: (client: { query: (sql: string) => Promise<{ rows: never[] }>; release: (error?: Error | boolean) => void }) => void;
      const connection = new Promise<{ query: (sql: string) => Promise<{ rows: never[] }>; release: (error?: Error | boolean) => void }>((resolve) => { resolveConnection = resolve; });
      let releaseError: Error | boolean | undefined;
      const client = {
        async query(sql: string) {
          if (sql.startsWith('SELECT')) return new Promise<{ rows: never[] }>(() => undefined);
          return { rows: [] as never[] };
        },
        release(error?: Error | boolean) { releaseError = error; },
      };
      const repository = new AgentRepository({ connect: () => connection } as unknown as Pool);
      let settled = false;
      const request = repository.listLineJobStatus({ accountId: 'a', chatType: 'direct', chatId: 'chat' }, ['message'])
        .finally(() => { settled = true; });
      const observed = request.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1400);
      resolveConnection(client);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3599);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await observed).toMatchObject({ message: 'Agent status lookup timed out' });
      expect(releaseError).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

database('AgentRepository with PostgreSQL (set TEST_DATABASE_URL to run)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let settings: SettingsRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    settings = new SettingsRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('account-A');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'account-A'");
    controlEpoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl('account-A', controlEpoch);
  });
  afterAll(async () => { await close?.(); });

  it('returns exact monotonic revisions and limits status projection to the requested conversation', async () => {
    const first = envelope('revision-chat');
    const second = { ...envelope('revision-chat'), accountId: 'account-B', messageId: `other-${++sequence}` };
    await new AccountRepository(pool).ensureAccount('account-B');
    await messages.ingestAndRoute(first, { eligible: false });
    await messages.ingestAndRoute(second, { eligible: false });
    const firstJobId = randomUUID();
    await pool.query(`INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id,
      prompt, workspace_path, generation, creation_epoch) VALUES ($1,$2,$3,$4,'codex','line',$5,'work','C:\\work',0,$6)`,
    [firstJobId, first.accountId, first.chatType, first.chatId, first.messageId, controlEpoch]);
    await pool.query(`INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id,
      prompt, workspace_path, generation, creation_epoch) VALUES ($1,$2,$3,$4,'codex','line',$5,'work','C:\\work',0,$6)`,
    [randomUUID(), second.accountId, second.chatType, second.chatId, second.messageId, controlEpoch]);
    const key = { accountId: first.accountId, chatType: first.chatType, chatId: first.chatId };
    const before = await agents.listLineJobStatus(key, [first.messageId, second.messageId]);
    expect(before.map((item) => item.sourceMessageId)).toEqual([first.messageId]);
    const prior = before[0]!;
    expect(prior.revision).toMatch(/^\d{16,20}$/);
    const cancelled = await agents.cancelJobForKey(key, firstJobId);
    expect(cancelled?.revision).toMatch(/^\d{16,20}$/);
    expect(BigInt(cancelled!.revision)).toBeGreaterThan(BigInt(prior.revision));
    await expect(agents.listLineJobStatus(key, Array(226).fill(first.messageId))).rejects.toThrow('225');
  });

  it('removes timed-out status lookup waiters from a saturated application pool', async () => {
    const saturatedPool = createPool(process.env.TEST_DATABASE_URL);
    const acquired: string[] = [];
    saturatedPool.on('acquire', (client) => acquired.push(client.processID ? String(client.processID) : 'client'));
    const holders = await Promise.all(Array.from({ length: saturatedPool.options.max }, () => saturatedPool.connect()));
    const holdQueries = holders.map((client) => client.query('SELECT pg_sleep(2.2)').finally(() => client.release()));
    try {
      const repository = new AgentRepository(saturatedPool);
      const requests = [
        { accountId: 'account-A', chatType: 'group' as const, chatId: 'A' },
        { accountId: 'account-A', chatType: 'group' as const, chatId: 'B' },
        { accountId: 'account-A', chatType: 'group' as const, chatId: 'A' },
      ].map((key) => repository.listLineJobStatus(key, ['message']));
      await Promise.resolve();
      expect(saturatedPool.waitingCount).toBe(3);
      const results = await Promise.allSettled(requests);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(saturatedPool.waitingCount).toBe(0);
      await Promise.all(holdQueries);
      expect(acquired).toHaveLength(saturatedPool.options.max);
      expect(saturatedPool.waitingCount).toBe(0);
    } finally {
      await Promise.allSettled(holdQueries);
      await saturatedPool.end();
    }
  });

  it('invalidates pre-canonical workspace bindings during upgrade', async () => {
    const input=envelope('legacy-binding');await messages.ingestAndRoute(input,{eligible:false});
    const key={accountId:input.accountId,chatType:input.chatType,chatId:input.chatId,provider:'codex' as const,workspacePath:'C:\\alias'};
    await agents.bindSession({...key,externalSessionId:'legacy-alias',generation:0});
    await pool.query("DELETE FROM schema_migrations WHERE name='015_canonical_session_binding.sql'");
    await migrate(pool);
    expect(await agents.lookupSession(key)).toBeNull();
  });

  it('atomically rebinds explicit retries but leaves ineligible jobs unchanged', async () => {
    const input = envelope('workspace-retry'); await messages.ingestAndRoute(input, route);
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const job = await agents.claimNext(key); await agents.failJob(job!.jobId);
    expect(await agents.retryJobForKey(key, job!.jobId, 'C:\\new')).not.toBeNull();
    expect(await agents.getJob(job!.jobId)).toMatchObject({ status: 'queued', workspacePath: 'C:\\new', generation: 0 });
    expect(await agents.retryJobForKey(key, job!.jobId, 'C:\\other')).toBeNull();
    expect(await agents.getJob(job!.jobId)).toMatchObject({ status: 'queued', workspacePath: 'C:\\new' });
  });

  it.each(['codex','claude'] as const)('binds %s sessions to the exact workspace and rejects legacy unbound sessions', async provider => {
    const input = envelope(`workspace-session-${provider}`); await messages.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId, provider, workspacePath: 'C:\\a' };
    await agents.bindSession({ ...key, externalSessionId: 'session-a', generation: 0 });
    expect(await agents.lookupSession(key)).toMatchObject({ externalSessionId: 'session-a' });
    expect(await agents.lookupSession({ ...key, workspacePath: 'C:\\b' })).toBeNull();
    await pool.query('UPDATE agent_sessions SET workspace_path=NULL WHERE chat_id=$1', [input.chatId]);
    expect(await agents.lookupSession(key)).toBeNull();
  });

  it('binds sessions by provider and prevents stale generation rebinding after reset', async () => {
    const input = envelope('session-chat');
    await messages.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...key, provider: 'codex', externalSessionId: 'codex-1', generation: 0 })).toBe(true);
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...key, provider: 'claude', externalSessionId: 'claude-1', generation: 0 })).toBe(true);
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...key, provider: 'codex' })).toMatchObject({ externalSessionId: 'codex-1', generation: 0 });
    expect(await agents.resetGeneration({ ...key, provider: 'codex' })).toMatchObject({ generation: 1, cancelledJobIds: [] });
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...key, provider: 'codex' })).toBeNull();
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...key, provider: 'claude' })).toMatchObject({ externalSessionId: 'claude-1', generation: 0 });
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...key, provider: 'codex', externalSessionId: 'stale', generation: 0 })).toBe(false);
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...key, provider: 'codex', externalSessionId: 'codex-2', generation: 1 })).toBe(true);
  });

  it('rejects a first session binding that claims a future generation', async () => {
    const input = envelope('future-session-chat');
    await messages.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    expect(await agents.bindSession({ workspacePath: 'C:\\work', ...key, provider: 'codex', externalSessionId: 'future', generation: 5 })).toBe(false);
    expect(await agents.lookupSession({ workspacePath: 'C:\\work', ...key, provider: 'codex' })).toBeNull();
  });

  it('deduplicates UI source requests and captures the current session generation', async () => {
    const request = { requestId: 'ui-request-1', provider: 'claude' as const, prompt: 'explain', workspacePath: 'C:\\work' };
    const first = await agents.enqueueUiJob(request);
    const replay = await agents.enqueueUiJob(request);
    expect(first.disposition).toBe('inserted');
    expect(replay).toEqual({ disposition: 'duplicate', jobId: first.jobId });
    expect(await agents.resetGeneration({ ...AGENT_ROOM_KEY, provider: 'claude', sourceType: 'ui' })).toMatchObject({ generation: 1 });
    const next = await agents.enqueueUiJob({ ...request, requestId: 'ui-request-2' });
    const rows = await pool.query('SELECT generation, status FROM agent_jobs WHERE job_id = ANY($1)', [[first.jobId, next.jobId]]);
    expect(rows.rows).toEqual(expect.arrayContaining([{ generation: 0, status: 'cancelled' }, { generation: 1, status: 'queued' }]));
  });

  it('claims at most one running job per chat and resets old jobs', async () => {
    const first = envelope('claim-chat');
    const second = envelope('claim-chat');
    await messages.ingestAndRoute(first, route);
    await messages.ingestAndRoute(second, route);
    const key = { accountId: first.accountId, chatType: first.chatType, chatId: first.chatId };
    const claimed = await agents.claimNext(key);
    expect(claimed?.status).toBe('running');
    expect(claimed?.sourceMessageId).toBe(first.messageId);
    expect(await agents.claimNext(key)).toBeNull();
    expect(await agents.resetGeneration({ ...key, provider: 'codex' })).toMatchObject({ generation: 1 });
    const statuses = await pool.query('SELECT status FROM agent_jobs WHERE chat_id = $1 ORDER BY created_at', ['claim-chat']);
    expect(statuses.rows.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('lists bounded durable conversations for scheduler recovery and omits chats already running', async () => {
    await pool.query("UPDATE agent_jobs SET status='cancelled' WHERE status='queued'");
    const first = envelope('recover-first');
    const second = envelope('recover-second');
    const third = envelope('recover-third');
    await messages.ingestAndRoute(first, route);
    await messages.ingestAndRoute(second, route);
    await messages.ingestAndRoute(third, route);

    expect(await agents.listQueuedConversations(2)).toHaveLength(1);
    await agents.claimNext({ accountId: first.accountId, chatType: first.chatType, chatId: first.chatId });
    const queued = await agents.listQueuedConversations(256);
    expect(queued).toContainEqual({ accountId: second.accountId, chatType: second.chatType, chatId: second.chatId });
    expect(queued).not.toContainEqual({ accountId: first.accountId, chatType: first.chatType, chatId: first.chatId });
    expect(queued).toHaveLength(1);
    expect(await agents.listQueuedConversations(1)).toHaveLength(1);
  });

  it('discovers one FIFO queue head per queue (hot LINE account, shared Agent room) without a hot account hiding peers', async () => {
    await pool.query("UPDATE agent_jobs SET status='cancelled' WHERE status='queued'");
    const accountA = 'account-A';
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(`fair-b-${crypto.randomUUID()}`);
    await pool.query(
      `INSERT INTO conversations (account_id, chat_type, chat_id)
       SELECT $1, 'direct', 'hot-' || n::text FROM generate_series(1, 2000) n`, [accountA],
    );
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       SELECT $1, 'hot-message-' || n::text, 'hot-event-' || n::text, 'hot-' || n::text, 'direct', 'sender', 'text', 'work', 'live', now(), '{}'::jsonb
       FROM generate_series(1, 2000) n`, [accountA],
    );
    await pool.query(
      `INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type)
       SELECT $1, 'direct', 'hot-' || n::text, 'codex', 'line' FROM generate_series(1, 2000) n`, [accountA],
    );
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch)
       SELECT gen_random_uuid(), $1, 'direct', 'hot-' || n::text, 'codex', 'line', 'hot-message-' || n::text, 'work', 'C:\\trusted', 0, $2
       FROM generate_series(1, 2000) n ORDER BY n`, [accountA, controlEpoch],
    );
    await agents.enqueueUiJob({ requestId: 'room-fair-1', provider: 'codex', prompt: 'work', workspacePath: 'C:\\trusted' });

    const page = await agents.listQueuedConversations(32);
    expect(page).toEqual([
      { accountId: accountA, chatType: 'direct', chatId: 'hot-1' },
      AGENT_ROOM_KEY,
    ]);

    const explained = await pool.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queuedConversationDiscoverySql}`, [32],
    );
    const nodes: Record<string, any>[] = [];
    const visit = (node: Record<string, any>) => {
      nodes.push(node);
      for (const child of (node['Plans'] as Record<string, any>[] | undefined) ?? []) visit(child);
    };
    visit(explained.rows[0]!['QUERY PLAN'][0]!.Plan);
    expect(nodes.some((node) => node['Index Name'] === 'agent_jobs_account_queue_head_idx')).toBe(true);
    expect(nodes.some((node) => node['Node Type'] === 'Limit' && node['Actual Loops'] >= 2)).toBe(true);
    // 2,000 sequential enqueues take ~10 s alone and exceed the 15 s default when the suite runs in parallel.
  }, 90_000);

  it('only discovers line jobs for the active account at the current control epoch', async () => {
    await pool.query("UPDATE agent_jobs SET status='cancelled' WHERE status='queued'");
    const input = envelope('control-epoch-head');
    const { jobId } = await messages.ingestAndRoute(input, route);
    if (!jobId) throw new Error('expected routed line job');
    const conversation = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };

    expect(await agents.listQueuedConversations(32)).toContainEqual(conversation);
    await pool.query('UPDATE agent_jobs SET creation_epoch = creation_epoch + 1 WHERE job_id = $1', [jobId]);
    expect(await agents.listQueuedConversations(32)).not.toContainEqual(conversation);
    await pool.query('UPDATE agent_jobs SET creation_epoch = $2 WHERE job_id = $1', [jobId, controlEpoch]);
    await pool.query("UPDATE line_accounts SET mode='MONITOR_ONLY' WHERE account_id = $1", [input.accountId]);
    try {
      expect(await agents.listQueuedConversations(32)).not.toContainEqual(conversation);
    } finally {
      await pool.query("UPDATE line_accounts SET mode='ACTIVE_CONTROL' WHERE account_id = $1", [input.accountId]);
      await pool.query("UPDATE agent_jobs SET status='cancelled' WHERE job_id = $1", [jobId]);
    }
  });

  it('appends typed events and atomically completes a job with unique delivery segments', async () => {
    const input = envelope('delivery-chat');
    const { jobId } = await messages.ingestAndRoute(input, route);
    if (!jobId) throw new Error('expected job');
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    await agents.claimNext(key);
    await agents.appendEvent(jobId, { type: 'text_delta', text: 'part' });
    await agents.saveFinal(jobId, 'firstsecond');
    expect(await agents.createLineDelivery(jobId, controlEpoch, ['first', 'second'])).toBe(true);
    expect(await agents.createLineDelivery(jobId, controlEpoch, ['first', 'second'])).toBe(true);
    const state = await pool.query('SELECT (SELECT status FROM agent_jobs WHERE job_id = $1) AS status, (SELECT count(*) FROM agent_events WHERE job_id = $1) AS events, (SELECT count(*) FROM agent_deliveries WHERE job_id = $1) AS deliveries', [jobId]);
    expect(state.rows[0]).toEqual({ status: 'completed', events: '1', deliveries: '2' });
    const segments = await agents.listDeliveries(jobId);
    expect(segments.map((part) => [part.partIndex, part.status, part.text])).toEqual([[0, 'pending', 'first'], [1, 'pending', 'second']]);
    const claims = await Promise.all([agents.claimLineDelivery(jobId, 0, controlEpoch), agents.claimLineDelivery(jobId, 0, controlEpoch)]);
    expect(claims.filter((part) => part !== null)).toHaveLength(1);
    expect(claims.find((part) => part !== null)).toMatchObject({ jobId, partIndex: 0, text: 'first', idempotencyKey: `${jobId}:0`, status: 'sending' });
    expect(await agents.markDeliverySent(jobId, 0, 'line-message-1')).toBe(true);
    expect(await agents.markDeliverySent(jobId, 0, 'line-message-2')).toBe(false);
    expect(await agents.markDeliveryUnknown(jobId, 0)).toBe(false);
    expect((await agents.listDeliveries(jobId))[0]).toMatchObject({ status: 'sent', lineMessageId: 'line-message-1' });
    expect(await agents.claimLineDelivery(jobId, 1, controlEpoch)).toMatchObject({ partIndex: 1, status: 'sending', ...key });
    expect(await agents.markDeliveryUnknown(jobId, 1)).toBe(true);
    expect(await agents.markDeliveryUnknown(jobId, 1)).toBe(false);
    expect(await agents.markDeliverySent(jobId, 1, 'late-message')).toBe(false);
    expect(await agents.claimLineDelivery(jobId, 1, controlEpoch)).toBeNull();
  });

  it('refuses to claim a LINE delivery whose stored route disagrees with its job', async () => {
    const input = envelope('corrupt-delivery-route');
    const { jobId } = await messages.ingestAndRoute(input, route);
    if (!jobId) throw new Error('expected job');
    await agents.claimNext({ accountId: input.accountId, chatType: input.chatType, chatId: input.chatId });
    await agents.saveFinal(jobId, 'do not misroute');
    await agents.createLineDelivery(jobId, controlEpoch, ['do not misroute']);

    try {
      await pool.query('ALTER TABLE agent_deliveries DROP CONSTRAINT IF EXISTS agent_deliveries_job_route_fkey');
      await pool.query('ALTER TABLE agent_deliveries DISABLE TRIGGER agent_deliveries_job_route_trigger');
      await pool.query("UPDATE agent_deliveries SET account_id = 'other-account' WHERE job_id = $1", [jobId]);
      expect(await agents.claimLineDelivery(jobId, 0, controlEpoch)).toBeNull();
      expect((await agents.listDeliveries(jobId))[0]?.status).toBe('pending');
    } finally {
      await pool.query("UPDATE agent_deliveries d SET account_id = j.account_id FROM agent_jobs j WHERE d.job_id = j.job_id AND d.job_id = $1", [jobId]);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'agent_deliveries_job_route_fkey'
            AND conrelid = 'agent_deliveries'::regclass
        ) THEN
          ALTER TABLE agent_deliveries ADD CONSTRAINT agent_deliveries_job_route_fkey
            FOREIGN KEY (job_id, account_id, chat_type, chat_id, creation_epoch)
            REFERENCES agent_jobs (job_id, account_id, chat_type, chat_id, creation_epoch);
        END IF;
      END $$`);
      await pool.query('ALTER TABLE agent_deliveries ENABLE TRIGGER agent_deliveries_job_route_trigger');
      const restoredConstraint = await pool.query<{ count: string }>(
        `SELECT count(*) FROM pg_constraint
         WHERE conname = 'agent_deliveries_job_route_fkey'
           AND conrelid = 'agent_deliveries'::regclass`,
      );
      expect(restoredConstraint.rows[0]?.count).toBe('1');
    }
  });

  it('recovers running jobs as interrupted and sending segments as unknown', async () => {
    const input = envelope('recovery-chat');
    const { jobId } = await messages.ingestAndRoute(input, route);
    if (!jobId) throw new Error('expected job');
    await agents.claimNext({ accountId: input.accountId, chatType: input.chatType, chatId: input.chatId });
    const deliveryJob = await messages.ingestAndRoute(envelope('other-recovery-chat'), route);
    if (!deliveryJob.jobId) throw new Error('expected delivery job');
    const deliveryKey = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'other-recovery-chat' };
    await agents.claimNext(deliveryKey);
    await agents.saveFinal(deliveryJob.jobId, 'send me');
    await agents.createLineDelivery(deliveryJob.jobId, controlEpoch, ['send me']);
    await agents.claimLineDelivery(deliveryJob.jobId, 0, controlEpoch);
    await agents.recoverInterruptedState();
    const status = await pool.query('SELECT status FROM agent_jobs WHERE job_id = $1', [jobId]);
    expect(status.rows[0].status).toBe('interrupted');
    expect((await agents.listDeliveries(deliveryJob.jobId))[0]?.status).toBe('unknown');
  });

  it('persists conversation and non-secret app settings', async () => {
    const input = envelope('settings-chat');
    await messages.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    await settings.setConversationAgent({ ...key, enabled: true, provider: 'claude' });
    expect(await settings.getConversationAgent(key)).toEqual({ enabled: true, provider: 'claude' });
    // The override is optional: null follows the global default.
    expect(await settings.setConversationProvider(key, null)).toBe(true);
    expect(await settings.getConversationAgent(key)).toEqual({ enabled: true, provider: null });
    expect(await settings.setConversationProvider(key, 'codex')).toBe(true);
    expect(await settings.getConversationAgent(key)).toEqual({ enabled: true, provider: 'codex' });
    expect(await settings.setConversationProvider({ ...key, chatId: 'missing-chat' }, 'codex')).toBe(false);
    // Persona overrides: null follows the global value; each field is set and cleared on its own.
    expect(await settings.getConversationPersona(key)).toEqual({ description: null, liveliness: null });
    expect(await settings.setConversationPersona(key, { description: '溫柔簡短' })).toBe(true);
    expect(await settings.setConversationPersona(key, { liveliness: 'lively' })).toBe(true);
    expect(await settings.getConversationPersona(key)).toEqual({ description: '溫柔簡短', liveliness: 'lively' });
    expect(await settings.setConversationPersona(key, { description: null, liveliness: null })).toBe(true);
    expect(await settings.getConversationPersona(key)).toEqual({ description: null, liveliness: null });
    expect(await settings.setConversationPersona({ ...key, chatId: 'missing-chat' }, { liveliness: 'quiet' })).toBe(false);
    await expect(settings.setConversationPersona(key, { description: 'x'.repeat(501) })).rejects.toThrow();
    await settings.setAppSetting('agent_persona_description', '活潑');
    expect(await settings.getAppSetting('agent_persona_description')).toBe('活潑');
    await settings.setAppSetting('workspace_path', 'C:\\work');
    expect(await settings.getAppSetting('workspace_path')).toBe('C:\\work');
    await expect(settings.setAppSetting('line_token', 'secret')).rejects.toThrow('not allowed');
  });

  it('atomically accepts a consented cross-provider retry and preserves source uniqueness for later LINE admissions', async () => {
    const key={accountId:'account-A',chatType:'direct' as const,chatId:'quota-consent-chat'};
    const senderId='quota-admin-mid';
    const original={...envelope(key.chatId),senderId,messageId:`quota-original-${++sequence}`,text:'original work'};
    const confirm={...envelope(key.chatId),senderId,messageId:`quota-confirm-${++sequence}`,text:'/agent codex'};
    await messages.ingestAndRoute(original,{eligible:false});
    await messages.ingestAndRoute(confirm,{eligible:false});
    expect(await settings.setConversationProvider(key,'claude')).toBe(true);
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,agent_enabled,default_provider)
      VALUES('account-A','direct','quota-admin-chat','admin',true,'codex') ON CONFLICT(account_id,chat_type,chat_id) DO NOTHING`);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES('account-A','direct','quota-admin-chat',$1,'PRIMARY_ADMIN') ON CONFLICT DO NOTHING`,[senderId]);
    const senderGrantId=randomUUID();
    await pool.query(`INSERT INTO line_friend_whitelist_grants(grant_id,account_id,target_mid,capability,version,state)
      VALUES($1,'account-A',$2,'AGENT_USE',1,'ACTIVE')`,[senderGrantId,senderId]);
    await pool.query(`UPDATE line_accounts SET worker_instance_id='quota-worker',worker_binding_epoch=$2 WHERE account_id=$1`,['account-A',controlEpoch]);
    const originalJobId=randomUUID();
    await pool.query(`INSERT INTO agent_jobs(job_id,account_id,chat_type,chat_id,provider,source_type,source_message_id,source_sender_id,
      prompt,workspace_path,generation,status,creation_epoch,direct_friend_grant_id,direct_friend_grant_version)
      VALUES($1,$2,$3,$4,'claude','line',$5,$6,'original work','C:\\work',0,'failed',$7,$8,1)`,
      [originalJobId,key.accountId,key.chatType,key.chatId,original.messageId,senderId,controlEpoch,senderGrantId]);
    await pool.query(`INSERT INTO agent_events(job_id,event) VALUES($1,$2::jsonb)`,
      [originalJobId,JSON.stringify({type:'failed',code:'PROVIDER_LIMIT',message:'Claude limit',retryable:true})]);
    await pool.query(`INSERT INTO agent_events(job_id,event) VALUES($1,$2::jsonb)`,
      [originalJobId,JSON.stringify({type:'failed',code:'PROVIDER_LIMIT',message:'Claude retry limit',retryable:true})]);
    const quota=new ProviderQuotaRepository(pool);
    const noticeAuthority={jobId:originalJobId,accountId:key.accountId,workerInstanceId:'quota-worker',controlEpoch};
    expect(await quota.validateFailureNoticeAuthority(noticeAuthority)).toBe(true);
    await pool.query(`UPDATE line_friend_whitelist_grants SET state='REVOKED',revoked_at=now() WHERE grant_id=$1`,[senderGrantId]);
    expect(await quota.validateFailureNoticeAuthority(noticeAuthority)).toBe(false);
    await quota.skipNotice(originalJobId);
    expect((await pool.query<{notification_state:string}>('SELECT notification_state FROM provider_quota_notices WHERE job_id=$1',[originalJobId])).rows[0]?.notification_state).toBe('skipped');
    await pool.query(`UPDATE line_friend_whitelist_grants SET state='ACTIVE',revoked_at=NULL WHERE grant_id=$1`,[senderGrantId]);
    expect(await quota.validateFailureNoticeAuthority(noticeAuthority)).toBe(true);
    await pool.query('UPDATE account_control SET control_epoch=control_epoch+1 WHERE singleton=true');
    expect(await quota.validateFailureNoticeAuthority(noticeAuthority)).toBe(false);
    await pool.query('UPDATE account_control SET control_epoch=$1 WHERE singleton=true',[controlEpoch]);
    expect(await quota.validateFailureNoticeAuthority(noticeAuthority)).toBe(true);
    const queryAt=new Date().toISOString();
    await quota.saveSnapshot({provider:'claude',requestedAt:queryAt,fetchedAt:queryAt,stale:false,snapshot:{windows:[
      {label:'一般工作階段額度',usedPercent:0,blocksProvider:true,resetsAt:null},
      {label:'一般每週額度',usedPercent:60,blocksProvider:true,resetsAt:null},
      {label:'Fable 專用每週額度',usedPercent:57,blocksProvider:false,resetsAt:'2026-11-02T00:00:00Z'},
    ]}});
    expect((await quota.get('claude'))?.blocked).toBe(false);
    await quota.saveSnapshot({provider:'claude',requestedAt:new Date(Date.now()+5).toISOString(),fetchedAt:new Date(Date.now()+5).toISOString(),stale:false,
      snapshot:{windows:[{label:'一般工作階段額度',usedPercent:100,blocksProvider:true,resetsAt:'2026-11-01T00:00:00Z'},
        {label:'一般每週額度',usedPercent:100,blocksProvider:true,resetsAt:'2026-11-05T00:00:00Z'},
        {label:'Fable 專用每週額度',usedPercent:57,blocksProvider:false,resetsAt:'2026-11-03T00:00:00Z'}]}});
    expect(await quota.get('claude')).toMatchObject({blocked:true,recoveryAt:'2026-11-05T00:00:00.000Z'});
    await quota.saveSnapshot({provider:'claude',requestedAt:new Date(Date.now()+10).toISOString(),fetchedAt:new Date(Date.now()+10).toISOString(),stale:false,
      snapshot:{availabilityKnown:false,windows:[{label:'Fable 專用每週額度',usedPercent:57,blocksProvider:false,resetsAt:'2026-11-02T00:00:00Z'}]}});
    expect(await quota.get('claude')).toMatchObject({blocked:true,recoveryAt:'2026-11-05T00:00:00.000Z'});
    await quota.saveSnapshot({provider:'claude',requestedAt:new Date(Date.now()+15).toISOString(),fetchedAt:new Date(Date.now()+15).toISOString(),stale:false,
      snapshot:{availabilityKnown:true,windows:[{label:'一般工作階段額度',usedPercent:20,blocksProvider:true,resetsAt:null},
        {label:'一般每週額度',usedPercent:57,blocksProvider:true,resetsAt:null},
        {label:'Fable 專用每週額度',usedPercent:57,blocksProvider:false,resetsAt:'2026-11-02T00:00:00Z'}]}});
    expect(await quota.get('claude')).toMatchObject({blocked:false});
    const refusalAt=new Date(Date.now()-2_000).toISOString();
    await quota.recordFailure({provider:'codex',observedAt:refusalAt,recoveryAt:null,source:'test refusal',evidence:'limit'});
    await quota.saveSnapshot({provider:'codex',requestedAt:new Date(Date.now()-3_000).toISOString(),fetchedAt:new Date().toISOString(),stale:false,
      snapshot:{provider:'codex',windows:[{usedPercent:12,resetsAt:null}]}});
    expect((await quota.get('codex'))?.blocked).toBe(true);
    await quota.saveSnapshot({provider:'codex',requestedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),stale:true,
      snapshot:{provider:'codex',windows:[]}});
    expect((await quota.get('codex'))?.blocked).toBe(true);
    await quota.saveSnapshot({provider:'codex',requestedAt:new Date(Date.now()+5).toISOString(),fetchedAt:new Date(Date.now()+5).toISOString(),stale:false,
      snapshot:{provider:'codex',windows:[{usedPercent:12,resetsAt:null}]}});
    expect((await quota.get('codex'))?.blocked).toBe(false);
    await pool.query(`INSERT INTO provider_quota_state(provider,blocked,snapshot,snapshot_fetched_at,snapshot_stale)
      VALUES('codex',false,'{"availabilityKnown":true,"windows":[{"blocksProvider":true,"usedPercent":40}]}'::jsonb,now(),false)
      ON CONFLICT(provider) DO UPDATE SET blocked=false,snapshot='{"availabilityKnown":true,"windows":[{"blocksProvider":true,"usedPercent":40}]}'::jsonb,snapshot_fetched_at=now(),snapshot_stale=false`);
    expect(await quota.createProposal(originalJobId,'codex',new Date(Date.now()+60_000).toISOString())).toBe(true);
    expect(await quota.createProposal(originalJobId,'codex',new Date(Date.now()+60_000).toISOString())).toBe(true);
    await pool.query(`DELETE FROM account_administrators WHERE account_id='account-A' AND user_id=$1`,[senderId]);
    expect(await agents.acceptQuotaRetry({jobId:originalJobId,senderId,messageId:confirm.messageId,targetProvider:'codex',
      workerInstanceId:'quota-worker',controlEpoch})).toBeNull();
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES('account-A','direct','quota-admin-chat',$1,'PRIMARY_ADMIN')`,[senderId]);
    await quota.saveSnapshot({provider:'codex',requestedAt:new Date(Date.now()+10).toISOString(),fetchedAt:new Date(Date.now()+10).toISOString(),stale:false,
      snapshot:{availabilityKnown:false,windows:[{label:'Fable 專用每週額度',usedPercent:57,blocksProvider:false,resetsAt:'2026-11-02T00:00:00Z'}]}});
    expect(await agents.acceptQuotaRetry({jobId:originalJobId,senderId,messageId:confirm.messageId,targetProvider:'codex',
      workerInstanceId:'quota-worker',controlEpoch})).toBeNull();
    await quota.saveSnapshot({provider:'codex',requestedAt:new Date(Date.now()+15).toISOString(),fetchedAt:new Date(Date.now()+15).toISOString(),stale:false,
      snapshot:{availabilityKnown:true,windows:[{label:'一般工作階段額度',usedPercent:40,blocksProvider:true,resetsAt:null}]}});
    const accepted=await agents.acceptQuotaRetry({jobId:originalJobId,senderId,messageId:confirm.messageId,targetProvider:'codex',
      workerInstanceId:'quota-worker',controlEpoch});
    expect(accepted).toMatchObject({sourceType:'line',status:'queued',accountId:key.accountId,chatId:key.chatId});
    await quota.createNotice(accepted!.jobId);
    expect(await quota.claimNotice(accepted!.jobId)).toBe(true);
    expect(await quota.claimNotice(accepted!.jobId)).toBe(false);
    const retry=await pool.query<{provider:string;retry_of_job_id:string;source_message_id:string}>(
      'SELECT provider,retry_of_job_id,source_message_id FROM agent_jobs WHERE job_id=$1',[accepted!.jobId]);
    expect(retry.rows[0]).toMatchObject({provider:'codex',retry_of_job_id:originalJobId,source_message_id:original.messageId});
    expect((await pool.query<{status:string}>('SELECT status FROM agent_jobs WHERE job_id=$1',[originalJobId])).rows[0]?.status).toBe('failed');
    expect(await settings.getConversationAgent(key)).toEqual({enabled:false,provider:'codex'});
    expect(await agents.acceptQuotaRetry({jobId:originalJobId,senderId,messageId:confirm.messageId,targetProvider:'codex',
      workerInstanceId:'quota-worker',controlEpoch})).toBeNull();
    const admitted=await messages.ingestAndRoute({...envelope(key.chatId),messageId:`quota-following-${++sequence}`},route);
    expect(admitted.jobId).toBeTruthy();
  });
});
