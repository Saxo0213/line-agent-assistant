import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { InboundEnvelope } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase } from './test-database.js';
import { plainEnvelope } from './content-bridge/test-support.js';
import { formatContactCardBlock, parseStoredContact, promptWithContactCards, recentContactCards } from './agent-contact-cards.js';

const MID = 'u0123456789abcdef0123456789abcdef';
const text = (messageId: string, occurredAt: string, patch: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: `ev-${messageId}`, accountId: 'acc', chatType: 'direct', chatId: 'uadmin', senderId: 'uadmin', messageId, kind: 'text', text: '我有修改他的暱稱了',
  mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null }, occurredAt, attachments: [], raw: {}, ...patch,
} as InboundEnvelope);
const cardEnvelope = (messageId: string, occurredAt: string, mid: string, displayName: string): InboundEnvelope =>
  text(messageId, occurredAt, { kind: 'contact', text: null, contact: { mid, displayName } } as Partial<InboundEnvelope>);

type Row = { message_id: string; occurred_at: Date; content: unknown; raw: unknown };
/** Answers the two queries of recentContactCards: the previous job's message time and the stored contact messages. */
function fakeDb(previousJobAt: string | null, cards: Row[]) {
  return {
    async query<R extends Record<string, unknown>>(sql: string): Promise<{ rows: R[] }> {
      if (sql.includes('FROM agent_jobs')) return { rows: (previousJobAt ? [{ occurred_at: new Date(previousJobAt) }] : []) as unknown as R[] };
      return { rows: cards as unknown as R[] };
    },
  };
}
const stored = (messageId: string, at: string, raw: unknown, content: unknown = null): Row => ({ message_id: messageId, occurred_at: new Date(at), content, raw });

describe('contact card parsing', () => {
  it('reads the projected content and the live loginContact raw; unreadable rows are not cards', () => {
    expect(parseStoredContact({ format: 1, type: 'contact', mid: MID, displayName: '徐佳誠' }, {})).toEqual({ mid: MID, displayName: '徐佳誠' });
    expect(parseStoredContact(null, { loginContact: { mid: MID, displayName: '徐佳誠' } })).toEqual({ mid: MID, displayName: '徐佳誠' });
    const native = plainEnvelope({ _id: 'x', _contentType: 13, _contentMetadata: JSON.stringify({ mid: MID, displayName: '徐佳誠' }) });
    expect(parseStoredContact(null, { message: { id: 'x', contentType: 13 }, native })).toEqual({ mid: MID, displayName: '徐佳誠' });
    expect(parseStoredContact(null, native)).toEqual({ mid: MID, displayName: '徐佳誠' });
    expect(parseStoredContact(null, { format: 2, encoding: 'plain', table: '_message' })).toBeNull();
    expect(parseStoredContact(null, {})).toBeNull();
  });
  it('formats one line per card', () => {
    expect(formatContactCardBlock([{ mid: MID, displayName: '徐佳誠' }, { mid: null, displayName: 'A' }])).toBe(`[聯絡人卡片] 徐佳誠（mid: ${MID}）\n[聯絡人卡片] A`);
  });
});

describe('contact cards in the job prompt (query results)', () => {
  const current = text('m-text', '2026-10-28T02:10:00.000Z');
  it('adds the cards shared after the previous Agent job, oldest first', async () => {
    const db = fakeDb('2026-10-28T02:00:00.000Z', [
      stored('c2', '2026-10-28T02:08:00.000Z', { loginContact: { mid: MID, displayName: '徐佳誠' } }),
      stored('c1', '2026-10-28T02:05:00.000Z', { loginContact: { mid: 'u2', displayName: '王小明' } })]);
    expect(await promptWithContactCards(db, current, 'ask')).toBe(`ask\n\n[聯絡人卡片] 王小明（mid: u2）\n[聯絡人卡片] 徐佳誠（mid: ${MID}）`);
  });
  it('excludes a card older than the previous job or the 30 minute window', async () => {
    const db = fakeDb('2026-10-28T02:07:00.000Z', [stored('old', '2026-10-28T02:05:00.000Z', { loginContact: { mid: MID, displayName: '舊' } })]);
    expect(await recentContactCards(db, current)).toEqual([]);
    expect(await promptWithContactCards(db, current, 'ask')).toBe('ask');
    const windowDb = fakeDb(null, [stored('far', '2026-10-28T01:30:00.000Z', { loginContact: { mid: MID, displayName: '遠' } })]);
    expect(await recentContactCards(windowDb, current)).toEqual([]);
  });
  it('keeps at most the last three cards and includes same-batch cards', async () => {
    const db = fakeDb(null, ['a', 'b', 'c'].map((id, i) => stored(id, `2026-10-28T02:0${i + 1}:00.000Z`, { loginContact: { mid: `u-${id}`, displayName: id } })));
    const cards = await recentContactCards(db, current, [cardEnvelope('d', '2026-10-28T02:09:00.000Z', 'u-d', 'd')]);
    expect(cards.map((card) => card.messageId)).toEqual(['b', 'c', 'd']);
  });
  it('adds nothing when the trigger is not a text message', async () => {
    const db = fakeDb(null, [stored('c', '2026-10-28T02:05:00.000Z', { loginContact: { mid: MID, displayName: 'x' } })]);
    expect(await promptWithContactCards(db, cardEnvelope('c2', '2026-10-28T02:09:00.000Z', MID, 'x'), 'p')).toBe('p');
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('contact cards on PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await new AccountRepository(pool).ensureAccount('acc');
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ('acc','direct','uadmin','管理員')");
    const insert = (id: string, kind: string, at: string, sender: string, raw: unknown) => pool.query(
      `INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
       VALUES ('acc',$1,$2,'direct','uadmin',$3,$4,NULL,'live',$5,$6)`, [id, `ev-${id}`, sender, kind, at, JSON.stringify(raw)]);
    await insert('card-old', 'contact', '2026-10-28T02:01:00.000Z', 'uadmin', { loginContact: { mid: 'u-old', displayName: '舊卡' } });
    await insert('ask-1', 'text', '2026-10-28T02:03:00.000Z', 'uadmin', {});
    await insert('card-new', 'contact', '2026-10-28T02:05:00.000Z', 'uadmin', { loginContact: { mid: MID, displayName: '徐佳誠' } });
    await insert('card-other', 'contact', '2026-10-28T02:06:00.000Z', 'someone-else', { loginContact: { mid: 'u-x', displayName: '別人' } });
    await pool.query(`INSERT INTO agent_jobs(job_id,account_id,chat_type,chat_id,provider,source_type,source_message_id,prompt,workspace_path,generation,status,creation_epoch)
      VALUES (gen_random_uuid(),'acc','direct','uadmin','codex','line','ask-1','ask','C:\\w',1,'completed',0)`);
  });
  afterAll(async () => { await close?.(); });
  it('returns only the sender cards that arrived after the previous job of the chat', async () => {
    const next = text('ask-2', '2026-10-28T02:10:00.000Z');
    expect((await recentContactCards(pool, next)).map((card) => card.messageId)).toEqual(['card-new']);
    expect(await promptWithContactCards(pool, next, '我有修改他的暱稱了')).toBe(`我有修改他的暱稱了\n\n[聯絡人卡片] 徐佳誠（mid: ${MID}）`);
  });
});
