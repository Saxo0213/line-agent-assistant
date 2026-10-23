import { describe, expect, it } from 'vitest';
import { MAX_METADATA_BYTES } from './content-bridge/index.js';
import { dpapiEnvelope, plainEnvelope } from './content-bridge/test-support.js';
import { parseLineStickerDescriptor } from './sticker-descriptor.js';

const native = (metadata: string | null) => plainEnvelope({ _id: 1, _contentMetadata: metadata });

describe('parseLineStickerDescriptor native fallback', () => {
  it('reads numeric flat metadata from a native-only row', () => {
    const raw = { native: native('{"STKPKGID":12345,"STKID":12345678,"STKVER":1,"STKOPT":"A","STKTXT":" hi\\n there "}') };
    expect(parseLineStickerDescriptor(raw)).toEqual({ stickerId: '12345678', animated: true, altText: 'hi there' });
  });

  it('reads nested STK metadata from a native-only row', () => {
    const raw = { native: native(JSON.stringify({ STK: JSON.stringify({ STKID: 777, STKPKGID: 5 }) })) };
    expect(parseLineStickerDescriptor(raw)).toEqual({ stickerId: '777', animated: false, altText: null });
  });

  it('keeps the primary raw.message metadata first', () => {
    const raw = { message: { contentMetadata: { STKID: '111' } }, native: native('{"STKID":222}') };
    expect(parseLineStickerDescriptor(raw)?.stickerId).toBe('111');
  });

  it('falls back when the primary copy has no valid STKID', () => {
    const raw = { message: { contentMetadata: { STKID: 'bad' } }, native: native('{"STKID":222}') };
    expect(parseLineStickerDescriptor(raw)?.stickerId).toBe('222');
  });

  it('rejects malformed, oversized, unsafe, negative and fractional native metadata', () => {
    expect(parseLineStickerDescriptor({ native: native('{not-json') })).toBeNull();
    expect(parseLineStickerDescriptor({ native: native(`{"STKID":1,"X":"${'a'.repeat(MAX_METADATA_BYTES)}"}`) })).toBeNull();
    expect(parseLineStickerDescriptor({ native: native('{"STKID":-5}') })).toBeNull();
    expect(parseLineStickerDescriptor({ native: native('{"STKID":1.5}') })).toBeNull();
    expect(parseLineStickerDescriptor({ native: native('{"STKID":1e30}') })).toBeNull();
    expect(parseLineStickerDescriptor({ native: native(null) })).toBeNull();
  });

  it('ignores dpapi and non-_message envelopes', () => {
    expect(parseLineStickerDescriptor({ native: dpapiEnvelope('a'.repeat(64)) })).toBeNull();
    const other = { ...native('{"STKID":1}'), table: '_chat' };
    expect(parseLineStickerDescriptor({ native: other })).toBeNull();
    expect(parseLineStickerDescriptor({ native: { format: 2, encoding: 'plain', table: '_message', row: 'x' } })).toBeNull();
    expect(parseLineStickerDescriptor(null)).toBeNull();
  });
});
