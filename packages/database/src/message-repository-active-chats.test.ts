import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { McpMessageRecord } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { MessageRepository } from './message-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const FROM = '2026-10-30T00:00:00.000Z';
const TO = '2026-10-30T06:00:00.000Z';

type ActiveInput = Parameters<MessageRepository['listActiveChats']>[0];
type QueryInput = Parameters<MessageRepository['queryTargetMessagePage']>[0];
type Filters = {
  chatType?: McpMessageRecord['chatType'];
  excludeChatIds?: string[];
  direction?: 'inbound' | 'outbound';
  kinds?: McpMessageRecord['kind'][];
  excludeKinds?: McpMessageRecord['kind'][];
};

database('listActiveChats and the by-time message filters on a real database', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: MessageRepository;

  const insert = (account: string, chatType: string, chatId: string, id: string, sender: string, kind: string, at: string,
    extra: { content?: string | null; raw?: string } = {}) => pool.query(
    `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw,content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'history',$9,$10::jsonb,$11::jsonb)`,
    [account, id, `ev-${account}-${id}`, chatType, chatId, sender, kind, `text of ${id}`, at, extra.raw ?? '{}', extra.content ?? null]);

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new MessageRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('acc-a','Account A','mid-a'),('acc-b','Account B','mid-b')");
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('acc-a','peer-1','Peer One','Nick One')");
    for (const [account, chatType, chatId, title] of [
      ['acc-a', 'group', 'g1', 'Alpha'], ['acc-b', 'group', 'g1', 'Alpha B'], ['acc-a', 'direct', 'peer-1', 'Owner Nick'], ['acc-a', 'room', 'r1', 'Room One'],
      ['acc-a', 'direct', '__local_agent_room__', 'Agent room'],
    ] as const) await pool.query('INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,$2,$3,$4)', [account, chatType, chatId, title]);

    // acc-a group g1: 6 messages in the window, 6 different senders, newest 03:00; outbound are m3 (own mid) and mN (native status 2).
    await insert('acc-a', 'group', 'g1', 'm1', 'u1', 'text', '2026-10-30T01:00:00.000Z');
    await insert('acc-a', 'group', 'g1', 'm2', 'u2', 'image', '2026-10-30T01:30:00.000Z');
    await insert('acc-a', 'group', 'g1', 'm3', 'mid-a', 'text', '2026-10-30T02:00:00.000Z');
    await insert('acc-a', 'group', 'g1', 'mN', 'u9', 'text', '2026-10-30T02:15:00.000Z',
      { raw: '{"native":{"row":{"columns":["_status"],"cells":[{"value":"2"}]}}}' });
    await insert('acc-a', 'group', 'g1', 'm8', 'sys', 'event', '2026-10-30T02:30:00.000Z', { content: '{"format":1,"type":"event"}' });
    await insert('acc-a', 'group', 'g1', 'm9', 'sys', 'event', '2026-10-30T02:45:00.000Z');
    await insert('acc-a', 'group', 'g1', 'm4', 'u3', 'sticker', '2026-10-30T03:00:00.000Z');
    // The same chat id on another, unrelated account is a different chat.
    await insert('acc-b', 'group', 'g1', 'b1', 'ux', 'image', '2026-10-30T04:00:00.000Z');
    // Direct chat: 2 messages from 1 sender, newest 05:30.
    await insert('acc-a', 'direct', 'peer-1', 'd1', 'peer-1', 'text', '2026-10-30T05:00:00.000Z');
    await insert('acc-a', 'direct', 'peer-1', 'd2', 'peer-1', 'text', '2026-10-30T05:30:00.000Z');
    // Room: window edges. Only rA and rC are inside [FROM, TO].
    await insert('acc-a', 'room', 'r1', 'rBefore', 'u1', 'text', '2026-10-29T23:59:59.999Z');
    await insert('acc-a', 'room', 'r1', 'rA', 'u1', 'text', FROM);
    await insert('acc-a', 'room', 'r1', 'rC', 'u2', 'text', TO);
    await insert('acc-a', 'room', 'r1', 'rAfter', 'u3', 'text', '2026-10-30T06:00:00.001Z');
    // The local Agent room is never listed.
    await insert('acc-a', 'direct', '__local_agent_room__', 'local1', 'operator', 'text', '2026-10-30T03:30:00.000Z');
  });
  afterAll(async () => { await close?.(); });

  const accountIds = ['acc-a', 'acc-b'];
  const active = (extra: Partial<ActiveInput> = {}) => repo.listActiveChats({ accountIds, from: FROM, to: TO, limit: 200, ...extra });
  const key = (row: { accountId: string; chatType: string; chatId: string }) => `${row.accountId}/${row.chatType}/${row.chatId}`;

  async function allMessages(filters: Filters, extra: Partial<QueryInput> = {}): Promise<McpMessageRecord[]> {
    const rows: McpMessageRecord[] = [];
    let after: { occurredAt: string; messageId: string } | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await repo.queryTargetMessagePage({ accountIds, from: FROM, to: TO, order: 'asc', limit: 3, ...filters, ...extra, ...(after ? { after } : {}) });
      rows.push(...result.messages);
      if (!result.hasMore || !result.lastKey) return rows;
      after = result.lastKey;
    }
    throw new Error('paging did not finish');
  }

  it('lists the chats of the window with hand-checked counts, senders and newest time, newest chat first', async () => {
    const { chats, truncated } = await active();
    expect(truncated).toBe(false);
    expect(chats).toEqual([
      { accountId: 'acc-a', accountDisplayName: 'Account A', chatType: 'room', chatId: 'r1', conversationTitle: 'Room One', messageCount: 2, senderCount: 2, lastMessageAt: TO },
      { accountId: 'acc-a', accountDisplayName: 'Account A', chatType: 'direct', chatId: 'peer-1', conversationTitle: 'Owner Nick', messageCount: 2, senderCount: 1, lastMessageAt: '2026-10-30T05:30:00.000Z' },
      { accountId: 'acc-b', accountDisplayName: 'Account B', chatType: 'group', chatId: 'g1', conversationTitle: 'Alpha B', messageCount: 1, senderCount: 1, lastMessageAt: '2026-10-30T04:00:00.000Z' },
      { accountId: 'acc-a', accountDisplayName: 'Account A', chatType: 'group', chatId: 'g1', conversationTitle: 'Alpha', messageCount: 6, senderCount: 6, lastMessageAt: '2026-10-30T03:00:00.000Z' },
    ]);
  });

  it('includes messages exactly at from and to, excludes one millisecond outside, and leaves the end open without to', async () => {
    const room = (await active()).chats.find((chat) => chat.chatId === 'r1');
    expect(room).toMatchObject({ messageCount: 2, lastMessageAt: TO });
    const open = (await repo.listActiveChats({ accountIds, from: FROM, limit: 200 })).chats.find((chat) => chat.chatId === 'r1');
    expect(open).toMatchObject({ messageCount: 3, senderCount: 3, lastMessageAt: '2026-10-30T06:00:00.001Z' });
    const narrow = await repo.listActiveChats({ accountIds, from: '2026-10-30T05:30:00.000Z', to: '2026-10-30T05:30:00.000Z', limit: 200 });
    expect(narrow.chats.map(key)).toEqual(['acc-a/direct/peer-1']);
    expect(narrow.chats[0]).toMatchObject({ messageCount: 1, lastMessageAt: '2026-10-30T05:30:00.000Z' });
  });

  it('never lists the local Agent room, and skips events without content', async () => {
    expect((await active()).chats.some((chat) => chat.chatId === '__local_agent_room__')).toBe(false);
    expect((await active({ chatType: 'direct' })).chats.map((chat) => chat.chatId)).toEqual(['peer-1']);
    expect((await allMessages({})).some((row) => row.chatId === '__local_agent_room__' || row.messageId === 'm9')).toBe(false);
    expect((await active()).chats.find((chat) => chat.chatId === 'g1' && chat.accountId === 'acc-a')?.messageCount).toBe(6);
  });

  it('applies each filter with hand-checked results', async () => {
    const summary = async (filters: Filters) => (await active(filters)).chats.map((chat) => `${key(chat)}=${chat.messageCount}/${chat.senderCount}@${chat.lastMessageAt.slice(11, 16)}`);
    expect(await summary({ direction: 'outbound' })).toEqual(['acc-a/group/g1=2/2@02:15']);
    expect(await summary({ direction: 'inbound' })).toEqual([
      'acc-a/room/r1=2/2@06:00', 'acc-a/direct/peer-1=2/1@05:30', 'acc-b/group/g1=1/1@04:00', 'acc-a/group/g1=4/4@03:00']);
    expect(await summary({ kinds: ['text'] })).toEqual(['acc-a/room/r1=2/2@06:00', 'acc-a/direct/peer-1=2/1@05:30', 'acc-a/group/g1=3/3@02:15']);
    expect(await summary({ excludeKinds: ['text'] })).toEqual(['acc-b/group/g1=1/1@04:00', 'acc-a/group/g1=3/3@03:00']);
    expect(await summary({ excludeChatIds: ['g1'] })).toEqual(['acc-a/room/r1=2/2@06:00', 'acc-a/direct/peer-1=2/1@05:30']);
    expect(await summary({ chatType: 'group' })).toEqual(['acc-b/group/g1=1/1@04:00', 'acc-a/group/g1=6/6@03:00']);
    expect(await summary({ kinds: ['image', 'sticker'], excludeChatIds: ['r1'], direction: 'inbound' })).toEqual(['acc-b/group/g1=1/1@04:00', 'acc-a/group/g1=2/2@03:00']);
  });

  it('keeps every filter off when an array is empty or absent', async () => {
    expect((await active({ excludeChatIds: [], kinds: [], excludeKinds: [] })).chats).toEqual((await active()).chats);
  });

  it.each<[string, Filters]>([
    ['no filter', {}],
    ['chat type', { chatType: 'group' }],
    ['excluded chats', { excludeChatIds: ['r1', 'peer-1'] }],
    ['outbound', { direction: 'outbound' }],
    ['inbound', { direction: 'inbound' }],
    ['kinds', { kinds: ['text'] }],
    ['excluded kinds', { excludeKinds: ['text', 'event'] }],
    ['combination', { direction: 'inbound', kinds: ['image', 'sticker', 'text'], excludeChatIds: ['peer-1'] }],
    ['combination with chat type', { chatType: 'group', direction: 'inbound', excludeKinds: ['image'] }],
  ])('has counts equal to the rows of the message query: %s', async (_label, filters) => {
    const rows = await allMessages(filters);
    const listed = (await active(filters)).chats;
    expect(listed.reduce((sum, chat) => sum + chat.messageCount, 0)).toBe(rows.length);
    const expected = new Map<string, { count: number; senders: Set<string>; last: string }>();
    for (const row of rows) {
      const entry = expected.get(key(row)) ?? { count: 0, senders: new Set<string>(), last: row.occurredAt };
      entry.count += 1;
      entry.senders.add(row.senderId);
      if (row.occurredAt > entry.last) entry.last = row.occurredAt;
      expected.set(key(row), entry);
    }
    expect(new Map(listed.map((chat) => [key(chat), { count: chat.messageCount, senders: chat.senderCount, last: chat.lastMessageAt }])))
      .toEqual(new Map([...expected].map(([chat, entry]) => [chat, { count: entry.count, senders: entry.senders.size, last: entry.last }])));
  });

  it('applies the direction filter with the rule of the direction field in the returned records', async () => {
    const all = await allMessages({});
    const outbound = await allMessages({ direction: 'outbound' });
    const inbound = await allMessages({ direction: 'inbound' });
    expect(outbound.map((row) => row.messageId)).toEqual(['m3', 'mN']);
    expect(outbound.every((row) => row.direction === 'outbound')).toBe(true);
    expect(inbound.every((row) => row.direction === 'inbound')).toBe(true);
    expect([...outbound, ...inbound].map((row) => row.messageId).sort()).toEqual(all.map((row) => row.messageId).sort());
    expect(all.filter((row) => row.direction === 'outbound').map((row) => row.messageId)).toEqual(outbound.map((row) => row.messageId));
  });

  it('pages each filter alone and combined over several pages without gaps or duplicates', async () => {
    const cases: Filters[] = [
      { excludeChatIds: ['g1'] }, { direction: 'inbound' }, { kinds: ['text', 'image'] }, { excludeKinds: ['text'] },
      { direction: 'inbound', excludeKinds: ['image'], excludeChatIds: ['peer-1'] },
    ];
    for (const filters of cases) {
      const single = await repo.queryTargetMessagePage({ accountIds, from: FROM, to: TO, order: 'asc', limit: 200, ...filters });
      expect(single.hasMore).toBe(false);
      let pages = 0;
      let after: { occurredAt: string; messageId: string } | undefined;
      const ids: string[] = [];
      for (;;) {
        const result = await repo.queryTargetMessagePage({ accountIds, from: FROM, to: TO, order: 'asc', limit: 2, ...filters, ...(after ? { after } : {}) });
        pages += 1;
        ids.push(...result.messages.map((row) => row.messageId));
        if (!result.hasMore) break;
        after = result.lastKey!;
      }
      expect(ids).toEqual(single.messages.map((row) => row.messageId));
      expect(new Set(ids).size).toBe(ids.length);
      if (single.messages.length > 2) expect(pages).toBeGreaterThanOrEqual(2);
      // Filtered messages never contain a value the filter should have removed.
      if (filters.excludeChatIds) expect(single.messages.some((row) => filters.excludeChatIds!.includes(row.chatId))).toBe(false);
      if (filters.kinds) expect(single.messages.every((row) => filters.kinds!.includes(row.kind))).toBe(true);
      if (filters.excludeKinds) expect(single.messages.some((row) => filters.excludeKinds!.includes(row.kind))).toBe(false);
      if (filters.direction) expect(single.messages.every((row) => row.direction === filters.direction)).toBe(true);
    }
  });

  it('limits the list and reports truncated only when more chats exist', async () => {
    const two = await active({ limit: 2 });
    expect(two.chats.map(key)).toEqual(['acc-a/room/r1', 'acc-a/direct/peer-1']);
    expect(two.truncated).toBe(true);
    const three = await active({ limit: 3 });
    expect(three.chats).toHaveLength(3);
    expect(three.truncated).toBe(true);
    const exact = await active({ limit: 4 });
    expect(exact.chats).toHaveLength(4);
    expect(exact.truncated).toBe(false);
    const one = await active({ limit: 1 });
    expect(one.chats.map(key)).toEqual(['acc-a/room/r1']);
    expect(one.truncated).toBe(true);
    expect((await repo.listActiveChats({ accountIds: [], from: FROM, limit: 10 }))).toEqual({ chats: [], truncated: false });
  });

  it('breaks ties of the newest time by chat type, chat id and account in a stable order', async () => {
    for (const [account, chatType, chatId] of [['acc-a', 'group', 'tie-b'], ['acc-a', 'group', 'tie-a'], ['acc-b', 'group', 'tie-a'], ['acc-a', 'direct', 'tie-z']] as const) {
      await pool.query('INSERT INTO conversations(account_id,chat_type,chat_id) VALUES ($1,$2,$3)', [account, chatType, chatId]);
    }
    await insert('acc-a', 'group', 'tie-b', 't1', 'u1', 'text', '2026-10-30T05:45:00.000Z');
    await insert('acc-a', 'group', 'tie-a', 't2', 'u1', 'text', '2026-10-30T05:45:00.000Z');
    await insert('acc-b', 'group', 'tie-a', 't3', 'u1', 'text', '2026-10-30T05:45:00.000Z');
    await insert('acc-a', 'direct', 'tie-z', 't4', 'u1', 'text', '2026-10-30T05:45:00.000Z');
    try {
      const first = (await active()).chats.slice(0, 5).map(key);
      expect(first).toEqual(['acc-a/room/r1', 'acc-a/direct/tie-z', 'acc-a/group/tie-a', 'acc-b/group/tie-a', 'acc-a/group/tie-b']);
      expect((await active()).chats.map(key)).toEqual((await active()).chats.map(key));
    } finally {
      await pool.query("DELETE FROM messages WHERE message_id IN ('t1','t2','t3','t4')");
      await pool.query("DELETE FROM conversations WHERE chat_id LIKE 'tie-%'");
    }
  });

  it('limits the visible chats with conversationScope and extraConversationScopes', async () => {
    const scope = { accountId: 'acc-a', chatType: 'group' as const, chatId: 'g1' };
    const own = await active({ accountIds: ['acc-a'], conversationScope: scope });
    expect(own.chats.map(key)).toEqual(['acc-a/group/g1']);
    const linked = await active({ accountIds: ['acc-a'], conversationScope: scope, extraConversationScopes: [{ chatType: 'room', chatId: 'r1' }] });
    expect(linked.chats.map(key)).toEqual(['acc-a/room/r1', 'acc-a/group/g1']);
    // A linked chat id on a chat type it does not have adds nothing.
    const wrongType = await active({ accountIds: ['acc-a'], conversationScope: scope, extraConversationScopes: [{ chatType: 'group', chatId: 'r1' }] });
    expect(wrongType.chats.map(key)).toEqual(['acc-a/group/g1']);
    // The scope never reaches another account.
    expect((await active({ accountIds: ['acc-b'], conversationScope: scope })).chats).toEqual([]);
    const scopedRows = await allMessages({}, { accountIds: ['acc-a'], conversationScope: scope, extraConversationScopes: [{ chatType: 'room', chatId: 'r1' }] });
    expect(scopedRows.length).toBe(linked.chats.reduce((sum, chat) => sum + chat.messageCount, 0));
  });

  it('uses the peer LINE name for a direct chat when only the principal\'s own LINE names are allowed', async () => {
    const full = (await active({ chatType: 'direct' })).chats[0];
    expect(full?.conversationTitle).toBe('Owner Nick');
    const own = (await active({ chatType: 'direct', ownLineNamesOnly: true })).chats[0];
    expect(own?.conversationTitle).toBe('Peer One');
    const ownRows = await allMessages({ chatType: 'direct' }, { ownLineNamesOnly: true });
    expect(ownRows.every((row) => row.conversationTitle === own?.conversationTitle)).toBe(true);
  });
});

