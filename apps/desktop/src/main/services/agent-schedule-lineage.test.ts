import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository, AgentScheduleRepository, MessageRepository, resolveAgentLineage } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentLineSendService, type AgentLineSendWorker } from './agent-line-send-service.js';
import { AgentScheduleService } from './agent-schedule-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const mid = (letter: string) => `u${letter.repeat(32)}`;

database('schedule targets after an Agent account swap (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let oldId = '';
  let newId = '';

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    const accounts = new AccountRepository(pool);
    oldId = (await accounts.reserveAccountSlot()).accountId;
    const epoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl(oldId, epoch);
    await accounts.bindWorker({ accountId: oldId, workerInstanceId: 'w-old', controlEpoch: epoch });
    await accounts.applyWorkerLogin({ accountId: oldId, workerInstanceId: 'w-old', controlEpoch: epoch }, mid('a'), 'Agent');
    await accounts.revokeControl(epoch);
    await accounts.clearStoppedWorkerBinding({ accountId: oldId, workerInstanceId: 'w-old', controlEpoch: epoch });
    await accounts.setConnectionStatus(oldId, 'disconnected');
    const stopped = await accounts.getControlState();
    const replaced = await accounts.replaceAgentAccount(oldId, stopped.controlEpoch);
    if (!replaced.ok) throw new Error(replaced.code);
    newId = replaced.account.accountId;
    const next = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl(newId, next);
    await accounts.bindWorker({ accountId: newId, workerInstanceId: 'w-new', controlEpoch: next });
    await accounts.applyWorkerLogin({ accountId: newId, workerInstanceId: 'w-new', controlEpoch: next }, mid('b'), 'Agent');
    await pool.query("UPDATE line_accounts SET connection_mode = 'SYSTEM_LOGIN' WHERE account_id = $1", [newId]);
    for (const id of [oldId, newId]) {
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group','g1','家人')", [id]);
    }
  });
  afterAll(async () => { await close?.(); });

  it('fires a line_target system message to the same chat through the new account and audits the new account', async () => {
    expect((await resolveAgentLineage(pool)).currentAccountId).toBe(newId);
    const store = new AgentScheduleRepository(pool);
    const created = await store.create({ title: '提醒', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [],
      task: { type: 'message', text: '固定通知' }, window: { mode: 'since_last_run' }, jitterMinutes: 0, enabled: true,
      delivery: { mode: 'line_target', target: { accountId: oldId, chatType: 'group', chatId: 'g1', title: '家人' } } } as never, new Date('2026-10-01T00:00:00Z'));
    const sent: Array<{ accountId: string; chatType: string; chatId: string; text?: string }> = [];
    const worker: AgentLineSendWorker = {
      binding: async (accountId) => ({ accountId, workerInstanceId: 'w-new', controlEpoch: 1, mode: 'ACTIVE_CONTROL' }),
      waitModeAck: async () => true,
      send: vi.fn(async (command) => {
        sent.push(command);
        return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: 'm-1', error: null };
      }) as never,
    };
    const send = new AgentLineSendService({ messages: new MessageRepository(pool), worker, canWriteLine: async () => true, attachmentRoot: process.cwd() });
    const service = new AgentScheduleService({ store, submit: vi.fn(), agentLineage: () => resolveAgentLineage(pool),
      sendSystemText: (input) => send.sendSystemText(input), now: () => new Date('2026-10-01T01:00:05Z') });
    await service.tick();
    await service.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ accountId: newId, chatType: 'group', chatId: 'g1', text: '固定通知' });
    const audit = (await pool.query('SELECT account_id,status,principal_id FROM agent_line_sends')).rows;
    expect(audit).toEqual([{ account_id: newId, status: 'sent', principal_id: 'system:schedule' }]);
    expect((await store.get(created.scheduleId))?.delivery).toMatchObject({ mode: 'line_target', target: { accountId: oldId } });
    expect((await store.listRuns(created.scheduleId, 5)).map((run) => run.outcome)).toEqual(['sent']);
  });
});
