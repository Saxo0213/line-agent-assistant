import { describe, expect, it } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import { classifyRoomControl, sanitizeRoomControlEnvelope } from './room-control.js';

const ownMid = 'u-own';
const token = `RA-${'A'.repeat(43)}`;
function envelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    eventId: 'event-1', accountId: 'account-1', chatType: 'group', chatId: 'group-1',
    senderId: 'u-member', messageId: 'message-1', kind: 'text', text: '@Bot monitor',
    mentionIds: [ownMid], mentionRanges: [{ start: 0, end: 4, userId: ownMid }],
    replyToMessageId: null, ingestion: { source: 'live', cursor: 'cursor-1' },
    occurredAt: '2026-10-16T00:00:00.000Z', attachments: [], raw: { message: { text: '@Bot monitor' } },
    ...overrides,
  };
}

describe('room control classification', () => {
  it('recognizes the exact localized monitor request', () => {
    expect(classifyRoomControl(envelope({ text: '@Bot \u76E3\u63A7' }), ownMid))
      .toMatchObject({ type: 'command', command: { type: 'request' } });
  });

  it('recognizes an own-MID UTF-16 mention followed by an exact normalized request', () => {
    expect(classifyRoomControl(envelope({ text: '  @Bot  MONITOR  ', mentionRanges: [{ start: 2, end: 6, userId: ownMid }] }), ownMid))
      .toMatchObject({ type: 'command', command: { type: 'request' } });
    expect(classifyRoomControl(envelope({ text: '@🙂 監控', mentionRanges: [{ start: 0, end: 3, userId: ownMid }] }), ownMid))
      .toMatchObject({ type: 'command', command: { type: 'request' } });
  });

  it.each<[string, Partial<InboundEnvelope>]>([
    ['forged text without a mention range', { mentionRanges: [] }],
    ['@all', { mentionIds: ['@all'], mentionRanges: [{ start: 0, end: 4, userId: '@all' }] }],
    ['a bare monitor command', { text: 'monitor', mentionIds: [], mentionRanges: [] }],
    ['a mention after non-whitespace text', { text: 'hello @Bot monitor', mentionRanges: [{ start: 6, end: 10, userId: ownMid }] }],
    ['extra command text', { text: '@Bot monitor please' }],
    ['a wrong own MID', { mentionIds: ['u-other'], mentionRanges: [{ start: 0, end: 4, userId: 'u-other' }] }],
  ])('does not recognize %s', (_name, overrides) => {
    expect(classifyRoomControl(envelope(overrides), ownMid).type).toBe('none');
  });

  it('does not classify request commands from history or own-message echoes', () => {
    expect(classifyRoomControl(envelope({ ingestion: { source: 'history', cursor: null } }), ownMid).type).toBe('none');
    expect(classifyRoomControl(envelope({ senderId: ownMid }), ownMid).type).toBe('none');
  });

  it('classifies a valid token mention as a volatile confirmation candidate and redacts it from archive data', () => {
    const source = envelope({ text: `@Bot ${token}`, raw: { nested: [`copied ${token}`] } });
    expect(classifyRoomControl(source, ownMid)).toMatchObject({ type: 'command', command: { type: 'confirmation-candidate', token } });
    const safe = sanitizeRoomControlEnvelope(source);
    expect(safe.text).not.toContain(token);
    expect(JSON.stringify(safe.raw)).not.toContain(token);
  });

  it('redacts token candidates in attachment display metadata but preserves attachment identity', () => {
    const source = envelope({ attachments: [{ id: 'RA-attachment-id', kind: 'file',
      name: `${token}.txt`, mimeType: `application/${token}`, sizeBytes: 3 }] });
    const safe = sanitizeRoomControlEnvelope(source);
    expect(safe.attachments[0]).toEqual({ id: 'RA-attachment-id', kind: 'file',
      name: `${'[REDACTED]'}.txt`, mimeType: `application/${'[REDACTED]'}`, sizeBytes: 3 });
    expect(JSON.stringify(safe.attachments)).not.toContain(token);
  });

  it('leaves REPLACE metadata byte-identical while masking room tokens', () => {
    const replace = '{"sticon":{"resources":[{"S":0,"E":6,"resourceType":"STATIC","version":1,"sticonId":"1","productId":"0123456789abcdef01234567"}]}}';
    const safe = sanitizeRoomControlEnvelope(envelope({ text: `${token} (pray)`, raw: { message: {
      text: `${token} (pray)`, contentMetadata: { REPLACE: replace },
    } } }));
    expect((safe.raw as { message: { contentMetadata: { REPLACE: string } } }).message.contentMetadata.REPLACE).toBe(replace);
  });

  it('reserves copied or malformed RA candidates without accepting them as confirmations', () => {
    for (const candidate of [token, 'RA-short', `RA-${'A'.repeat(42)}!`, `RA-${'A'.repeat(42)}B`]) {
      const source = envelope({ text: `copied: ${candidate}`, mentionIds: [], mentionRanges: [],
        raw: { payload: candidate } });
      expect(classifyRoomControl(source, ownMid).type).toBe('reserved-token-candidate');
      const safe = sanitizeRoomControlEnvelope(source);
      expect(safe.text).not.toContain(candidate);
      expect(JSON.stringify(safe.raw)).not.toContain(candidate);
    }
  });

  it('reserves candidates across history, echoes, accounts, and room scopes', () => {
    for (const overrides of [
      { ingestion: { source: 'history' as const, cursor: null } },
      { senderId: ownMid },
      { accountId: 'another-account' },
      { chatType: 'room' as const, chatId: 'another-room' },
    ]) {
      const source = envelope({ text: token, ...overrides });
      expect(classifyRoomControl(source, ownMid).type).toBe('reserved-token-candidate');
      expect(sanitizeRoomControlEnvelope(source).text).not.toContain(token);
    }
  });

  it('keeps the source account and room attached to a volatile confirmation candidate for later scope checks', () => {
    const source = envelope({ text: `@Bot ${token}`, accountId: 'account-2', chatType: 'room', chatId: 'room-2' });
    expect(classifyRoomControl(source, ownMid, 'account-2')).toMatchObject({ type: 'command', command: {
      type: 'confirmation-candidate', accountId: 'account-2', chatType: 'room', chatId: 'room-2', senderId: 'u-member',
    } });
    expect(classifyRoomControl(source, ownMid, 'account-1').type).toBe('reserved-token-candidate');
  });

  it('recognizes ASCII case-insensitive monitor only after NFC normalization and trim', () => {
    expect(classifyRoomControl(envelope({ text: '@Bot   MoNiToR  ' }), ownMid)).toMatchObject({ type: 'command', command: { type: 'request' } });
    expect(classifyRoomControl(envelope({ text: '@Bot monitor extra' }), ownMid).type).toBe('none');
    expect(classifyRoomControl(envelope({ text: '@Bot MONİTOR' }), ownMid).type).toBe('none');
  });
});