database('listActiveChats merges the Agent account lineage like the message query', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: MessageRepository;
  const insert = (account: string, chatId: string, id: string, sender: string, at: string, kind = 'text') => pool.query(
    `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
     VALUES ($1,$2,$3,'group',$4,$5,$6,'t','history',$7,'{}')`, [account, id, `ev-${account}-${id}`, chatId, sender, kind, at]);

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new MessageRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,product_role) VALUES ('agent-new','New','mid-new','AGENT')");
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,role_revision,mode,status,connection_mode) VALUES ('agent-old','Old','mid-old',1,'MONITOR_ONLY','disconnected','OFFLINE')");
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('other','Other','mid-other')");
    await pool.query(`INSERT INTO agent_account_lineage(account_id,sequence,became_agent_at,retired_at)
      VALUES ('agent-old',1,now() - interval '2 days',now() - interval '1 day'),('agent-new',2,now() - interval '1 day',NULL)`);
    for (const [account, chatId, title] of [
      ['agent-old', 'shared', 'Old title'], ['agent-new', 'shared', 'New title'], ['agent-old', 'old-only', 'Old only'], ['other', 'shared', 'Other title'],
    ] as const) await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,$3)", [account, chatId, title]);
    await insert('agent-old', 'shared', 'm1', 'u1', '2026-10-01T00:00:00Z');
    await insert('agent-new', 'shared', 'm2', 'u2', '2026-10-02T00:00:00Z');
    await insert('agent-old', 'shared', 'dup', 'u1', '2026-10-03T00:00:00Z');
    await insert('agent-new', 'shared', 'dup', 'u1', '2026-10-03T00:00:00Z');
    await insert('agent-new', 'shared', 'm4', 'agent-sender', '2026-10-04T00:00:00Z', 'image');
    await insert('agent-old', 'old-only', 'o1', 'u7', '2026-10-05T00:00:00Z');
    await insert('other', 'shared', 'x1', 'u8', '2026-10-06T00:00:00Z');
  });
  afterAll(async () => { await close?.(); });

  it('merges one chat across the lineage with the current account key and title, counting a shared message once', async () => {
    const result = await repo.listActiveChats({ accountIds: ['agent-new'], from: '2026-10-01T00:00:00Z', limit: 200 });
    expect(result.chats).toEqual([
      { accountId: 'agent-old', accountDisplayName: 'Old', chatType: 'group', chatId: 'old-only', conversationTitle: 'Old only', messageCount: 1, senderCount: 1, lastMessageAt: '2026-10-05T00:00:00.000Z' },
      { accountId: 'agent-new', accountDisplayName: 'New', chatType: 'group', chatId: 'shared', conversationTitle: 'New title', messageCount: 4, senderCount: 3, lastMessageAt: '2026-10-04T00:00:00.000Z' },
    ]);
  });

  it('has the same total as the message query for the same window and filters', async () => {
    for (const filters of [{}, { kinds: ['text' as const] }, { excludeKinds: ['image' as const] }, { excludeChatIds: ['old-only'] }]) {
      const base = { accountIds: ['agent-new'], from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z', ...filters };
      const rows: string[] = [];
      let after: { occurredAt: string; messageId: string } | undefined;
      for (;;) {
        const page = await repo.queryTargetMessagePage({ ...base, order: 'asc', limit: 2, ...(after ? { after } : {}) });
        rows.push(...page.messages.map((row) => `${row.accountId}/${row.messageId}`));
        if (!page.hasMore) break;
        after = page.lastKey!;
      }
      const listed = (await repo.listActiveChats({ ...base, limit: 200 })).chats;
      expect(listed.reduce((sum, chat) => sum + chat.messageCount, 0)).toBe(rows.length);
      expect(new Set(rows.map((row) => row.split('/')[1])).size).toBe(rows.length);
    }
  });

  it('does not merge a chat of an account outside the lineage', async () => {
    const result = await repo.listActiveChats({ accountIds: ['agent-new', 'other'], from: '2026-10-01T00:00:00Z', limit: 200 });
    expect(result.chats.map((chat) => `${chat.accountId}/${chat.chatId}`)).toEqual(['other/shared', 'agent-old/old-only', 'agent-new/shared']);
  });

  it('keeps the lineage merge inside a chat scope and its linked chats', async () => {
    const scoped = await repo.listActiveChats({
      accountIds: ['agent-new'], from: '2026-10-01T00:00:00Z', limit: 200,
      conversationScope: { accountId: 'agent-new', chatType: 'group', chatId: 'shared' },
    });
    expect(scoped.chats.map((chat) => `${chat.accountId}/${chat.chatId}=${chat.messageCount}`)).toEqual(['agent-new/shared=4']);
    const linked = await repo.listActiveChats({
      accountIds: ['agent-new'], from: '2026-10-01T00:00:00Z', limit: 200,
      conversationScope: { accountId: 'agent-new', chatType: 'group', chatId: 'shared' },
      extraConversationScopes: [{ chatType: 'group', chatId: 'old-only' }],
    });
    expect(linked.chats.map((chat) => chat.chatId)).toEqual(['old-only', 'shared']);
  });
});
