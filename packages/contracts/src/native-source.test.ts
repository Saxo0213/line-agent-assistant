import { describe, expect, it } from 'vitest';
import {
  NATIVE_CATALOG_TABLES,
  NativeCatalogRecordSchema,
  NativeSourceEnvelopeSchema,
  NativeStickerMetadataSchema,
} from './native-source.js';

const nativePayload = {
  format: 1,
  table: '_contact',
  sourceDigest: 'a'.repeat(64),
  encoding: 'dpapi',
  data: 'AQID',
};

describe('native source contracts', () => {
  it('accepts a bounded protected source envelope and allowlisted catalog record', () => {
    expect(NativeSourceEnvelopeSchema.parse(nativePayload)).toEqual(nativePayload);
    expect(NATIVE_CATALOG_TABLES).toHaveLength(19);
    expect(NativeCatalogRecordSchema.parse({ tableName: '_contact', recordKey: 'pk:["u-1"]', nativePayload }))
      .toMatchObject({ tableName: '_contact', nativePayload });
  });

  it('accepts plain format-2 envelopes next to dpapi format 1 and keeps the two shapes apart', () => {
    const plain = { format: 2, table: '_message', sourceDigest: 'b'.repeat(64), encoding: 'plain',
      row: { columns: ['_id', '_toType', '_contentMetadata', '_chunks'], cells: ['m-1', { sqliteType: 'integer', value: '2' }, null,
        { sqliteType: 'blob', encoding: 'base64', data: 'AQID' }] } };
    expect(NativeSourceEnvelopeSchema.parse(plain)).toEqual(plain);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...plain, row: { columns: ['_id'], cells: [] } }).success).toBe(false);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...plain, data: 'AQID' }).success).toBe(false);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...nativePayload, encoding: 'plain' }).success).toBe(false);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...plain, row: { columns: ['_id'], cells: [{ sqliteType: 'integer', raw: 1 }] } }).success).toBe(false);
    expect(NativeCatalogRecordSchema.parse({ tableName: '_message_sticker', recordKey: 'pk:[1]', nativePayload: { ...plain, table: '_message_sticker' } }).nativePayload.encoding)
      .toBe('plain');
  });

  it('rejects malformed protected envelopes and mismatched catalog tables', () => {
    expect(NativeSourceEnvelopeSchema.safeParse({ ...nativePayload, data: 'not base64!' }).success).toBe(false);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...nativePayload, sourceDigest: 'bad' }).success).toBe(false);
    expect(NativeCatalogRecordSchema.safeParse({ tableName: '_contact', recordKey: 'pk:["u-1"]',
      nativePayload: { ...nativePayload, table: '_groupChat' } }).success).toBe(false);
    expect(NativeCatalogRecordSchema.safeParse({ tableName: '_channelToken', recordKey: 'x',
      nativePayload: { ...nativePayload, table: '_channelToken' } }).success).toBe(false);
  });

  it('accepts only safe sticker display metadata and normalizes its text spacing', () => {
    expect(NativeStickerMetadataSchema.parse({ STKID: '123', STKPKGID: '456', STKVER: '12', STKTXT: '  hello\n world  ', STKOPT: 'A' }))
      .toEqual({ STKID: '123', STKPKGID: '456', STKVER: '12', STKTXT: 'hello world', STKOPT: 'A' });
    expect(NativeStickerMetadataSchema.safeParse({ STKID: 'x' }).success).toBe(false);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKTXT: 'bad\u0000text' }).success).toBe(false);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKOPT: 'B' }).success).toBe(false);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKPKGID: 'x' }).success).toBe(false);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKVER: '1'.repeat(21) }).success).toBe(false);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKTXT: 'a'.repeat(200) }).success).toBe(true);
    expect(NativeStickerMetadataSchema.safeParse({ STKID: '1', STKTXT: 'a'.repeat(201) }).success).toBe(false);
  });

  it('validates large ciphertext strings with bounded linear checks', () => {
    const hundredKiB = { ...nativePayload, data: 'A'.repeat(100 * 1024) };
    const oneMiB = { ...nativePayload, data: 'A'.repeat(1024 * 1024) };
    expect(NativeSourceEnvelopeSchema.safeParse(hundredKiB).success).toBe(true);
    expect(NativeSourceEnvelopeSchema.safeParse(oneMiB).success).toBe(true);
    expect(NativeSourceEnvelopeSchema.safeParse({ ...oneMiB, data: `${oneMiB.data.slice(0, -1)}!` }).success).toBe(false);
  });
});
