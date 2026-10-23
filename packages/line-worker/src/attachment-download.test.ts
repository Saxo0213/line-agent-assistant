import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { parseEncryptedAccessToken, validateAttachmentMessage, validateNativeAttachment, type AttachmentDownloadIdentity } from './attachment-download.js';
import { normalizeOperation } from './normalizer.js';

describe('encrypted OBS access token', () => {
  it('extracts a bounded header-safe token while treating expiry as an optional cache hint', () => {
    expect(parseEncryptedAccessToken('3600\u001eOBS_token-123')).toBe('OBS_token-123');
    expect(parseEncryptedAccessToken('86401\u001etoken')).toBe('token');
    expect(parseEncryptedAccessToken('0\u001etoken')).toBe('token');
    expect(parseEncryptedAccessToken('unknown-expiry\u001etoken')).toBe('token');
  });

  it.each([
    '', 'token-without-expiry', '3600 token', '\u001e',
    '1\u001e', '1\u001etwo\u001eseparators', '1\u001ebad\rtoken',
  ])('rejects malformed or unsafe token response %# before OBS use', (value) => {
    expect(() => parseEncryptedAccessToken(value)).toThrow();
  });
});

describe('native LINE destination type binding', () => {
  const ownMid = `u${'a'.repeat(32)}`;
  const peerMid = `u${'b'.repeat(32)}`;
  const base = { id: '9', contentType: 1, contentMetadata: { OID: 'OID_123', SID: 'emi' },
    chunks: [{ encoding: 'base64', data: 'AQ==' }] };
  const direct: AttachmentDownloadIdentity = { accountId: 'a', chatType: 'direct', chatId: peerMid,
    ownMid, messageId: '9', kind: 'image', externalAttachmentId: 'OID_123' };
  it.each([
    ['image', 'IMAGE', 1, 'emi'], ['video', 'VIDEO', 2, 'emv'],
    ['audio', 'AUDIO', 3, 'ema'], ['file', 'FILE', 14, 'emf'],
  ] as const)('accepts only pinned %s string/numeric content enums with either archived row identity', (kind, name, numeric, sid) => {
    for (const contentType of [name, numeric]) for (const externalAttachmentId of ['9', 'OID_123']) {
      const message = { ...base, from: peerMid, to: ownMid, toType: 'USER', contentType,
        contentMetadata: { OID: 'OID_123', SID: sid } };
      expect(validateAttachmentMessage(message, { ...direct, kind, externalAttachmentId }, 1024).oid).toBe('OID_123');
    }
  });
  it.each([
    { ...base, from: peerMid, to: ownMid, toType: 0 },
    { ...base, from: ownMid, to: peerMid, toType: 0 },
  ])('accepts incoming/outgoing direct message only when native toType is 0', (message) => {
    expect(validateAttachmentMessage(message as never, direct, 1024).encrypted).toBe(true);
  });
  it.each([undefined, 1, 2, 3, '0'])('rejects invalid direct toType %s', (toType) => {
    const message = { ...base, from: peerMid, to: ownMid, ...(toType === undefined ? {} : { toType }) };
    expect(() => validateAttachmentMessage(message as never, direct, 1024)).toThrow();
  });
  it('requires group type 2 and room type 1 while rejecting mismatched destinations', () => {
    const group: AttachmentDownloadIdentity = { ...direct, chatType: 'group', chatId: `c${'c'.repeat(32)}` };
    const message = { ...base, from: peerMid, to: group.chatId, toType: 2 };
    expect(validateAttachmentMessage(message as never, group, 1024).encrypted).toBe(true);
    for (const invalid of [undefined, 0, 1, 3, '2']) {
      const candidate = { ...message, ...(invalid === undefined ? { toType: undefined } : { toType: invalid }) };
      expect(() => validateAttachmentMessage(candidate as never, group, 1024)).toThrow();
    }
    const roomId = `r${'d'.repeat(32)}`;
    const room = { ...message, to: roomId, toType: 1 };
    expect(validateAttachmentMessage(room as never, { ...group, chatType: 'room', chatId: roomId }, 1024).encrypted).toBe(true);
    expect(() => validateAttachmentMessage({ ...room, toType: 2 } as never, { ...group, chatType: 'room', chatId: roomId }, 1024)).toThrow();
  });

  it('restores normalized native strings as exact UTF-8 bytes and accepts bounded legacy strings', () => {
    const nativeText = '\0鍵🙂';
    const envelope = normalizeOperation({ revision: 9, type: 26, message: {
      id: '9', from: peerMid, to: ownMid, toType: 0, contentType: 'IMAGE',
      contentMetadata: { OID: 'OID_123', SID: 'emi' }, chunks: [nativeText, 'ABCD'],
    } }, { accountId: 'a', ownMid, source: 'live', cursor: null });
    const stored = JSON.parse(JSON.stringify(envelope.raw)).message;
    const restored = validateAttachmentMessage(stored, direct, 1024).message.chunks as Uint8Array[];
    expect(Array.from(restored[0]!)).toEqual(Array.from(Buffer.from(nativeText, 'utf8')));
    expect(Array.from(restored[1]!)).toEqual(Array.from(Buffer.from('ABCD', 'utf8')));

    const legacy = validateAttachmentMessage({ ...base, from: peerMid, to: ownMid, toType: 0,
      chunks: ['ABCD', { encoding: 'base64', data: 'AQ==' }] } as never, direct, 1024);
    expect(legacy.message.chunks).toEqual(['ABCD', new Uint8Array([1])]);
  });

  it('counts legacy string chunks by UTF-8 bytes and rejects empty, oversized, and invalid mixed chunks', () => {
    const valid = { ...base, from: peerMid, to: ownMid, toType: 0 };
    expect(() => validateAttachmentMessage({ ...valid, chunks: ['鍵'.repeat(13)] } as never, direct, 4)).toThrow();
    expect(() => validateAttachmentMessage({ ...valid, chunks: [''] } as never, direct, 1024)).toThrow();
    expect(() => validateAttachmentMessage({ ...valid, chunks: ['ABCD', { nope: true }] } as never, direct, 1024)).toThrow();
    expect(() => validateAttachmentMessage({ ...valid, chunks: [{ encoding: 'invalid-native-chunks', reason: 'limit' }] } as never,
      direct, 1024)).toThrow();
  });
});

