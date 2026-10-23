import { describe, expect, it } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import { normalizeOperation } from '../../../../../packages/line-worker/src/normalizer.js';
import { sanitizeInbound } from './sensitive-message-sanitizer.js';

const envelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'event-1', accountId: 'account-1', chatId: 'chat-1', chatType: 'direct', senderId: 'u-admin',
  messageId: 'message-1', kind: 'text', text: 'please use LW-ABCDEFGH now', mentionIds: [], mentionRanges: [],
  replyToMessageId: null, ingestion: { source: 'live', cursor: 'cursor-1' }, occurredAt: '2026-10-16T00:00:00.000Z',
  attachments: [], raw: { message: { text: 'please use LW-ABCDEFGH now', secret: 'LW-ABCDEFGH' } },
  ...overrides,
});

describe('pre-persistence sensitive ingress sanitizer', () => {
  it('extracts a live candidate only in memory and redacts message and raw payloads', () => {
    const result = sanitizeInbound(envelope(), { ownMid: 'u-self' });
    expect(result.secretCandidate).toEqual({ code: 'LW-ABCDEFGH', exact: false });
    expect(result.envelope.text).toBe('please use [REDACTED_VERIFICATION_CODE] now');
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it('leaves REPLACE metadata byte-identical while masking verification codes', () => {
    const replace = '{"sticon":{"resources":[{"S":12,"E":18,"resourceType":"STATIC","version":1,"sticonId":"1","productId":"0123456789abcdef01234567"}]}}';
    const text = 'LW-ABCDEFGH (pray)';
    const result = sanitizeInbound(envelope({ text, raw: { message: { text, contentMetadata: { REPLACE: replace } } } }));
    expect((result.envelope.raw as { message: { contentMetadata: { REPLACE: string } } }).message.contentMetadata.REPLACE).toBe(replace);
  });

  it('marks only a whole trimmed code as exact and keeps the placeholder out of ordinary routing', () => {
    const result = sanitizeInbound(envelope({ text: '  LW-ABCDEFGH  ', raw: { message: { text: 'LW-ABCDEFGH' } } }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toEqual({ code: 'LW-ABCDEFGH', exact: true });
    expect(result.envelope.text).toBe('  [REDACTED_VERIFICATION_CODE]  ');
  });

  it('extracts an exact group candidate only after removing the unique structured own mention', () => {
    const code = 'LW-ABCDEFGH';
    const result = sanitizeInbound(envelope({ chatType: 'group', text: `@Agent ${code}`,
      mentionIds: ['u-self'], mentionRanges: [{ start: 0, end: 6, userId: 'u-self' }],
      raw: { message: { text: `@Agent ${code}` } } }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toEqual({ code, exact: true });
    expect(result.envelope.text).toBe('@Agent [REDACTED_VERIFICATION_CODE]');
    expect(JSON.stringify(result.envelope)).not.toContain(code);
  });

  it('does not derive a group token from a fake, repeated, or non-exact mention body', () => {
    const code = 'LW-ABCDEFGH';
    const cases: Partial<InboundEnvelope>[] = [
      { chatType: 'group', text: `@Agent ${code}` },
      { chatType: 'group', text: `@Agent ${code} extra`, mentionIds: ['u-self'],
        mentionRanges: [{ start: 0, end: 6, userId: 'u-self' }] },
      { chatType: 'group', text: `@Agent ${code}`, mentionIds: ['u-self'],
        mentionRanges: [{ start: 0, end: 6, userId: 'u-self' }, { start: 7, end: 13, userId: 'u-self' }] },
    ];
    for (const item of cases) expect(sanitizeInbound(envelope(item), { ownMid: 'u-self' }).secretCandidate?.exact).not.toBe(true);
  });

  it('detects a code hidden only in raw metadata, redacts it there and leaves the code-free text untouched', () => {
    const result = sanitizeInbound(envelope({ text: 'ordinary note', raw: { operation: { opaque: 'LW-ABCDEFGH' } } }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toBeNull();
    expect(result.envelope.text).toBe('ordinary note');
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it.each([
    ['history', 'u-admin'], ['live', 'u-self'],
  ] as const)('redacts %s or own-echo copies without creating an authorization candidate', (source, senderId) => {
    const result = sanitizeInbound(envelope({ senderId, ingestion: { source, cursor: 'cursor-1' } }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toBeNull();
    expect(result.envelope.text).toBe('please use [REDACTED_VERIFICATION_CODE] now');
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it('does not create a candidate when the receiving account identity is unavailable', () => {
    expect(sanitizeInbound(envelope()).secretCandidate).toBeNull();
  });

  it('discards raw contact payloads and retains only the typed descriptor', () => {
    const result = sanitizeInbound(envelope({ kind: 'contact', text: null,
      contact: { mid: `u${'a'.repeat(32)}`, displayName: 'Target' },
      raw: { message: { contentMetadata: { mid: `u${'a'.repeat(32)}`, phone: '+886900000000', avatar: 'private' } } },
    }));
    expect(result.envelope).toMatchObject({ kind: 'contact', contact: { displayName: 'Target' }, raw: {} });
    expect(JSON.stringify(result.envelope)).not.toContain('+886900000000');
    expect(JSON.stringify(result.envelope)).not.toContain('private');
  });

  it('redacts codes in attachment metadata without turning them into candidates', () => {
    const result = sanitizeInbound(envelope({ text: 'ordinary message',
      attachments: [{ id: 'attachment-1', kind: 'file', name: 'report-LW-ABCDEFGH.pdf',
        mimeType: 'application/x-LW-ABCDEFGH', sizeBytes: 23 }],
      raw: { message: { attachmentName: 'report-LW-ABCDEFGH.pdf' } },
    }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toBeNull();
    expect(result.envelope.attachments).toEqual([{ id: 'attachment-1', kind: 'file',
      name: 'report-[REDACTED_VERIFICATION_CODE].pdf', mimeType: 'application/x-[REDACTED_VERIFICATION_CODE]', sizeBytes: 23 }]);
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it('redacts contact display names without changing the MID or exposing a code candidate', () => {
    const result = sanitizeInbound(envelope({ kind: 'contact', text: null,
      contact: { mid: `u${'a'.repeat(32)}`, displayName: 'Friend LW-ABCDEFGH' }, raw: {},
    }), { ownMid: 'u-self' });
    expect(result.secretCandidate).toBeNull();
    expect(result.envelope.contact).toEqual({ mid: `u${'a'.repeat(32)}`, displayName: 'Friend [REDACTED_VERIFICATION_CODE]' });
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it('normalizes native file metadata before sanitizing its attachment receipt', () => {
    const normalized = normalizeOperation({ revision: 21, message: {
      id: '21', from: 'u-peer', to: 'u-self', contentType: 'FILE', text: 'file',
      contentMetadata: { FILE_NAME: 'report-LW-ABCDEFGH.pdf', MIME_TYPE: 'application/x-LW-ABCDEFGH', FILE_SIZE: '23' },
      createdTime: 1760522400000,
    } }, { accountId: 'account-1', ownMid: 'u-self', source: 'live', cursor: 'cursor-1' });
    const result = sanitizeInbound(normalized, { ownMid: 'u-self' });
    expect(result.secretCandidate).toBeNull();
    expect(result.envelope.attachments).toEqual([{ id: '21', kind: 'file',
      name: 'report-[REDACTED_VERIFICATION_CODE].pdf', mimeType: 'application/x-[REDACTED_VERIFICATION_CODE]', sizeBytes: 23 }]);
    expect(JSON.stringify(result.envelope)).not.toContain('LW-ABCDEFGH');
  });

  it('keeps mention ranges aligned after the code is replaced in place and drops a range that overlaps it', () => {
    const result = sanitizeInbound(envelope({ chatType: 'group', text: 'LW-ABCDEFGH hi @Bob', mentionIds: ['u-bob'],
      mentionRanges: [{ start: 15, end: 19, userId: 'u-bob' }] }), { ownMid: 'u-self' });
    expect(result.envelope.text).toBe('[REDACTED_VERIFICATION_CODE] hi @Bob');
    expect(result.envelope.mentionRanges).toEqual([{ start: 32, end: 36, userId: 'u-bob' }]);
    const overlapping = sanitizeInbound(envelope({ chatType: 'group', text: 'LW-ABCDEFGH hi', mentionIds: ['u-bob'],
      mentionRanges: [{ start: 3, end: 8, userId: 'u-bob' }] }), { ownMid: 'u-self' });
    expect(overlapping.envelope.mentionRanges).toEqual([]);
  });

  it('stores a text body only for text messages, like the native writer', () => {
    for (const kind of ['image', 'video', 'audio', 'file', 'sticker'] as const) {
      expect(sanitizeInbound(envelope({ kind, text: 'caption', mentionRanges: [], raw: {} }), { ownMid: 'u-self' }).envelope.text).toBeNull();
    }
    expect(sanitizeInbound(envelope({ kind: 'text', text: 'plain', raw: {} }), { ownMid: 'u-self' }).envelope.text).toBe('plain');
  });
});
