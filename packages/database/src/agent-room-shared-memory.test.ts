import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type AgentRunRequest, type InboundEnvelope } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';
import { AgentRepository, resolveRoomSessionTarget, type ClaimedAgentJob } from './agent-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const AGENT = 'agent-acct';
const ADMIN_MID = 'mid-admin';
const WORKSPACE = 'C:\\work';
const adminKey = { accountId: AGENT, chatType: 'direct' as const, chatId: ADMIN_MID };
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'work', workspacePath: WORKSPACE };
let sequence = 0;
function envelope(chatType: 'direct' | 'group', chatId: string, senderId: string): InboundEnvelope {
  const id = ++sequence;
  return { eventId: `sm-event-${id}`, accountId: AGENT, chatId, chatType, senderId, messageId: `sm-message-${id}`, kind: 'text', text: 'work',
    mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: `sm-cursor-${id}` },
    occurredAt: '2026-10-20T10:00:00.000Z', attachments: [], raw: {} };
}

database('Agent room shares conversation memory with the admin direct chat', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let admin: AdminRepository;
  let n = 0;
  const request = (provider: 'codex' | 'claude' = 'codex') => ({ requestId: `sm-room-${++n}`, provider, prompt: `ask ${n}`, workspacePath: WORKSPACE });
  const roomRun = (job: ClaimedAgentJob, resumeSessionId: string): AgentRunRequest => ({ jobId: job.jobId, provider: job.provider,
    source: { type: 'ui', requestId: job.sourceRequestId! }, prompt: 'p', workspacePath: WORKSPACE, resumeSessionId,
    tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false } });
  const bind = (job: ClaimedAgentJob, externalSessionId: string) => agents.bindSession({
    ...job.sessionKey!, externalSessionId, generation: job.sessionGeneration!, workspacePath: WORKSPACE });
  const lineJob = async (chatType: 'direct' | 'group', chatId: string, senderId: string, provider: 'codex' | 'claude' = 'codex') => {
    const result = await messages.ingestAndRoute(envelope(chatType, chatId, senderId), { ...route, provider });
    if (!result.jobId) throw new Error('expected a routed LINE job');
    return result.jobId;
  };
  const drain = async () => {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  };
  const sessionRows = async () => (await pool.query<{ account_id: string | null; chat_id: string | null; provider: string; source_type: string; external_session_id: string | null; generation: number }>(
    'SELECT account_id, chat_id, provider, source_type, external_session_id, generation FROM agent_sessions ORDER BY source_type, account_id NULLS FIRST, chat_id, provider')).rows;
  const setBinding = async (bound: boolean) => {
    await pool.query("DELETE FROM account_administrators WHERE account_id = $1", [AGENT]);
    if (bound) await admin.bindPrimary(AGENT, ADMIN_MID, ADMIN_MID);
  };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    admin = new AdminRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(AGENT);
    await accounts.setOwnMid(AGENT, 'mid-bot');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [AGENT]);
    const epoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl(AGENT, epoch);
    for (const [chatType, chatId] of [['direct', ADMIN_MID], ['direct', 'mid-friend'], ['group', 'g1']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [AGENT, chatType, chatId]);
    }
  });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await drain();
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [AGENT]);
    await setBinding(true);
  });

  it('selects the admin-direct session only with an Agent, its admin binding, an unpaused account and the admin chat', async () => {
    expect(await resolveRoomSessionTarget(pool, 'codex')).toEqual({ shared: true, key: { ...adminKey, provider: 'codex', sourceType: 'line' } });
    expect(await resolveRoomSessionTarget(pool, 'claude')).toEqual({ shared: true, key: { ...adminKey, provider: 'claude', sourceType: 'line' } });

    await setBinding(false);
    expect(await resolveRoomSessionTarget(pool, 'codex')).toEqual({ shared: false, key: { ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' } });

    await setBinding(true);
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = $1", [AGENT]);
    expect((await resolveRoomSessionTarget(pool, 'codex')).shared).toBe(false);
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [AGENT]);
    expect((await resolveRoomSessionTarget(pool, 'codex')).shared).toBe(true);

    // No Agent account at all (only a Primary Admin slot): the room keeps its own session.
    await pool.query("UPDATE line_accounts SET product_role = NULL WHERE account_id = $1", [AGENT]);
    expect((await resolveRoomSessionTarget(pool, 'codex')).shared).toBe(false);
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [AGENT]);

    // The session row references the conversation, so a binding without that chat yet keeps the own session.
    await pool.query("DELETE FROM conversations WHERE account_id = $1 AND chat_id = $2", [AGENT, ADMIN_MID]);
    expect((await resolveRoomSessionTarget(pool, 'codex')).shared).toBe(false);
    await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3)', [AGENT, 'direct', ADMIN_MID]);
  });

  it('writes the provider session id only to the resolved target, separately per provider', async () => {
    await pool.query('DELETE FROM agent_sessions');
    const queued = await agents.enqueueUiJob(request('codex'));
    const claimed = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(claimed).toMatchObject({ jobId: queued.jobId, sessionKey: { ...adminKey, provider: 'codex', sourceType: 'line' } });
    expect(await bind(claimed, 'shared-codex')).toBe(true);
    await agents.failJob(claimed.jobId);

    const claude = await agents.enqueueUiJob(request('claude'));
    const claudeJob = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(claudeJob.jobId).toBe(claude.jobId);
    expect(await bind(claudeJob, 'shared-claude')).toBe(true);
    await agents.failJob(claudeJob.jobId);

    const rows = await sessionRows();
    expect(rows.filter((row) => row.source_type === 'ui' && row.external_session_id !== null)).toEqual([]);
    expect(rows.filter((row) => row.source_type === 'line').map((row) => [row.chat_id, row.provider, row.external_session_id]))
      .toEqual([[ADMIN_MID, 'claude', 'shared-claude'], [ADMIN_MID, 'codex', 'shared-codex']]);

    // Unbound: the room writes its own UI session again and leaves the admin-direct row alone.
    await setBinding(false);
    await agents.enqueueUiJob(request('codex'));
    const own = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(own.sessionKey).toEqual({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' });
    expect(await bind(own, 'own-codex')).toBe(true);
    await agents.failJob(own.jobId);
    const after = await sessionRows();
    expect(after.find((row) => row.source_type === 'ui' && row.provider === 'codex')?.external_session_id).toBe('own-codex');
    expect(after.find((row) => row.source_type === 'line' && row.provider === 'codex')?.external_session_id).toBe('shared-codex');
  });

  it('resumes the same provider session across the room and the admin direct chat, in both directions', async () => {
    await pool.query('DELETE FROM agent_sessions');
    // room -> LINE
    await agents.enqueueUiJob(request('codex'));
    const roomJob = (await agents.claimNext(AGENT_ROOM_KEY))!;
    await bind(roomJob, 'from-room');
    await agents.failJob(roomJob.jobId);
    const lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
    const lineClaimed = (await agents.claimNext(adminKey))!;
    expect(lineClaimed.jobId).toBe(lineId);
    const resume = await agents.lookupSession({ ...adminKey, provider: 'codex', sourceType: 'line', workspacePath: WORKSPACE });
    expect(resume).toEqual({ externalSessionId: 'from-room', generation: lineClaimed.generation });
    expect(await agents.validateResumeSession({ jobId: lineId, provider: 'codex', source: { type: 'line', ...adminKey, messageId: lineClaimed.sourceMessageId! },
      prompt: 'p', workspacePath: WORKSPACE, resumeSessionId: 'from-room',
      tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false } })).toEqual({ status: 'valid' });
    // LINE -> room
    await agents.bindSession({ ...adminKey, provider: 'codex', sourceType: 'line', externalSessionId: 'from-line', generation: lineClaimed.generation, workspacePath: WORKSPACE });
    await agents.failJob(lineId);
    await agents.enqueueUiJob(request('codex'));
    const next = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(next.generation).toBe(next.sessionGeneration);
    expect(await agents.lookupSession({ ...next.sessionKey!, workspacePath: WORKSPACE })).toEqual({ externalSessionId: 'from-line', generation: next.generation });
    expect(await agents.validateResumeSession(roomRun(next, 'from-line'))).toEqual({ status: 'valid' });
    expect(await agents.validateResumeSession(roomRun(next, 'unknown'))).toEqual({ status: 'invalid' });
    await agents.failJob(next.jobId);
  });

  it('hands a job queued under another target the new target at claim time without failing it', async () => {
    await pool.query('DELETE FROM agent_sessions');
    await setBinding(false);
    const queued = await agents.enqueueUiJob(request('codex')); // stamped with the room-own generation
    await pool.query("INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type, generation, external_session_id, workspace_path) VALUES ($1,'direct',$2,'codex','line',4,'admin-memory',$3)",
      [AGENT, ADMIN_MID, WORKSPACE]);
    await setBinding(true);
    const claimed = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(claimed.jobId).toBe(queued.jobId);
    expect(claimed.generation).toBe(0);
    expect(claimed).toMatchObject({ sessionKey: { ...adminKey, provider: 'codex', sourceType: 'line' }, sessionGeneration: 4 });
    // The claim's generation is what bind uses, so the new target records this turn.
    expect(await bind(claimed, 'fresh-run')).toBe(true);
    expect((await sessionRows()).find((row) => row.source_type === 'line')).toMatchObject({ external_session_id: 'fresh-run', generation: 4 });
    await agents.failJob(claimed.jobId);

    // Unbound again before the next job is claimed: it binds the room's own session at its own generation.
    await agents.enqueueUiJob(request('codex'));
    await setBinding(false);
    const own = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(own).toMatchObject({ sessionKey: { ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' }, sessionGeneration: 0 });
    await agents.failJob(own.jobId);
  });

  it('propagates a LINE /new in the admin direct chat to the room, and a room reset to the admin direct chat', async () => {
    await pool.query('DELETE FROM agent_sessions');
    await agents.enqueueUiJob(request('codex'));
    const first = (await agents.claimNext(AGENT_ROOM_KEY))!;
    await bind(first, 'old-memory');
    await agents.failJob(first.jobId);
    const queuedRoom = await agents.enqueueUiJob(request('codex'));
    const queuedClaude = await agents.enqueueUiJob(request('claude'));

    const commandEnvelope = envelope('direct', ADMIN_MID, ADMIN_MID);
    await messages.ingestAndRoute({ ...commandEnvelope, text: '/new' }, { eligible: false });
    await pool.query("INSERT INTO message_routes (account_id, message_id, action, creation_epoch) VALUES ($1, $2, 'new', (SELECT control_epoch FROM account_control))",
      [AGENT, commandEnvelope.messageId]);
    const commandMessageId = commandEnvelope.messageId;
    const reset = await agents.resetConversationForMessage(adminKey, commandMessageId);
    expect(reset.result).toBe('applied');
    expect(reset.cancelledJobIds).toEqual(expect.arrayContaining([queuedRoom.jobId, queuedClaude.jobId]));
    expect(await agents.lookupSession({ ...adminKey, provider: 'codex', sourceType: 'line', workspacePath: WORKSPACE })).toBeNull();

    const fresh = await agents.enqueueUiJob(request('codex'));
    const claimed = (await agents.claimNext(AGENT_ROOM_KEY))!;
    expect(claimed.jobId).toBe(fresh.jobId);
    expect(claimed.generation).toBe(1);
    expect(await agents.lookupSession({ ...claimed.sessionKey!, workspacePath: WORKSPACE })).toBeNull();
    await bind(claimed, 'new-memory');

    // Room-side "new conversation" resets the shared session too and cancels the admin chat's LINE job.
    const lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID, 'codex');
    const roomReset = await agents.resetGeneration({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' });
    expect(roomReset.cancelledJobIds).toEqual(expect.arrayContaining([claimed.jobId, lineId]));
    expect(await agents.lookupSession({ ...adminKey, provider: 'codex', sourceType: 'line', workspacePath: WORKSPACE })).toBeNull();
    expect((await sessionRows()).find((row) => row.source_type === 'line' && row.provider === 'codex')?.generation).toBe(2);
    // The other provider's memory is untouched.
    expect((await sessionRows()).find((row) => row.source_type === 'line' && row.provider === 'claude')?.generation ?? 1).toBe(1);
  });

  describe('mutual exclusion', () => {
    const finish = async (job: ClaimedAgentJob) => { await agents.failJob(job.jobId); };

    it('blocks a room claim while the admin-direct LINE job runs, and the LINE claim while a room job runs', async () => {
      const lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
      await agents.enqueueUiJob(request('codex'));
      const line = (await agents.claimNext(adminKey))!;
      expect(line.jobId).toBe(lineId);
      expect(await agents.claimNext(AGENT_ROOM_KEY)).toBeNull();
      expect(await agents.listQueuedConversations(32)).toEqual([]);
      await finish(line);
      expect(await agents.listQueuedConversations(32)).toEqual([AGENT_ROOM_KEY]);
      const room = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(room.sourceType).toBe('ui');

      const second = await lineJob('direct', ADMIN_MID, ADMIN_MID);
      expect(await agents.claimNext(adminKey)).toBeNull();
      expect(await agents.listQueuedConversations(32)).toEqual([]);
      await finish(room);
      expect(await agents.listQueuedConversations(32)).toEqual([adminKey]);
      expect((await agents.claimNext(adminKey))?.jobId).toBe(second);
    });

    it('never runs a room job and an admin-direct LINE job at once under concurrent claims, in either arrival order', async () => {
      for (let round = 0; round < 12; round++) {
        await drain();
        const lineFirst = round % 2 === 0;
        let lineId = '';
        if (lineFirst) lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
        await agents.enqueueUiJob(request('codex'));
        if (!lineFirst) lineId = await lineJob('direct', ADMIN_MID, ADMIN_MID);
        const [room, line] = await Promise.all([agents.claimNext(AGENT_ROOM_KEY), agents.claimNext(adminKey)]);
        expect([room, line].filter((job) => job !== null)).toHaveLength(1);
        const running = (await pool.query("SELECT source_type FROM agent_jobs WHERE status = 'running'")).rows;
        expect(running).toHaveLength(1);
        // The loser claims as soon as the winner is done.
        await finish((room ?? line)!);
        const next = room ? await agents.claimNext(adminKey) : await agents.claimNext(AGENT_ROOM_KEY);
        expect(next).not.toBeNull();
        expect(next?.jobId === lineId || next?.sourceType === 'ui').toBe(true);
        await finish(next!);
      }
    });

    it('does not exclude when the room is not sharing (no binding)', async () => {
      await setBinding(false);
      await lineJob('direct', ADMIN_MID, ADMIN_MID);
      await agents.enqueueUiJob(request('codex'));
      const line = (await agents.claimNext(adminKey))!;
      const room = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(room.sessionKey).toMatchObject({ sourceType: 'ui' });
      await finish(line);
      await finish(room);
    });
  });

  it('never lets group chats or whitelisted users touch the shared row or wait on the room', async () => {
    await pool.query('DELETE FROM agent_sessions');
    await agents.enqueueUiJob(request('codex'));
    const room = (await agents.claimNext(AGENT_ROOM_KEY))!;
    await bind(room, 'room-secret');

    const groupId = await lineJob('group', 'g1', 'mid-friend');
    const friendId = await lineJob('direct', 'mid-friend', 'mid-friend');
    // Both run alongside a running room job: they are not the admin-direct chat.
    expect((await agents.claimNext({ accountId: AGENT, chatType: 'group', chatId: 'g1' }))?.jobId).toBe(groupId);
    expect((await agents.claimNext({ accountId: AGENT, chatType: 'direct', chatId: 'mid-friend' }))?.jobId).toBe(friendId);
    expect(await agents.lookupSession({ accountId: AGENT, chatType: 'group', chatId: 'g1', provider: 'codex', sourceType: 'line', workspacePath: WORKSPACE })).toBeNull();
    expect(await agents.lookupSession({ accountId: AGENT, chatType: 'direct', chatId: 'mid-friend', provider: 'codex', sourceType: 'line', workspacePath: WORKSPACE })).toBeNull();
    await agents.bindSession({ accountId: AGENT, chatType: 'group', chatId: 'g1', provider: 'codex', sourceType: 'line', externalSessionId: 'group-session', generation: 0, workspacePath: WORKSPACE });
    expect((await sessionRows()).find((row) => row.chat_id === ADMIN_MID)?.external_session_id).toBe('room-secret');
    await agents.failJob(groupId);
    await agents.failJob(friendId);

    // A group or whitelisted-user reset leaves the room's queued and running jobs alone.
    const queued = await agents.enqueueUiJob(request('codex'));
    for (const chat of [{ accountId: AGENT, chatType: 'group' as const, chatId: 'g1' }, { accountId: AGENT, chatType: 'direct' as const, chatId: 'mid-friend' }]) {
      const reset = await agents.resetGeneration({ ...chat, provider: 'codex', sourceType: 'line' });
      expect(reset.cancelledJobIds).toEqual([]);
    }
    expect((await agents.getJob(queued.jobId))?.status).toBe('queued');
    expect((await agents.getJob(room.jobId))?.status).toBe('running');
    expect((await sessionRows()).find((row) => row.chat_id === ADMIN_MID && row.provider === 'codex')).toMatchObject({ external_session_id: 'room-secret', generation: 0 });
    await agents.failJob(room.jobId);

    // A group job running does not delay the room either.
    const running = await lineJob('group', 'g1', 'mid-friend');
    await agents.claimNext({ accountId: AGENT, chatType: 'group', chatId: 'g1' });
    expect((await agents.claimNext(AGENT_ROOM_KEY))?.jobId).toBe(queued.jobId);
    await agents.failJob(running);
    await agents.failJob(queued.jobId);
  });

  describe('retry of room jobs', () => {
    it('retries a failed room job in the shared state even when no ui session row exists, rebinding to the admin-direct session', async () => {
      await pool.query('DELETE FROM agent_sessions');
      const { jobId } = await agents.enqueueUiJob(request('codex'));
      const first = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(first.jobId).toBe(jobId);
      await agents.failJob(jobId);
      await pool.query('DELETE FROM agent_sessions');
      const retried = await agents.retryJobForKey(AGENT_ROOM_KEY, jobId, WORKSPACE);
      expect(retried?.status).toBe('queued');
      const again = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(again.jobId).toBe(jobId);
      expect(again.sessionKey).toMatchObject({ ...adminKey, sourceType: 'line' });
      await agents.failJob(jobId);
    });

    it('makes an interrupted room job (restart recovery) retryable in the shared state', async () => {
      await pool.query('DELETE FROM agent_sessions');
      const { jobId } = await agents.enqueueUiJob(request('codex'));
      expect((await agents.claimNext(AGENT_ROOM_KEY))!.jobId).toBe(jobId);
      expect((await agents.recoverInterruptedState()).interruptedJobs).toBeGreaterThanOrEqual(1);
      const retried = await agents.retryJobForKey(AGENT_ROOM_KEY, jobId, WORKSPACE);
      expect(retried?.status).toBe('queued');
      expect((await agents.claimNext(AGENT_ROOM_KEY))!.jobId).toBe(jobId);
      await agents.failJob(jobId);
    });

    it('retries a failed room job with an attachment in the shared state and claims it with attachments on the admin-direct session', async () => {
      await pool.query('DELETE FROM agent_sessions');
      const jobId = randomUUID();
      const attachment = { name: 'a.png', size: 3, kind: 'image' as const, mime: 'image/png', sha256: 'a'.repeat(64), relativePath: `.agent-attachments/${jobId}/a.png` };
      await agents.enqueueUiJob({ ...request('codex'), jobId, attachments: [attachment] });
      const first = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(first.jobId).toBe(jobId);
      expect(first.attachments).toEqual([attachment]);
      await agents.failJob(jobId);
      await pool.query('DELETE FROM agent_sessions');
      expect((await agents.retryJobForKey(AGENT_ROOM_KEY, jobId, WORKSPACE))?.status).toBe('queued');
      const again = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(again.jobId).toBe(jobId);
      expect(again.attachments).toEqual([attachment]);
      expect(again.sessionKey).toMatchObject({ ...adminKey, sourceType: 'line' });
      await agents.failJob(jobId);
    });

    it('still retries a failed room job when not sharing (no binding)', async () => {
      await setBinding(false);
      await pool.query('DELETE FROM agent_sessions');
      const { jobId } = await agents.enqueueUiJob(request('codex'));
      const claimed = (await agents.claimNext(AGENT_ROOM_KEY))!;
      expect(claimed.sessionKey).toMatchObject({ accountId: null, sourceType: 'ui' });
      await agents.failJob(jobId);
      expect((await agents.retryJobForKey(AGENT_ROOM_KEY, jobId, WORKSPACE))?.status).toBe('queued');
      expect((await agents.claimNext(AGENT_ROOM_KEY))!.jobId).toBe(jobId);
      await agents.failJob(jobId);
    });
  });

  it('resets the room with every session row updated before any job row (same lock order as the LINE side)', async () => {
    await agents.enqueueUiJob(request('codex'));
    const statements: string[] = [];
    const realConnect = pool.connect.bind(pool);
    const spy = (async () => {
      const client = await realConnect();
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const first = args[0];
        statements.push(typeof first === 'string' ? first : (first as { text?: string })?.text ?? '');
        return query(...args);
      };
      return client;
    }) as unknown as typeof pool.connect;
    const original = pool.connect;
    (pool as unknown as { connect: unknown }).connect = spy;
    try {
      await agents.resetGeneration({ ...AGENT_ROOM_KEY, provider: 'codex', sourceType: 'ui' });
    } finally { (pool as unknown as { connect: unknown }).connect = original; }
    const lastSessionUpdate = statements.map((sql, index) => (/UPDATE agent_sessions/.test(sql) ? index : -1)).filter((i) => i >= 0);
    const firstJobUpdate = statements.findIndex((sql) => /UPDATE agent_jobs/.test(sql));
    expect(lastSessionUpdate.length).toBeGreaterThanOrEqual(2);
    expect(firstJobUpdate).toBeGreaterThan(Math.max(...lastSessionUpdate));
    // The admin-direct (line) session UPDATE is among those preceding the first job update.
    expect(statements.slice(0, firstJobUpdate).some((sql) => /UPDATE agent_sessions/.test(sql) && /source_type = 'line'/.test(sql))).toBe(true);
  });

  it('keeps the room claim lock order free of account row locks (no FOR UPDATE/SHARE on line_accounts in the new paths)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./agent-repository.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const sharedAdminChatSql');
    const block = source.slice(start, source.indexOf('export interface SharedAdminChat'));
    expect(block).not.toMatch(/FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)/);
  });
});
