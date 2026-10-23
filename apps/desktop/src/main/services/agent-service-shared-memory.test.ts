import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type AgentEvent, type AgentRunRequest, type InboundEnvelope, type WritableConversationKey } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AdminRepository, AgentRepository, MessageRepository } from '../../../../../packages/database/src/index.js';
import { newAgentService } from './agent-service-test-support.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const AGENT = 'agent-acct';
const ADMIN_MID = 'mid-admin';
const WORKSPACE = 'C:\\trusted';
const adminKey: WritableConversationKey = { accountId: AGENT, chatType: 'direct', chatId: ADMIN_MID };
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: WORKSPACE };
let sequence = 0;
function envelope(chatType: 'direct' | 'group', chatId: string, senderId: string): InboundEnvelope {
  const id = ++sequence;
  return { eventId: `svc-event-${id}`, accountId: AGENT, chatId, chatType, senderId, messageId: `svc-message-${id}`, kind: 'text', text: 'work',
    mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: `svc-cursor-${id}` },
    occurredAt: '2026-10-20T10:00:00.000Z', attachments: [], raw: {} };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await tick(); }
  throw new Error('Timed out waiting for service state');
}

database('AgentService: the Agent room shares the admin direct chat memory', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let admin: AdminRepository;
  let requests: AgentRunRequest[];
  let overlap: { current: number; max: number };
  let sessionCounter = 0;
  let gate: Promise<void> | undefined;
  const cancelled: string[] = [];

  /** A provider that records each request, validates resume like the real bridge, and reports a new session id per run. */
  const bridge = {
    async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
      requests.push(request);
      overlap.current += 1; overlap.max = Math.max(overlap.max, overlap.current);
      try {
        if (request.resumeSessionId) {
          const validation = await agents.validateResumeSession(request);
          if (validation.status === 'invalid') { yield { type: 'failed', code: 'INVALID_SESSION', message: 'invalid', retryable: false }; return; }
        }
        if (gate) await gate;
        else await tick();
        yield { type: 'started', externalSessionId: `session-${++sessionCounter}`, workspacePath: request.workspacePath };
        yield { type: 'completed', finalText: 'ok' };
      } finally { overlap.current -= 1; }
    },
    async cancel(jobId: string) { cancelled.push(jobId); },
  };
  const services: Array<ReturnType<typeof newAgentService>> = [];
  const service = () => { const created = newAgentService(agents, { current: async () => WORKSPACE }, bridge); services.push(created); return created; };
  /** Kicks the given queues until every job is terminal (a blocked or slot-limited queue is re-kicked after the other finishes). */
  const settle = async (svc: ReturnType<typeof service>, keys: Array<WritableConversationKey | typeof AGENT_ROOM_KEY>, jobIds: string[]) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      for (const key of keys) svc.kick(key);
      await svc.idle();
      const states = await Promise.all(jobIds.map((jobId) => agents.getJob(jobId)));
      if (states.every((job) => job && !['queued', 'running'].includes(job.status))) return;
      await tick();
    }
    throw new Error('Jobs did not settle');
  };
  const setBinding = async (bound: boolean) => {
    await pool.query('DELETE FROM account_administrators WHERE account_id = $1', [AGENT]);
    if (bound) await admin.bindPrimary(AGENT, ADMIN_MID, ADMIN_MID);
  };
  const adminSession = async (provider: 'codex' | 'claude' = 'codex') => (await pool.query<{ external_session_id: string | null; generation: number }>(
    "SELECT external_session_id, generation FROM agent_sessions WHERE account_id = $1 AND chat_id = $2 AND provider = $3 AND source_type = 'line'",
    [AGENT, ADMIN_MID, provider])).rows[0];
  const roomSession = async (provider: 'codex' | 'claude' = 'codex') => (await pool.query<{ external_session_id: string | null }>(
    "SELECT external_session_id FROM agent_sessions WHERE provider = $1 AND source_type = 'ui'", [provider])).rows[0];

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool); messages = new MessageRepository(pool); admin = new AdminRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(AGENT);
    await accounts.setOwnMid(AGENT, 'mid-bot');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [AGENT]);
    await accounts.activateControl(AGENT, (await accounts.getControlState()).controlEpoch);
    for (const [chatType, chatId] of [['direct', ADMIN_MID], ['direct', 'mid-friend'], ['group', 'g1']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [AGENT, chatType, chatId]);
    }
  });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE status IN ('queued','running')");
    await pool.query('DELETE FROM agent_sessions');
    await setBinding(true);
    requests = []; overlap = { current: 0, max: 0 }; gate = undefined; cancelled.length = 0; sessionCounter = 0;
  });
  afterEach(async () => { await Promise.allSettled(services.splice(0).map((svc) => svc.shutdown())); });

  const lineJob = async (chatType: 'direct' | 'group', chatId: string, senderId: string) => {
    const result = await messages.ingestAndRoute(envelope(chatType, chatId, senderId), route);
    if (!result.jobId) throw new Error('expected a routed LINE job');
    return result.jobId;
  };
  const room = async (svc: ReturnType<typeof service>, requestId: string, provider: 'codex' | 'claude' = 'codex') => {
    const result = await svc.submitFromUi({ provider, requestId, prompt: `ask ${requestId}` });
    await svc.idle();
    return result;
  };

  it('resumes the admin direct chat session from the room and the room session from the admin chat (rows 1, 7)', async () => {
    const svc = service();
    const first = await room(svc, 'fact-1');
    expect((await agents.getJob(first.jobId))?.status).toBe('completed');
    expect(requests[0]!.resumeSessionId).toBeUndefined();
    expect(await roomSession()).toBeUndefined();
    const stored = (await adminSession())!.external_session_id;
    expect(stored).toBe('session-1');

    // LINE -> resumes what the room wrote.
    const lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
    svc.kick(adminKey); await svc.idle();
    expect((await agents.getJob(lineId))?.status).toBe('completed');
    expect(requests[1]!.resumeSessionId).toBe('session-1');
    expect((await adminSession())!.external_session_id).toBe('session-2');

    // room -> resumes what LINE wrote.
    await room(svc, 'fact-2');
    expect(requests[2]!.resumeSessionId).toBe('session-2');

    // Memory is per provider: the room's Claude has nothing to resume yet and writes its own admin-direct row.
    await room(svc, 'fact-3', 'claude');
    expect(requests[3]).toMatchObject({ provider: 'claude' });
    expect(requests[3]!.resumeSessionId).toBeUndefined();
    expect((await adminSession('claude'))!.external_session_id).toBe('session-4');
    expect((await adminSession('codex'))!.external_session_id).toBe('session-3');
  });

  it('uses the room\'s own session without an admin binding (row 2) and when the Agent is paused', async () => {
    await setBinding(false);
    const svc = service();
    await room(svc, 'own-1');
    await room(svc, 'own-2');
    expect(requests[1]!.resumeSessionId).toBe('session-1');
    expect((await roomSession())!.external_session_id).toBe('session-2');
    expect(await adminSession()).toBeUndefined();

    await setBinding(true);
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = $1", [AGENT]);
    try {
      await room(svc, 'own-3');
      expect(requests[2]!.resumeSessionId).toBe('session-2');
      expect(await adminSession()).toBeUndefined();
    } finally {
      await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [AGENT]);
    }
  });

  it('runs a job queued before the binding existed without resume, does not fail, and binds the new target (row 3)', async () => {
    await setBinding(false);
    const queued = await agents.enqueueUiJob({ provider: 'codex', requestId: 'queued-early', prompt: 'ask', workspacePath: WORKSPACE });
    // The admin chat already has its own memory at another generation; the room job must not inherit or fail on it.
    await pool.query("INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type, generation, external_session_id, workspace_path) VALUES ($1,'direct',$2,'codex','line',3,'admin-memory',$3)",
      [AGENT, ADMIN_MID, WORKSPACE]);
    await setBinding(true);
    const svc = service();
    svc.kick(AGENT_ROOM_KEY); await svc.idle();
    expect((await agents.getJob(queued.jobId))?.status).toBe('completed');
    expect(requests[0]!.resumeSessionId).toBeUndefined();
    expect(await adminSession()).toEqual({ external_session_id: 'session-1', generation: 3 });
    expect((await roomSession())?.external_session_id ?? null).toBeNull();
  });

  it('ends the room context when /new is sent in the admin direct chat, cancelling the running room process (row 4)', async () => {
    const svc = service();
    await room(svc, 'before-new');
    expect((await adminSession())!.external_session_id).toBe('session-1');

    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const running = await svc.submitFromUi({ provider: 'codex', requestId: 'running-when-new', prompt: 'long' });
    await until(() => overlap.current === 1);

    const command = envelope('direct', ADMIN_MID, ADMIN_MID);
    await messages.ingestAndRoute({ ...command, text: '/new' }, { eligible: false });
    await pool.query("INSERT INTO message_routes (account_id, message_id, action, creation_epoch) VALUES ($1,$2,'new',(SELECT control_epoch FROM account_control))", [AGENT, command.messageId]);
    const reset = svc.resetChat(adminKey, command.messageId);
    await until(() => cancelled.includes(running.jobId));
    release(); await reset; await svc.idle();
    expect((await agents.getJob(running.jobId))?.status).toBe('cancelled');
    expect((await adminSession())).toEqual({ external_session_id: null, generation: 1 });

    gate = undefined;
    await room(svc, 'after-new');
    expect(requests.at(-1)!.resumeSessionId).toBeUndefined();
    expect((await adminSession())!.generation).toBe(1);
  });

  it('never overlaps a room job with an admin-direct LINE job (row 5)', async () => {
    const svc = service();
    for (const lineFirst of [true, false]) {
      overlap.max = 0;
      let lineId = '';
      if (lineFirst) lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
      const queued = await agents.enqueueUiJob({ provider: 'codex', requestId: `overlap-${lineFirst}`, prompt: 'ask', workspacePath: WORKSPACE });
      if (!lineFirst) lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
      await settle(svc, [AGENT_ROOM_KEY, adminKey], [queued.jobId, lineId]);
      expect((await agents.getJob(queued.jobId))?.status).toBe('completed');
      expect((await agents.getJob(lineId))?.status).toBe('completed');
      expect(overlap.max).toBe(1);
    }
  });

  it('keeps group and whitelisted-user jobs out of the shared session (row 6)', async () => {
    const svc = service();
    await room(svc, 'secret');
    const groupId = await lineJob('group', 'g1', 'mid-friend');
    const friendId = await lineJob('direct', 'mid-friend', 'mid-friend');
    await settle(svc, [{ accountId: AGENT, chatType: 'group', chatId: 'g1' }, { accountId: AGENT, chatType: 'direct', chatId: 'mid-friend' }], [groupId, friendId]);
    for (const jobId of [groupId, friendId]) expect((await agents.getJob(jobId))?.status).toBe('completed');
    const lineRequests = requests.slice(1);
    expect(lineRequests).toHaveLength(2);
    expect(lineRequests.every((request) => request.resumeSessionId === undefined)).toBe(true);
    expect((await adminSession())!.external_session_id).toBe('session-1');
    const rows = await pool.query("SELECT chat_id, external_session_id FROM agent_sessions WHERE source_type = 'line' AND chat_id <> $1 ORDER BY chat_id", [ADMIN_MID]);
    expect(rows.rows.map((row) => row.chat_id)).toEqual(['g1', 'mid-friend']);
  });
});