describe('native source attachment validation', () => {
  const ownMid = `u${'a'.repeat(32)}`;
  const directMid = `u${'b'.repeat(32)}`;
  const encrypted = Buffer.alloc(32, 0x41).toString('base64');
  const metadata = { messageId: '9', chatId: directMid, from: null, to: null, toType: null, contentType: 1,
    contentMetadata: { OID: 'OID_123', SID: 'emi', OBS_POP: null, FILE_SIZE: '4', MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null },
    keyMaterial: encrypted, fileName: 'native.png', sizeBytes: 4 } as const;
  it('accepts associated direct metadata with absent from/to and native key material without E2EE chunks', () => {
    const identity: AttachmentDownloadIdentity = { accountId: 'a', chatType: 'direct', chatId: directMid, ownMid,
      messageId: '9', kind: 'image', externalAttachmentId: '9' };
    const result = validateNativeAttachment(metadata, identity, 1024);
    expect(result.oid).toBe('OID_123');
    expect(result.sid).toBe('emi');
    expect(result.keyMaterial?.toString('base64')).toBe(encrypted);
  });
  it('validates native group and room routing from the source conversation association', () => {
    for (const [chatType, prefix, toType] of [['group', 'c', 2], ['room', 'r', 1]] as const) {
      const chatId = `${prefix}${'c'.repeat(32)}`;
      const input = { ...metadata, chatId, to: chatId, toType };
      expect(validateNativeAttachment(input, { accountId: 'a', chatType, chatId, ownMid, messageId: '9',
        kind: 'image', externalAttachmentId: '9' }, 1024).oid).toBe('OID_123');
    }
  });
  it('rejects source identity, destination, content kind, and unproven DOWNLOAD_URL routes', () => {
    const identity: AttachmentDownloadIdentity = { accountId: 'a', chatType: 'direct', chatId: directMid, ownMid,
      messageId: '9', kind: 'image', externalAttachmentId: '9' };
    expect(() => validateNativeAttachment({ ...metadata, messageId: '10' }, identity, 1024)).toThrow();
    expect(() => validateNativeAttachment({ ...metadata, chatId: `u${'c'.repeat(32)}` }, identity, 1024)).toThrow();
    expect(() => validateNativeAttachment({ ...metadata, contentType: 2 }, identity, 1024)).toThrow();
    expect(() => validateNativeAttachment({ ...metadata, contentMetadata: { ...metadata.contentMetadata, DOWNLOAD_URL: 'https://example.invalid' } }, identity, 1024)).toThrow();
  });
});
