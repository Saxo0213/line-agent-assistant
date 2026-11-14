import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('messages.recalled_at trigger (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;

  const insert = (messageId: string, content: object) =>
    pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw, content)
       VALUES ('acc-recall',$1,$2,'chat-1','group','mid-x','text','original text','live',now(),'{}'::jsonb,$3::jsonb)`,
      [messageId, `ev-${messageId}`, JSON.stringify(content)]);
  const setContent = (messageId: string, content: object) =>
    pool.query("UPDATE messages SET content=$2::jsonb WHERE account_id='acc-recall' AND message_id=$1", [messageId, JSON.stringify(content)]);
  const recalledAt = async (messageId: string) => {
    const result = await pool.query<{ recalled_at: Date | null; text_content: string | null }>(
      "SELECT recalled_at, text_content FROM messages WHERE account_id='acc-recall' AND message_id=$1", [messageId]);
    return result.rows[0]!;
  };
  const text = { format: 1, type: 'text', text: 'original text' };
  const unsent = { format: 1, type: 'unsent' };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await new AccountRepository(pool).ensureAccount('acc-recall');
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id, title, updated_at) VALUES ('acc-recall','group','chat-1','Room',now())");
  });
  afterAll(async () => { await close(); });

  it('sets recalled_at when a stored message changes to unsent and keeps the text', async () => {
    await insert('m-recall', text);
    expect((await recalledAt('m-recall')).recalled_at).toBeNull();
    await setContent('m-recall', unsent);
    const row = await recalledAt('m-recall');
    expect(row.recalled_at).toBeInstanceOf(Date);
    expect(row.text_content).toBe('original text');
  });

  it('keeps the same recalled_at when an unsent row is written again', async () => {
    await insert('m-twice', text);
    await setContent('m-twice', unsent);
    const first = (await recalledAt('m-twice')).recalled_at;
    await pool.query("SELECT pg_sleep(0.05)");
    await setContent('m-twice', unsent);
    await pool.query("UPDATE messages SET recalled_at=NULL WHERE account_id='acc-recall' AND message_id='m-twice'");
    expect((await recalledAt('m-twice')).recalled_at?.getTime()).toBe(first?.getTime());
  });

  it('leaves recalled_at NULL for a row first stored already unsent', async () => {
    await insert('m-born', unsent);
    expect((await recalledAt('m-born')).recalled_at).toBeNull();
    await setContent('m-born', unsent);
    expect((await recalledAt('m-born')).recalled_at).toBeNull();
  });

  it('clears recalled_at when the content changes back to a non-unsent type', async () => {
    await insert('m-back', text);
    await setContent('m-back', unsent);
    expect((await recalledAt('m-back')).recalled_at).not.toBeNull();
    await setContent('m-back', text);
    expect((await recalledAt('m-back')).recalled_at).toBeNull();
  });
});
