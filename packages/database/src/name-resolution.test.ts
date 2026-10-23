import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { CONVERSATION_PICTURE_SQL, SENDER_NAME_SQL, SENDER_PICTURE_SQL, conversationPictureSql, ownMessageSql, senderNameSql, senderPictureSql, upsertLineContacts } from './name-resolution.js';

describe('sender name SQL aliases', () => {
  it('builds the default and quoted sender SQL from the same alias-aware rule', () => {
    expect(senderNameSql()).toBe(SENDER_NAME_SQL);
    expect(senderNameSql({ m: 'qm', la: 'qla', c: 'qc', cm: 'qcm', senderContact: 'quoted_sender_contact', peerContact: 'quoted_peer_contact' }))
      .toContain('qm.sender_id');
  });
});

describe('picture SQL aliases', () => {
  it('uses one sender picture rule with parameterized aliases', () => {
    expect(senderPictureSql()).toBe(SENDER_PICTURE_SQL);
    expect(SENDER_PICTURE_SQL).toContain('THEN la.picture_path');
    expect(SENDER_PICTURE_SQL).toContain("WHEN m.chat_type IN ('community', 'thread') THEN cm.picture_path");
    expect(SENDER_PICTURE_SQL).toContain('COALESCE(c.picture_path, peer_contact.picture_path, sender_contact.picture_path, cm.picture_path)');
    expect(senderPictureSql({ m: 'qm', la: 'qla', c: 'qc', cm: 'qcm', senderContact: 'sc', peerContact: 'pc' }))
      .toContain('COALESCE(qc.picture_path, pc.picture_path, sc.picture_path, qcm.picture_path)');
  });

  it('uses conversation picture, direct peer contact picture, then own account picture for the own direct chat', () => {
    expect(conversationPictureSql()).toBe(CONVERSATION_PICTURE_SQL);
    expect(CONVERSATION_PICTURE_SQL).toContain('COALESCE(c.picture_path, peer_contact.picture_path');
    expect(CONVERSATION_PICTURE_SQL).toContain("CASE WHEN c.chat_type = 'direct' AND c.chat_id = la.own_mid THEN la.picture_path END");
    expect(conversationPictureSql({ c: 'qc', la: 'qla', peerContact: 'pc' })).toContain('qc.chat_id = qla.own_mid THEN qla.picture_path');
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('single read entry for person and conversation names', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let messages: MessageRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    messages = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    for (const [accountId, mid, name] of [['acct-a', 'mid-a', 'Agent A'], ['acct-b', 'mid-b', 'Agent B']] as const) {
      await accounts.ensureAccount(accountId);
      await accounts.setOwnMid(accountId, mid);
      await pool.query('UPDATE line_accounts SET display_name=$2 WHERE account_id=$1', [accountId, name]);
    }
  });
  afterAll(async () => { await close?.(); });

  let sequence = 0;
  async function conversation(accountId: string, chatType: string, chatId: string, title: string) {
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [accountId, chatType, chatId, title]);
  }
  async function member(accountId: string, chatType: string, chatId: string, memberId: string, displayName: string | null) {
    await pool.query(`INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id,display_name) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(account_id,chat_type,chat_id,member_id) DO UPDATE SET display_name=EXCLUDED.display_name`, [accountId, chatType, chatId, memberId, displayName]);
  }
  async function message(accountId: string, chatType: string, chatId: string, senderId: string, text: string) {
    const id = `message-${++sequence}`;
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES($1,$2,$3,$4,$5,$6,'text',$7,'[]'::jsonb,'[]'::jsonb,'history',now() + ($8 || ' seconds')::interval,'{}'::jsonb)`,
    [accountId, id, `event-${id}`, chatType, chatId, senderId, text, String(sequence)]);
    return id;
  }

  it('applies one sender rule: contact nickname, then profile name, then member name, then direct title; own and community differ', async () => {
    await upsertLineContacts(pool, 'acct-a', [{ mid: 'u-friend', displayName: 'Real Name', nickname: '張襄君' },
      { mid: 'u-plain', displayName: 'Plain Name' }, { mid: 'u-sq', displayName: 'Contact Name', nickname: 'Contact Nick' }]);
    await conversation('acct-a', 'group', 'c-group', 'Team');
    await member('acct-a', 'group', 'c-group', 'u-friend', 'Member Name');
    await member('acct-a', 'group', 'c-group', 'u-nobody', 'Only Member');
    await conversation('acct-a', 'direct', 'u-friend', '');
    await conversation('acct-a', 'community', 'sq-chat', 'Square');
    await member('acct-a', 'community', 'sq-chat', 'u-sq', 'Community Profile');
    const ids = {
      groupFriend: await message('acct-a', 'group', 'c-group', 'u-friend', 'nick sender'),
      groupMember: await message('acct-a', 'group', 'c-group', 'u-nobody', 'member sender'),
      own: await message('acct-a', 'group', 'c-group', 'mid-a', 'own message'),
      direct: await message('acct-a', 'direct', 'u-friend', 'u-friend', 'direct sender'),
      community: await message('acct-a', 'community', 'sq-chat', 'u-sq', 'community sender'),
    };
    const results = await messages.queryTargetMessages({ accountIds: ['acct-a'], limit: 50 });
    const nameOf = (id: string) => results.find((row) => row.messageId === id)?.senderName;
    expect(nameOf(ids.groupFriend)).toBe('張襄君');
    expect(nameOf(ids.groupMember)).toBe('Only Member');
    expect(nameOf(ids.own)).toBe('Agent A');
    expect(nameOf(ids.direct)).toBe('張襄君');
    expect(nameOf(ids.community)).toBe('Community Profile');

    const searched = await messages.searchMessages({ accountId: 'acct-a', limit: 50 });
    const searchedName = (id: string) => searched.find((row) => row.messageId === id)?.senderName;
    expect(searchedName(ids.groupFriend)).toBe('張襄君');
    expect(searchedName(ids.direct)).toBe('張襄君');
    expect(searchedName(ids.own)).toBe('Agent A');
    expect(searchedName(ids.community)).toBe('Community Profile');
    // The direct chat has an empty stored title; the contact rule supplies it everywhere.
    expect(searched.find((row) => row.messageId === ids.direct)?.conversationTitle).toBe('張襄君');
  });

  it('finds a friend by nickname or profile name in search, targets and message queries', async () => {
    const found = await messages.searchMessages({ accountId: 'acct-a', text: '張襄君', limit: 50 });
    expect(found.map((row) => row.text).sort()).toEqual(['direct sender', 'nick sender']);
    expect((await messages.searchMessages({ accountId: 'acct-a', text: 'real name', limit: 50 })).map((row) => row.text).sort())
      .toEqual(['direct sender', 'nick sender']);
    const targets = await messages.listConversationTargets({ accountIds: ['acct-a'], query: '張襄君' });
    expect(targets.map((row) => `${row.chatType}:${row.chatId}`).sort()).toEqual(['direct:u-friend', 'group:c-group']);
    expect(targets.find((row) => row.chatId === 'u-friend')?.conversationTitle).toBe('張襄君');
    expect(targets.find((row) => row.chatId === 'c-group')?.members).toEqual(expect.arrayContaining([
      { memberId: 'u-friend', displayName: '張襄君' }, { memberId: 'u-nobody', displayName: 'Only Member' }]));
    const byTarget = await messages.queryTargetMessages({ accountIds: ['acct-a'], target: '張襄君', limit: 50 });
    expect(byTarget.map((row) => row.text).sort()).toEqual(expect.arrayContaining(['direct sender', 'nick sender']));
    const bySender = await messages.queryTargetMessages({ accountIds: ['acct-a'], senderName: '張襄', limit: 50 });
    expect(bySender.map((row) => row.text).sort()).toEqual(['direct sender', 'nick sender']);
    // Community contact nicknames never apply: the contact nickname is not searchable by sender name there.
    expect(await messages.queryTargetMessages({ accountIds: ['acct-a'], senderName: 'Contact Nick', limit: 50 })).toEqual([]);
  });

  it('projects authoritative ownership for unnamed direct, group, and native community senders without rewriting records', async () => {
    await pool.query("UPDATE line_accounts SET display_name=NULL WHERE account_id='acct-a'");
    try {
      const ids: string[] = [];
      for (const chatType of ['direct', 'group', 'community'] as const) {
        const chatId = `ownership-${chatType}`;
        await conversation('acct-a', chatType, chatId, 'Peer title');
        ids.push(await message('acct-a', chatType, chatId, 'mid-a', 'ownership'));
      }
      for (const status of ['2', '4']) {
        const id = await message('acct-a', 'community', 'ownership-community', 'community-self', 'ownership');
        await pool.query('UPDATE messages SET raw=$2::jsonb WHERE account_id=$1 AND message_id=$3', ['acct-a',
          JSON.stringify({ native: { row: { columns: ['_status'], cells: [{ value: status }] } } }), id]);
        ids.push(id);
      }
      const peerId = await message('acct-a', 'group', 'ownership-group', 'named-peer', 'ownership');
      await member('acct-a', 'group', 'ownership-group', 'named-peer', '原始對方');
      const read = () => messages.searchMessages({ accountId: 'acct-a', text: 'ownership', limit: 50 });
      const unnamed = await read();
      for (const id of ids) expect(unnamed.find((row) => row.messageId === id)).toMatchObject({ isOwn: true, senderName: null });
      expect(unnamed.find((row) => row.messageId === peerId)).toMatchObject({ isOwn: false, senderName: '原始對方' });
      await pool.query("UPDATE line_accounts SET display_name='原始自己' WHERE account_id='acct-a'");
      await member('acct-a', 'community', 'ownership-community', 'community-self', 'Community self');
      const named = await read();
      for (const id of ids.slice(0, 3)) expect(named.find((row) => row.messageId === id)).toMatchObject({ isOwn: true, senderName: '原始自己' });
      for (const id of ids.slice(3)) expect(named.find((row) => row.messageId === id)).toMatchObject({ isOwn: true, senderName: 'Community self' });
      expect((await pool.query("SELECT DISTINCT text_content FROM messages WHERE account_id='acct-a' AND message_id=ANY($1::text[])", [ids])).rows).toEqual([{ text_content: 'ownership' }]);
    } finally {
      await pool.query("UPDATE line_accounts SET display_name='Agent A' WHERE account_id='acct-a'");
    }
  });

  it('keeps the same MID with different nicknames isolated per account', async () => {
    await upsertLineContacts(pool, 'acct-b', [{ mid: 'u-friend', displayName: 'Real Name', nickname: 'Other Nick' }]);
    await conversation('acct-b', 'direct', 'u-friend', '');
    const id = await message('acct-b', 'direct', 'u-friend', 'u-friend', 'b direct');
    const rows = await messages.queryTargetMessages({ accountIds: ['acct-a', 'acct-b'], limit: 100 });
    expect(rows.find((row) => row.messageId === id)?.senderName).toBe('Other Nick');
    expect(rows.filter((row) => row.accountId === 'acct-a' && row.chatId === 'u-friend').map((row) => row.senderName)).toEqual(['張襄君']);
    expect(await messages.searchMessages({ accountId: 'acct-b', text: '張襄君', limit: 50 })).toEqual([]);
  });

  it('upserts contacts idempotently, never blanks a known name, and clears a nickname only when the source says so', async () => {
    expect(await upsertLineContacts(pool, 'acct-a', [{ mid: 'u-idem', displayName: 'Idem', nickname: 'Nick', nativeType: 1, nativeStatus: 0, picturePath: '/friend-photo' }])).toBe(1);
    expect(await upsertLineContacts(pool, 'acct-a', [{ mid: 'u-idem', displayName: 'Idem', nickname: 'Nick', nativeType: 1, nativeStatus: 0, picturePath: '/friend-photo' }])).toBe(0);
    // A response without the fields keeps what is stored.
    await upsertLineContacts(pool, 'acct-a', [{ mid: 'u-idem', displayName: null }]);
    expect((await pool.query('SELECT display_name,nickname,native_type,picture_path FROM line_contacts WHERE account_id=$1 AND mid=$2', ['acct-a', 'u-idem'])).rows[0])
      .toEqual({ display_name: 'Idem', nickname: 'Nick', native_type: 1, picture_path: 'https://profile.line-scdn.net/friend-photo' });
    // The source states there is no nickname any more.
    await upsertLineContacts(pool, 'acct-a', [{ mid: 'u-idem', displayName: 'Idem', nickname: null }]);
    expect((await pool.query('SELECT nickname FROM line_contacts WHERE account_id=$1 AND mid=$2', ['acct-a', 'u-idem'])).rows[0]).toEqual({ nickname: null });
    // Oversized names are bounded, invalid MIDs skipped.
    expect(await upsertLineContacts(pool, 'acct-a', [{ mid: '', displayName: 'x' }, { mid: 'u-long', displayName: 'L'.repeat(300) }])).toBe(1);
    expect((await pool.query('SELECT length(display_name) AS n FROM line_contacts WHERE account_id=$1 AND mid=$2', ['acct-a', 'u-long'])).rows[0]).toEqual({ n: 256 });
  });

  it('detects own native community messages by status and live messages by sender, safely ignoring malformed native columns', async () => {
    const ownSql = ownMessageSql('m', 'la');
    const evalRow = async (sender: string, ownMid: string | null, raw: unknown) => (await pool.query<{ is_own: boolean }>(
      `SELECT ${ownSql} AS is_own FROM (SELECT $1::text sender_id,$3::jsonb raw) m CROSS JOIN (SELECT $2::text own_mid) la`,
      [sender, ownMid, JSON.stringify(raw)])).rows[0]!.is_own;
    const native = (status: number) => ({ native: { encoding: 'plain', table: '_message', row: {
      columns: ['_status'], cells: [{ value: status, sqliteType: 'integer' }],
    } } });
    expect(await evalRow('member', 'self', native(2))).toBe(true);
    expect(await evalRow('member', 'self', native(1))).toBe(false);
    expect(await evalRow('member', 'self', native(4))).toBe(true);
    expect(await evalRow('self', 'self', { message: { text: 'live' } })).toBe(true);
    expect(await evalRow('member', 'self', { message: { text: 'live' } })).toBe(false);
    expect(await evalRow('member', 'self', { native: { row: { columns: 'broken', cells: [] } } })).toBe(false);
  });

  it('returns outbound direction for an own native community row in MCP message queries', async () => {
    await conversation('acct-a', 'community', 'mcp-direction', 'Community');
    const id = await message('acct-a', 'community', 'mcp-direction', 'p-self', 'own community message');
    const raw = { native: { format: 2, encoding: 'plain', table: '_message', row: {
      columns: ['_status'], cells: [{ value: 2, sqliteType: 'integer' }],
    } } };
    await pool.query('UPDATE messages SET raw=$3::jsonb WHERE account_id=$1 AND message_id=$2', ['acct-a', id, JSON.stringify(raw)]);
    const results = await messages.queryTargetMessages({ accountIds: ['acct-a'], chatType: 'community', chatId: 'mcp-direction', limit: 10 });
    expect(results.find((row) => row.messageId === id)?.direction).toBe('outbound');
  });

  it('cascades contacts with their account', async () => {
    await new AccountRepository(pool).ensureAccount('acct-gone');
    await upsertLineContacts(pool, 'acct-gone', [{ mid: 'u-x', displayName: 'X' }]);
    await pool.query('DELETE FROM line_accounts WHERE account_id=$1', ['acct-gone']);
    expect((await pool.query('SELECT count(*) FROM line_contacts WHERE account_id=$1', ['acct-gone'])).rows[0]?.count).toBe('0');
  });
});
