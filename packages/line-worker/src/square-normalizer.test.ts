import { describe, expect, it } from 'vitest';
import { normalizeSquareEvents } from './square-normalizer.js';

const CHAT = `m${'a'.repeat(32)}`;
const MEMBER = `p${'b'.repeat(32)}`;
const context = { accountId: 'account-A' };

function message(id: string, overrides: Record<string, unknown> = {}) {
  return { from: MEMBER, to: CHAT, toType: 4, id, createdTime: 1_700_000_000_000n, contentType: 0, text: `text ${id}`,
    contentMetadata: {}, ...overrides };
}
function event(type: number, key: string, id: string, body: Record<string, unknown> = {}, messageOverrides: Record<string, unknown> = {},
  squareMessage: Record<string, unknown> = {}) {
  return { type, createdTime: 1n, syncToken: 'token', payload: { [key]: { squareChatMid: CHAT, senderDisplayName: 'Alice',
    squareMessage: { message: message(id, messageOverrides), ...squareMessage }, ...body } } };
}

describe('normalizeSquareEvents', () => {
  it('maps a received message to a community envelope with Talk-shaped raw', () => {
    const { envelopes, counts } = normalizeSquareEvents([event(0, 'receiveMessage', '100')], context);
    expect(counts).toMatchObject({ events: 1, ignored: 0, thread: 0, duplicate: 0, invalid: 0 });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      eventId: '100', accountId: 'account-A', chatId: CHAT, chatType: 'community', senderId: MEMBER, senderName: 'Alice',
      messageId: '100', kind: 'text', text: 'text 100', replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: new Date(1_700_000_000_000).toISOString(), attachments: [],
    });
    expect(envelopes[0]!.raw).toMatchObject({ message: { id: '100', from: MEMBER, createdTime: '1700000000000', text: 'text 100' },
      square: { eventType: 'RECEIVE_MESSAGE', own: false } });
  });

  it('uses the ingestion source of the context, live by default', () => {
    expect(normalizeSquareEvents([event(0, 'receiveMessage', '90')], context).envelopes[0]!.ingestion).toEqual({ source: 'live', cursor: null });
    expect(normalizeSquareEvents([event(0, 'receiveMessage', '90')], { ...context, source: 'history' }).envelopes[0]!.ingestion)
      .toEqual({ source: 'history', cursor: null });
  });

  it('marks only a sent message as own', () => {
    const { envelopes } = normalizeSquareEvents([event(1, 'sendMessage', '101'), event(29, 'notificationMessage', '102')], context);
    expect(envelopes.map((item) => (item.raw as { square: unknown }).square)).toEqual([
      { eventType: 'SEND_MESSAGE', own: true }, { eventType: 'NOTIFICATION_MESSAGE', own: false }]);
  });

  it('builds an attachment and mentions with the Talk helper code', () => {
    const mention = JSON.stringify({ MENTIONEES: [{ S: '0', E: '5', M: MEMBER }] });
    const { envelopes } = normalizeSquareEvents([
      event(0, 'receiveMessage', '110', {}, { contentType: 1, text: null, contentMetadata: { FILE_NAME: 'a.png' } }),
      event(0, 'receiveMessage', '111', {}, { text: 'hello world', contentMetadata: { MENTION: mention } }),
    ], context);
    expect(envelopes[0]).toMatchObject({ kind: 'image', attachments: [{ id: '110', kind: 'image', name: 'a.png' }] });
    expect(envelopes[1]).toMatchObject({ mentionIds: [MEMBER], mentionRanges: [{ start: 0, end: 5, userId: MEMBER }] });
  });

  it('skips thread messages by event thread MID and by thread info', () => {
    const { envelopes, counts } = normalizeSquareEvents([
      event(0, 'receiveMessage', '120', { threadMid: 't1' }),
      event(29, 'notificationMessage', '121', {}, {}, { threadInfo: { chatThreadMid: 't2', threadRoot: false } }),
      event(0, 'receiveMessage', '122'),
    ], context);
    expect(envelopes.map((item) => item.messageId)).toEqual(['122']);
    expect(counts.thread).toBe(2);
  });

  it('gives one envelope per message id and keeps the own copy', () => {
    const { envelopes, counts } = normalizeSquareEvents([
      event(29, 'notificationMessage', '130'), event(0, 'receiveMessage', '130'), event(1, 'sendMessage', '130'), event(0, 'receiveMessage', '131'),
    ], context);
    expect(envelopes.map((item) => item.messageId)).toEqual(['130', '131']);
    expect((envelopes[0]!.raw as { square: { own: boolean } }).square.own).toBe(true);
    expect(counts.duplicate).toBe(2);
  });

  it('ignores other event types and drops an invalid envelope', () => {
    const { envelopes, counts } = normalizeSquareEvents([
      { type: 6, payload: {} },
      event(0, 'receiveMessage', '140', { squareChatMid: 'not-a-chat' }, { to: 'not-a-chat' }),
      event(0, 'receiveMessage', '141', {}, { from: 'not-a-member' }),
      event(0, 'receiveMessage', '142', {}, { id: undefined }),
      'garbage',
      event(0, 'receiveMessage', '143'),
    ], context);
    expect(envelopes.map((item) => item.messageId)).toEqual(['143']);
    expect(counts).toMatchObject({ events: 6, ignored: 2, invalid: 3 });
  });
});
