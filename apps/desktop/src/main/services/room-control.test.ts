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
  it('no longer treats a monitor mention as a control command', () => {
    expect(classifyRoomControl(envelope({ text: '@Bot 監控' })).type).toBe('none');
    expect(classifyRoomControl(envelope({ text: '@Bot MONITOR' })).type).toBe('none');
  });

  it('reserves a valid token mention and redacts it from archive data', () => {
    const source = envelope({ text: `@Bot ${token}`, raw: { nested: [`copied ${token}`] } });
    expect(classifyRoomControl(source).type).toBe('reserved-token-candidate');
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

  it('reserves copied or malformed RA candidates', () => {
    for (const candidate of [token, 'RA-short', `RA-${'A'.repeat(42)}!`, `RA-${'A'.repeat(42)}B`]) {
      const source = envelope({ text: `copied: ${candidate}`, mentionIds: [], mentionRanges: [],
        raw: { payload: candidate } });
      expect(classifyRoomControl(source).type).toBe('reserved-token-candidate');
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
      expect(classifyRoomControl(source).type).toBe('reserved-token-candidate');
      expect(sanitizeRoomControlEnvelope(source).text).not.toContain(token);
    }
  });
});
