import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { MessageRepository } from './message-repository.js';

describe('message sticker projection', () => {
  it('projects only a validated sticker descriptor from the stored raw LINE message', async () => {
    const repository = new MessageRepository({ query: async () => ({ rows: [{
      account_id: 'account-A', chat_type: 'group', chat_id: 'chat-A', message_id: 'message-A', sender_id: 'sender-A',
      text_content: null, occurred_at: new Date('2026-10-17T00:00:00.000Z'), kind: 'sticker',
      raw: { message: { contentMetadata: { STKID: '123456', STKOPT: 'A', STKTXT: 'Hello\u0000 sticker' } } },
    }] }) } as unknown as Pool);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };

    const page = await repository.listMessages(key, null, 10);

    expect(page.messages[0]).toMatchObject({ kind: 'sticker', sticker: {
      stickerId: '123456', animated: true, altText: 'Hello sticker',
    } });
    expect(JSON.stringify(page.messages[0])).not.toContain('contentMetadata');
    expect(JSON.stringify(page.messages[0])).not.toContain('STKID');
  });

  it('keeps malformed or missing sticker metadata nullable and selects static unless STKOPT is exactly A', async () => {
    const rows = [
      { message_id: 'missing-id', raw: { message: { contentMetadata: { STKOPT: 'A' } } } },
      { message_id: 'malformed-id', raw: { message: { contentMetadata: { STKID: '12/3', STKOPT: 'A' } } } },
      { message_id: 'static-option', raw: { message: { contentMetadata: { STKID: '123', STKOPT: 'a' } } } },
      { message_id: 'missing-option', raw: { message: { contentMetadata: { STKID: '456' } } } },
    ];
    const repository = new MessageRepository({ query: async () => ({ rows: rows.map((row) => ({
      account_id: 'account-A', chat_type: 'group', chat_id: 'chat-A', sender_id: 'sender-A', text_content: null,
      occurred_at: new Date('2026-10-17T00:00:00.000Z'), kind: 'sticker', ...row,
    })) }) } as unknown as Pool);
    const page = await repository.listMessages({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, null, 10);

    expect(page.messages.map((message) => [message.messageId, message.sticker])).toEqual([
      ['missing-option', { stickerId: '456', animated: false, altText: null }],
      ['static-option', { stickerId: '123', animated: false, altText: null }], ['malformed-id', null], ['missing-id', null],
    ]);
  });

  it('projects stored mention ranges in the existing page query and ignores malformed ranges', async () => {
    let queryCount = 0;
    let listQuery = '';
    const repository = new MessageRepository({ query: async (sql: string) => {
      queryCount++;
      listQuery = sql;
      return { rows: [
        { account_id: 'account-A', chat_type: 'group', chat_id: 'chat-A', message_id: 'message-A', sender_id: 'sender-A',
          text_content: 'A😀B', occurred_at: new Date('2026-10-17T00:00:00.000Z'), kind: 'text', raw: {},
          mention_ranges: [{ start: 3, end: 4, userId: 'user-B' }, { start: 1, end: 3, userId: 'user-A' },
            { start: 2, end: 3, userId: 'split-surrogate' }, { start: 1, end: 4, userId: 'overlap' },
            { start: 1, end: 3, userId: '' }, { start: -1, end: 1, userId: 'invalid' }] },
        { account_id: 'account-A', chat_type: 'group', chat_id: 'chat-A', message_id: 'message-B', sender_id: 'sender-A',
          text_content: 'plain text', occurred_at: new Date('2026-10-17T00:00:01.000Z'), kind: 'text', raw: {} },
      ] };
    } } as unknown as Pool);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };

    const page = await repository.listMessages(key, null, 10);

    expect(queryCount).toBe(1);
    expect(listQuery).toContain('m.mention_ranges');
    expect(page.messages.map((message) => message.mentionRanges)).toEqual([
      [], [{ start: 1, end: 3, userId: 'user-A' }, { start: 3, end: 4, userId: 'user-B' }],
    ]);
  });
});
