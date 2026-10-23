import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppSnapshotSchema, type InboundEnvelope } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AdminRepository, AgentRepository, MessageRepository } from '../../../../../packages/database/src/index.js';
import { HealthService } from './health-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const AGENT = 'room-agent';
const ADMIN_MID = 'mid-room-admin';
const WORKSPACE = 'C:\\work';
let sequence = 0;

function envelope(chatType: 'direct' | 'group', chatId: string, senderId: string): InboundEnvelope {
  const id = ++sequence;
  return { eventId: `rr-event-${id}`, accountId: AGENT, chatId, chatType, senderId, messageId: `rr-message-${id}`, kind: 'text', text: 'work',
    mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: `rr-cursor-${id}` },
    occurredAt: new Date(Date.UTC(2026, 9, 22, 8, 0, id)).toISOString(), attachments: [], raw: {} };
}

database('Agent room jobs in the snapshot: admin LINE direct turns', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let admin: AdminRepository;
  let health: HealthService;

  const lineJob = async (chatType: 'direct' | 'group', chatId: string, senderId: string, prompt: string) => {
    const result = await messages.ingestAndRoute(envelope(chatType, chatId, senderId), { eligible: true, provider: 'codex', prompt, workspacePath: WORKSPACE });
    if (!result.jobId) throw new Error('expected a routed LINE job');
    return result.jobId;
  };
  const setBinding = async (bound: boolean) => {
    await pool.query('DELETE FROM account_administrators WHERE account_id = $1', [AGENT]);
    if (bound) await admin.bindPrimary(AGENT, ADMIN_MID, ADMIN_MID);
  };
  const originOf = async (jobId: string) => (await health.snapshot()).jobs.find((job) => job.jobId === jobId)?.origin;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    admin = new AdminRepository(pool);
    health = new HealthService(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(AGENT);
    await accounts.setOwnMid(AGENT, 'mid-room-bot');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = $1", [AGENT]);
    const epoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl(AGENT, epoch);
    for (const [chatType, chatId] of [['direct', ADMIN_MID], ['direct', 'mid-room-friend'], ['group', 'rg1']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [AGENT, chatType, chatId]);
    }
  });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')");
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [AGENT]);
    await setBinding(true);
  });

  it('lists the admin direct LINE jobs with their original text and origin, and parses under the strict snapshot schema', async () => {
    const room = await agents.enqueueUiJob({ requestId: 'rr-room-1', provider: 'claude', prompt: '室內的話', workspacePath: WORKSPACE });
    const direct = await lineJob('direct', ADMIN_MID, ADMIN_MID, '管理者私訊的原文');
    const group = await lineJob('group', 'rg1', ADMIN_MID, '管理者在群組的話');
    const friend = await lineJob('direct', 'mid-room-friend', 'mid-room-friend', '好友私訊');

    const snapshot = await health.snapshot();
    expect(AppSnapshotSchema.parse(snapshot)).toBeTruthy();
    const byId = new Map(snapshot.jobs.map((job) => [job.jobId, job]));
    expect(byId.get(room.jobId)).toMatchObject({ accountId: null, origin: 'agent_room', prompt: '室內的話' });
    expect(byId.get(direct)).toMatchObject({ accountId: AGENT, chatType: 'direct', chatId: ADMIN_MID, origin: 'line_admin_direct', prompt: '管理者私訊的原文' });
    // Other LINE jobs stay in the list for the Jobs page but carry no origin, so the room never shows them.
    expect(byId.get(group)?.origin).toBeUndefined();
    expect(byId.get(friend)?.origin).toBeUndefined();
    expect(snapshot.jobs.filter((job) => job.jobId === direct)).toHaveLength(1);
  });

  it('stops tagging LINE jobs when the shared condition no longer holds', async () => {
    const direct = await lineJob('direct', ADMIN_MID, ADMIN_MID, '解除前');
    expect(await originOf(direct)).toBe('line_admin_direct');

    await setBinding(false);
    expect(await originOf(direct)).toBeUndefined();

    await setBinding(true);
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = $1", [AGENT]);
    expect(await originOf(direct)).toBeUndefined();
  });

  it('serves events only for room jobs and, while shared, for admin direct LINE jobs', async () => {
    const room = await agents.enqueueUiJob({ requestId: 'rr-room-events', provider: 'codex', prompt: 'room', workspacePath: WORKSPACE });
    const direct = await lineJob('direct', ADMIN_MID, ADMIN_MID, '事件');
    const group = await lineJob('group', 'rg1', ADMIN_MID, '群組事件');
    const friend = await lineJob('direct', 'mid-room-friend', 'mid-room-friend', '好友事件');
    for (const jobId of [room.jobId, direct, group, friend]) await agents.appendEvent(jobId, { type: 'text_delta', text: `delta ${jobId}` });

    expect(await agents.listRoomJobEvents(room.jobId)).toEqual([{ type: 'text_delta', text: `delta ${room.jobId}` }]);
    expect(await agents.listRoomJobEvents(direct)).toEqual([{ type: 'text_delta', text: `delta ${direct}` }]);
    expect(await agents.listRoomJobEvents(group)).toEqual([]);
    expect(await agents.listRoomJobEvents(friend)).toEqual([]);
    expect(await agents.listRoomJobEvents('00000000-0000-4000-8000-000000000000')).toEqual([]);

    await setBinding(false);
    expect(await agents.listRoomJobEvents(direct)).toEqual([]);
    expect(await agents.listRoomJobEvents(room.jobId)).toHaveLength(1);
  });
});
