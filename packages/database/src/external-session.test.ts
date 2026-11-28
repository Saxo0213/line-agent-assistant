import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ExternalSessionRepository } from './external-session-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('External session replies (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: ExternalSessionRepository;
  const KEY = 'session-key-0001';

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new ExternalSessionRepository(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await repo.upsertSession(client, { accountId: 'acc-agent', sessionKey: KEY, label: 'Build' });
      await client.query('COMMIT');
    } finally { client.release(); }
  });
  afterAll(async () => { await close(); });

  it('gives each session of an account the next seq and keeps it on a later call', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const second = await repo.upsertSession(client, { accountId: 'acc-agent', sessionKey: 'session-key-0002', label: 'Other' });
      const again = await repo.upsertSession(client, { accountId: 'acc-agent', sessionKey: KEY, label: 'Renamed' });
      await client.query('COMMIT');
      expect(second.seq).toBe(2);
      expect(again).toMatchObject({ seq: 1, label: 'Build' });
    } finally { client.release(); }
  });

  it('writes a reply once for an inbound message and marks it delivered once', async () => {
    const first = await repo.insertReply({ sessionKey: KEY, source: 'quote', inboundMessageId: 'in-1', text: 'hello', attachmentIds: [] });
    const repeat = await repo.insertReply({ sessionKey: KEY, source: 'agent', inboundMessageId: 'in-1', text: 'other', attachmentIds: [], note: 'n' });
    expect(first.inserted).toBe(true);
    expect(repeat).toMatchObject({ inserted: false, reply: { replyId: first.reply.replyId, text: 'hello', source: 'quote' } });
    const taken = await repo.takeUndeliveredReplies(KEY);
    expect(taken.map((reply) => reply.text)).toEqual(['hello']);
    expect(taken[0]!.deliveredAt).not.toBeNull();
    expect(await repo.takeUndeliveredReplies(KEY)).toEqual([]);
    expect((await repo.listReplies(KEY)).map((reply) => reply.replyId)).toEqual([first.reply.replyId]);
  });

  it('allows only delivered_at to change, and only from NULL to a time', async () => {
    const { reply } = await repo.insertReply({ sessionKey: KEY, source: 'quote', inboundMessageId: 'in-2', text: 'secret', attachmentIds: [] });
    await expect(pool.query("UPDATE external_session_replies SET text = 'changed' WHERE reply_id = $1", [reply.replyId])).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE external_session_replies SET delivered_at = now(), note = 'x' WHERE reply_id = $1", [reply.replyId])).rejects.toThrow(/append-only/);
    await pool.query('UPDATE external_session_replies SET delivered_at = clock_timestamp() WHERE reply_id = $1', [reply.replyId]);
    await expect(pool.query('UPDATE external_session_replies SET delivered_at = NULL WHERE reply_id = $1', [reply.replyId])).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE external_session_replies SET delivered_at = now() + interval '1 hour' WHERE reply_id = $1", [reply.replyId])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM external_session_replies WHERE reply_id = $1', [reply.replyId])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE external_session_replies')).rejects.toThrow(/append-only/);
    const row = await pool.query<{ text: string }>('SELECT text FROM external_session_replies WHERE reply_id = $1', [reply.replyId]);
    expect(row.rows[0]!.text).toBe('secret');
  });
});
