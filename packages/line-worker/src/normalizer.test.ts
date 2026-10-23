import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { normalizeOperation, safeRaw } from './normalizer.js';

const context = { accountId: 'account-A', ownMid: 'u-self', source: 'live' as const, cursor: 'cursor-1' };

describe('LINE operation normalization', () => {
  it.each([
    ['direct', 'u-peer', { from: 'u-peer', to: 'u-self', toType: 0 }],
    ['group', 'c-group', { from: 'u-peer', to: 'c-group', toType: 2 }],
    ['room', 'r-room', { from: 'u-peer', to: 'r-room', toType: 1 }],
  ] as const)('keeps %s conversation and sender identities separate', (chatType, chatId, address) => {
    const envelope = normalizeOperation({ revision: 99n, type: 26, message: {
      id: '9223372036854775807', text: 'hello', contentType: 'NONE', createdTime: 1760522400000n, ...address,
    } }, context);
    expect(envelope).toMatchObject({ eventId: '99', accountId: 'account-A', chatType, chatId,
      senderId: 'u-peer', messageId: '9223372036854775807', text: 'hello' });
  });

  it('uses UTF-16 mention offsets after emoji, distinguishes @all, and requires REPLY relation', () => {
    const operation = { revision: 7n, type: 26, message: {
      id: '7', from: 'u-peer', to: 'c-group', toType: 2, contentType: 'NONE',
      text: '😀 @Agent @all', createdTime: 1760522400000,
      contentMetadata: { MENTION: JSON.stringify({ MENTIONEES: [
        { S: '3', E: '9', M: 'u-agent' }, { S: '10', E: '14', A: '1' },
      ] }) }, relatedMessageId: 'previous', messageRelationType: 'FORWARD',
    } };
    const envelope = normalizeOperation(operation, context);
    expect(envelope.mentionRanges).toEqual([{ start: 3, end: 9, userId: 'u-agent' }, { start: 10, end: 14, userId: '@all' }]);
    expect(envelope.mentionIds).toEqual(['u-agent', '@all']);
    expect(envelope.replyToMessageId).toBeNull();
    expect(normalizeOperation({ ...operation, message: { ...operation.message, messageRelationType: 'REPLY' } }, context).replyToMessageId).toBe('previous');
  });

  it('serializes nested bigint and bytes with stable decimal/base64 tags', () => {
    expect(safeRaw({ id: 9223372036854775807n, bytes: new Uint8Array([0, 255]) })).toEqual({
      id: '9223372036854775807', bytes: { encoding: 'base64', data: 'AP8=' },
    });
  });

  it.each(['live', 'history'] as const)('serializes native message chunk strings losslessly for %s ingestion', (source) => {
    const native = { id: '21', from: 'u-peer', to: 'u-self', toType: 0, contentType: 'IMAGE',
      chunks: ['\0', '\u9375\uD83D\uDE42', 'ABCD', new Uint8Array([0, 255])], createdTime: 1760522400000 };
    const envelope = normalizeOperation({ revision: 21, type: 26, message: native }, { ...context, source });
    const stored = JSON.parse(JSON.stringify(envelope.raw)) as { message: { chunks: unknown[] } };
    expect(stored.message.chunks).toEqual(['\0', '\u9375\uD83D\uDE42', 'ABCD', new Uint8Array([0, 255])].map((chunk) => ({
      encoding: 'base64', data: Buffer.from(typeof chunk === 'string' ? chunk : chunk).toString('base64'),
    })));
    expect(native.chunks[0]).toBe('\0');
    expect(envelope).toMatchObject({ ingestion: { source }, raw: { message: { chunks: expect.any(Array) } } });
  });

  it('bounds native chunk count and mixed UTF-8/binary bytes before encoding, preserving the source', () => {
    const tooMany = Array.from({ length: 65 }, () => 'ABCD');
    const tooLarge = ['鍵'.repeat(349_526), new Uint8Array([1])];
    for (const chunks of [tooMany, tooLarge]) {
      const message = { id: '22', from: 'u-peer', to: 'u-self', toType: 0, contentType: 'IMAGE',
        chunks, createdTime: 1760522400000 };
      const envelope = normalizeOperation({ revision: 22, type: 26, message }, context);
      expect(envelope.raw.message?.chunks).toEqual([{ encoding: 'invalid-native-chunks', reason: 'limit' }]);
      expect(message.chunks).toBe(chunks);
    }
  });

  it('replaces NUL characters before PostgreSQL JSONB and text persistence', () => {
    expect(safeRaw({ hidden: 'before\0after', '\0key': 'value' })).toEqual({
      hidden: 'before�after', '�key': 'value',
    });
    const envelope = normalizeOperation({ revision: 10, type: 26, nul: '\0', message: {
      id: '10', from: 'u-peer', to: 'u-self', toType: 0, contentType: 'FILE',
      text: 'hello\0world', createdTime: 1760522400000,
      contentMetadata: { FILE_NAME: 'bad\0name.txt', FILE_SIZE: '1' },
    } }, context);
    expect(envelope.text).toBe('hello�world');
    expect(envelope.attachments[0]?.name).toBe('bad�name.txt');
    expect(envelope.raw).toMatchObject({ nul: '�', message: { text: 'hello�world' } });
  });

  it('marks denied decrypt without mentions or Agent trigger markers and keeps raw', () => {
    const envelope = normalizeOperation({ revision: 9n, type: 26,
      encryptedPayload: { chunks: [new Uint8Array([0, 255])] }, message: {
      id: '9', from: 'u-peer', to: 'c-group', contentType: 'NONE', text: '@Agent',
      chunks: ['\0\u9375\uD83D\uDE42'],
      contentMetadata: { MENTION: '{"MENTIONEES":[{"S":"0","E":"6","M":"u-agent"}]}' },
      createdTime: 1760522400000,
    } }, context, { code: 'SIDE_EFFECT_DENIED', retryable: false });
    expect(envelope).toMatchObject({ kind: 'event', text: null, mentionIds: [], mentionRanges: [], attachments: [] });
    expect(envelope.raw).toMatchObject({ contentState: 'decrypt_failed', error: { code: 'SIDE_EFFECT_DENIED' },
      revision: '9', type: 26, encryptedPayload: { chunks: [{ encoding: 'base64', data: 'AP8=' }] },
      message: { id: '9', from: 'u-peer', chunks: [{ encoding: 'base64', data: Buffer.from('\0\u9375\uD83D\uDE42', 'utf8').toString('base64') }] } });
  });

  it.each(['IMAGE', 'VIDEO', 'AUDIO', 'FILE'] as const)('creates a scoped %s attachment descriptor', (kind) => {
    const envelope = normalizeOperation({ revision: 5, type: 26, message: {
      id: '5', from: 'u-peer', to: 'c-group', contentType: kind, createdTime: 1760522400000,
      contentMetadata: { FILE_NAME: 'photo.txt', FILE_SIZE: '12' },
    } }, context);
    expect(envelope.attachments).toEqual([{ id: '5', kind: kind.toLowerCase(), name: 'photo.txt', mimeType: null, sizeBytes: 12 }]);
  });

  it.each([
    [0, 'text'], [1, 'image'], [2, 'video'], [3, 'audio'], [7, 'sticker'], [14, 'file'],
  ] as const)('maps numeric LINE content type %s to %s', (contentType, kind) => {
    const envelope = normalizeOperation({ revision: 6, type: 26, message: {
      id: '6', from: 'u-peer', to: 'u-self', toType: 0, contentType,
      text: contentType === 0 ? 'hello' : undefined, createdTime: 1760522400000,
    } }, context);
    expect(envelope.kind).toBe(kind);
  });

  it('normalizes only native LINE contact content through its shared-contact accessor', () => {
    const contact = normalizeOperation({ revision: 17, message: {
      id: '17', from: 'u-peer', to: 'u-self', toType: 0, contentType: 'CONTACT',
      contentMetadata: { mid: `u${'a'.repeat(32)}`, displayName: 'Target', phone: 'must-not-escape' },
      createdTime: 1760522400000,
    } }, context);
    expect(contact).toMatchObject({ kind: 'contact', contact: { mid: `u${'a'.repeat(32)}`, displayName: 'Target' }, text: null });
    expect(JSON.stringify(contact)).not.toContain('must-not-escape');

    const forgedText = normalizeOperation({ revision: 18, message: {
      id: '18', from: 'u-peer', to: 'u-self', contentType: 'NONE', text: 'contact {"mid":"u-target"}',
      contentMetadata: { mid: 'u-target', displayName: 'Target' }, createdTime: 1760522400000,
    } }, context);
    expect(forgedText.kind).toBe('text');
    expect(forgedText).not.toHaveProperty('contact');
  });

  it('rejects malformed native contact descriptors instead of retaining their raw payload', () => {
    const rejected = normalizeOperation({ revision: 19, message: {
      id: '19', from: 'u-peer', to: 'u-self', contentType: 'CONTACT',
      contentMetadata: { mid: 'not-a-line-mid', displayName: 'Target' }, createdTime: 1760522400000,
    } }, context);
    expect(rejected).toMatchObject({ kind: 'event', text: null, raw: { contentState: 'contact_rejected' } });
    expect(rejected).not.toHaveProperty('contact');
  });

  it('prefers an existing LINE shared-contact accessor over raw metadata', () => {
    const envelope = normalizeOperation({ revision: 20, message: {
      id: '20', from: 'u-peer', to: 'u-self', contentType: 'CONTACT',
      contentMetadata: { mid: `u${'b'.repeat(32)}`, displayName: 'Raw value' },
      getSharedContact() { return { mid: `u${'c'.repeat(32)}`, displayName: 'Accessor value', phone: 'discard' }; },
      createdTime: 1760522400000,
    } }, context);
    expect(envelope.contact).toEqual({ mid: `u${'c'.repeat(32)}`, displayName: 'Accessor value' });
  });

  it('routes live location, rich, media, event, and unsupported kinds without parsing content', () => {
    const location = normalizeOperation({ revision: 31, message: { id: '31', from: 'u-peer', to: 'u-self', contentType: 15,
      location: { title: 'Place', address: 'Street', latitude: 25, longitude: 121 }, createdTime: 1760522400000 } }, context);
    expect(location.kind).toBe('location');
    // Content projection belongs to the database content bridge: the normalizer keeps the operation in raw and adds none.
    expect(location).not.toHaveProperty('content');
    expect(location.raw).toMatchObject({ message: { location: { title: 'Place', latitude: 25 } } });
    const rich = normalizeOperation({ revision: 32, message: { id: '32', from: 'u-peer', to: 'u-self', contentType: 22,
      contentMetadata: { ALT_TEXT: 'Flex card', FLEX_JSON: 'ignored' }, createdTime: 1760522400000 } }, context);
    expect(rich.kind).toBe('rich');
    expect(rich).not.toHaveProperty('content');
    const video = normalizeOperation({ revision: 33, message: { id: '33', from: 'u-peer', to: 'u-self', contentType: 2,
      contentMetadata: { DURATION: '12345' }, createdTime: 1760522400000 } }, context);
    expect(video.kind).toBe('video');
    expect(video).not.toHaveProperty('content');
    const event = normalizeOperation({ revision: 34, message: { id: '34', from: 'u-peer', to: 'u-self', contentType: 6,
      text: 'Joined', createdTime: 1760522400000 } }, context);
    expect(event).toMatchObject({ kind: 'event', text: 'Joined' });
    const unknown = normalizeOperation({ revision: 35, message: { id: '35', from: 'u-peer', to: 'u-self', contentType: 42,
      text: 'Fallback', createdTime: 1760522400000 } }, context);
    expect(unknown.kind).toBe('event');
    expect(unknown).not.toHaveProperty('content');
  });
});
