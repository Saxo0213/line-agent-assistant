import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { LOCAL_AGENT_ROOM_CHAT_ID, type AgentScheduleTarget } from '@line-agent/contracts';
import { AccountRepository, AgentScheduleError, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { createAgentScheduleTargetResolver } from './agent-schedule-targets.js';
import { AgentScheduleService } from './agent-schedule-service.js';
import { AgentScheduleRepository } from '@line-agent/database';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('schedule targets (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let service: AgentScheduleService;
  const base = { title: 'T', provider: 'claude' as const, recurrence: { kind: 'daily' as const, time: '09:00' }, jitterMinutes: 0 };
  const group: AgentScheduleTarget = { accountId: 'acc-agent', chatType: 'group', chatId: 'g-team', title: 'stale title' };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await new AccountRepository(pool).ensureAccount('acc-agent');
    await new AccountRepository(pool).ensureAccount('acc-other');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT', connection_mode = 'SYSTEM_LOGIN' WHERE account_id = 'acc-agent'");
    for (const [account, type, id, title] of [['acc-agent', 'group', 'g-team', 'Team Chat'], ['acc-agent', 'direct', 'u-alice', 'Alice'],
      ['acc-agent', 'community', 'c-1', 'Community'], ['acc-other', 'group', 'g-other', 'Other']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [account, type, id, title]);
    }
    const resolver = createAgentScheduleTargetResolver({ messages: new MessageRepository(pool), pool });
    service = new AgentScheduleService({ store: new AgentScheduleRepository(pool), submit: async () => ({ jobId: 'j' }), targets: resolver });
  });
  afterAll(async () => { await service.stop(); await close?.(); });

  it('lists delivery chats as the send lookup does: no Agent room, community or other account', async () => {
    const all = await service.listTargets(undefined, 50, 'delivery');
    expect(all.map((t) => `${t.chatType}:${t.chatId}`).sort()).toEqual(['direct:u-alice', 'group:g-team']);
    expect(all.every((t) => t.accountId === 'acc-agent')).toBe(true);
    expect((await service.listTargets('team', 50, 'delivery')).map((t) => t.chatId)).toEqual(['g-team']);
  });

  it('lists read chats like list_targets: communities and other accounts, never the Agent room', async () => {
    const all = await service.listTargets(undefined, 50);
    expect(all.map((t) => `${t.accountId}/${t.chatType}:${t.chatId}`).sort())
      .toEqual(['acc-agent/community:c-1', 'acc-agent/direct:u-alice', 'acc-agent/group:g-team', 'acc-other/group:g-other']);
    expect((await service.listTargets('commun', 50, 'read')).map((t) => t.chatId)).toEqual(['c-1']);
  });

  it('marks the administrator direct chat with role primary_admin and sorts it first', async () => {
    await pool.query("UPDATE line_accounts SET own_mid = 'u-agent-own' WHERE account_id = 'acc-agent'");
    await pool.query("INSERT INTO account_administrators (account_id, chat_type, chat_id, user_id, role) VALUES ('acc-agent', 'direct', 'u-alice', 'u-alice', 'PRIMARY_ADMIN')");
    try {
      for (const purpose of ['read', 'delivery'] as const) {
        const items = await service.listTargets(undefined, 50, purpose);
        expect(items[0]).toMatchObject({ chatId: 'u-alice', role: 'primary_admin' });
        expect(items.filter((item) => item.role).length).toBe(1);
      }
    } finally {
      await pool.query("DELETE FROM account_administrators WHERE account_id = 'acc-agent'");
    }
  });

  it('accepts a valid target and refreshes its title', async () => {
    const created = await service.create({ ...base, prompt: '', task: { type: 'summary' }, targets: [group], window: { mode: 'since_last_run' },
      delivery: { mode: 'line_target', target: { ...group, chatType: 'direct', chatId: 'u-alice', title: '' } }, timezone: 'Asia/Taipei', enabled: true });
    expect(created.targets).toEqual([{ ...group, title: 'Team Chat' }]);
    expect(created.delivery).toEqual({ mode: 'line_target', target: { accountId: 'acc-agent', chatType: 'direct', chatId: 'u-alice', title: 'Alice' } });
  });

  it('resolves a delivery target given by a friend mid when the Agent account has that direct chat', async () => {
    await pool.query("INSERT INTO line_contacts (account_id, mid, display_name) VALUES ('acc-agent', 'u-friend', '徐佳誠') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ('acc-agent', 'direct', 'u-friend', '徐佳誠') ON CONFLICT DO NOTHING");
    try {
      const [resolved] = await createAgentScheduleTargetResolver({ messages: new MessageRepository(pool), pool }).resolve([{ accountId: 'acc-agent', chatType: 'direct', chatId: 'u-friend', title: '' }], 'delivery');
      expect(resolved).toEqual({ accountId: 'acc-agent', chatType: 'direct', chatId: 'u-friend', title: '徐佳誠' });
    } finally {
      await pool.query("DELETE FROM conversations WHERE account_id = 'acc-agent' AND chat_id = 'u-friend'");
      await pool.query("DELETE FROM line_contacts WHERE account_id = 'acc-agent' AND mid IN ('u-friend')");
    }
  });

  it('keeps the existing send rule: a friend without a direct conversation row is not a delivery target', async () => {
    await pool.query("INSERT INTO line_contacts (account_id, mid, display_name) VALUES ('acc-agent', 'u-nochat', '沒聊過') ON CONFLICT DO NOTHING");
    try {
      await expect(createAgentScheduleTargetResolver({ messages: new MessageRepository(pool), pool }).resolve([{ accountId: 'acc-agent', chatType: 'direct', chatId: 'u-nochat', title: '' }], 'delivery'))
        .rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    } finally { await pool.query("DELETE FROM line_contacts WHERE account_id = 'acc-agent' AND mid = 'u-nochat'"); }
  });

  it('accepts a community readable through the list_targets lookup and refreshes its title', async () => {
    const created = await service.create({ ...base, prompt: '', task: { type: 'summary' }, targets: [{ accountId: 'acc-agent', chatType: 'community', chatId: 'c-1', title: 'old' },
      { accountId: 'acc-other', chatType: 'group', chatId: 'g-other', title: '' }], window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, timezone: 'Asia/Taipei', enabled: true });
    expect(created.targets).toEqual([{ accountId: 'acc-agent', chatType: 'community', chatId: 'c-1', title: 'Community' },
      { accountId: 'acc-other', chatType: 'group', chatId: 'g-other', title: 'Other' }]);
    expect(created.delivery).toEqual({ mode: 'primary_admin' });
    // The same chat with a wrong chat type is not that chat.
    await expect(service.create({ ...base, prompt: '', task: { type: 'summary' }, targets: [{ accountId: 'acc-agent', chatType: 'group', chatId: 'c-1', title: '' }],
      window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, timezone: 'Asia/Taipei', enabled: true })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
  });

  it('rejects the local Agent room, unknown chats and duplicates as read targets; delivery stays limited to send targets', async () => {
    const make = (targets: AgentScheduleTarget[]) => service.create({ ...base, prompt: '', task: { type: 'summary' }, targets, window: { mode: 'since_last_run' },
      delivery: { mode: 'record_only' }, timezone: 'Asia/Taipei', enabled: true });
    await expect(make([{ ...group, chatType: 'room', chatId: LOCAL_AGENT_ROOM_CHAT_ID }])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(make([{ ...group, accountId: 'acc-missing', chatId: 'g-other' }])).rejects.toBeInstanceOf(AgentScheduleError);
    const deliver = (target: { accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string; title: string }) => service.create({ ...base, prompt: 'x', task: { type: 'custom' }, targets: [],
      window: { mode: 'since_last_run' }, delivery: { mode: 'line_target', target }, timezone: 'Asia/Taipei', enabled: true });
    await expect(deliver({ accountId: 'acc-other', chatType: 'group', chatId: 'g-other', title: '' })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(deliver({ accountId: 'acc-agent', chatType: 'group', chatId: 'c-1', title: '' })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(make([{ ...group, chatId: 'g-missing' }])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(make([group, group])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    await expect(service.create({ ...base, prompt: 'x', task: { type: 'custom' }, targets: [], window: { mode: 'since_last_run' },
      delivery: { mode: 'line_target', target: { ...group, chatId: LOCAL_AGENT_ROOM_CHAT_ID, chatType: 'room' } }, timezone: 'Asia/Taipei', enabled: true }))
      .rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
  });

  it('validates the merged schedule on update', async () => {
    const created = await service.create({ ...base, prompt: '', task: { type: 'summary' }, targets: [group], window: { mode: 'since_last_run' },
      delivery: { mode: 'record_only' }, timezone: 'Asia/Taipei', enabled: true });
    await expect(service.update(created.scheduleId, { targets: [] })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    await expect(service.update(created.scheduleId, { targets: [{ ...group, chatId: 'nope' }] })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(service.update(created.scheduleId, { task: { type: 'custom' } })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    const ok = await service.update(created.scheduleId, { task: { type: 'keyword_digest', keywords: ['a'] }, window: { mode: 'lookback', minutes: 60 } });
    expect(ok).toMatchObject({ task: { type: 'keyword_digest', keywords: ['a'] }, window: { mode: 'lookback', minutes: 60 } });
  });
});
