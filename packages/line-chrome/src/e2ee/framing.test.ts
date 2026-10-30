import { describe, expect, it } from 'vitest';
import { pythonTruthy } from '../json.js';
import {
  buildChunks,
  buildChunksV1,
  buildE2eeMessage,
  deserializePlaintext,
  isE2eeMessage,
  keyIdFromBytes,
  keyIdToBytes,
  mergeDecrypted,
  messageE2eeVersion,
  parseChunks,
  parseChunksV1,
  pythonBase64Decode,
  serializePlaintext,
} from './framing.js';

const range = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => i));

describe('key id bytes', () => {
  it('round-trips as 4 big-endian bytes', () => {
    for (const n of [0, 1, 255, 256, 70000, 5312832, 0xffffffff]) {
      const b = keyIdToBytes(n);
      expect(b).toHaveLength(4);
      expect(keyIdFromBytes(b)).toBe(n);
    }
    expect(keyIdToBytes(0x01020304).toString('hex')).toBe('01020304');
    expect(keyIdToBytes(0x1_0000_0001).toString('hex')).toBe('00000001'); // truncated to 32 bits like `& 0xFFFFFFFF`
  });
});

describe('chunk framing (OkLine tests/test_e2ee.py)', () => {
  it('V2: [head16, body, tag12, senderKeyId, receiverKeyId] and ct = c0 + c2 + c1', () => {
    const ct = range(60);
    const chunks = buildChunks(ct, 11, 22);
    expect(chunks).toHaveLength(5);
    expect(Buffer.from(chunks[0]!, 'base64').equals(ct.subarray(0, 16))).toBe(true);
    expect(Buffer.from(chunks[1]!, 'base64').equals(ct.subarray(28))).toBe(true);
    expect(Buffer.from(chunks[2]!, 'base64').equals(ct.subarray(16, 28))).toBe(true);
    const parsed = parseChunks(chunks);
    expect(parsed.ciphertext.equals(ct)).toBe(true);
    expect([parsed.senderKeyId, parsed.receiverKeyId]).toEqual([11, 22]);
  });

  it('V1: [salt8, body, tag16, senderKeyId, receiverKeyId] and ct = c0 + c1 + c2 (not swapped)', () => {
    const ct = range(60);
    const chunks = buildChunksV1(ct, 11, 22);
    expect(Buffer.from(chunks[0]!, 'base64').equals(ct.subarray(0, 8))).toBe(true);
    expect(Buffer.from(chunks[1]!, 'base64').equals(ct.subarray(8, 44))).toBe(true);
    expect(Buffer.from(chunks[2]!, 'base64').equals(ct.subarray(44))).toBe(true);
    const parsed = parseChunksV1(chunks);
    expect(parsed.ciphertext.equals(ct)).toBe(true);
    expect([parsed.senderKeyId, parsed.receiverKeyId]).toEqual([11, 22]);
  });

  it('reads key ids only when all five chunks are present (never a silent 0)', () => {
    const chunks = buildChunks(range(40), 1, 2).slice(0, 4);
    const parsed = parseChunks(chunks);
    expect([parsed.senderKeyId, parsed.receiverKeyId]).toEqual([null, null]);
    expect(() => parseChunks(['a', 'b'])).toThrow(RangeError);
  });

  it('accepts bytes as well as base64 strings', () => {
    // A Uint8Array chunk holds the base64 text as bytes (Python decodes bytes input with the same b64decode).
    const chunks = buildChunks(range(40), 3, 4).map((c) => Buffer.from(c, 'latin1'));
    expect(parseChunks(chunks).receiverKeyId).toBe(4);
  });

  it('message_e2ee_version defaults to 2', () => {
    expect(messageE2eeVersion({ contentMetadata: { e2eeVersion: '1' } })).toBe(1);
    expect(messageE2eeVersion({ contentMetadata: { e2eeVersion: '2' } })).toBe(2);
    expect(messageE2eeVersion({ contentMetadata: {} })).toBe(2);
    expect(messageE2eeVersion({})).toBe(2);
  });

  it('message_e2ee_version parses like Python int()', () => {
    const version = (e2eeVersion: unknown) => messageE2eeVersion({ contentMetadata: { e2eeVersion } });
    expect(version('1')).toBe(1);
    expect(version(1)).toBe(1);
    expect(version(1.5)).toBe(1);
    expect(version(' 1 ')).toBe(1);
    expect(version(true)).toBe(1);
    expect(version('1junk')).toBe(2);
    expect(version('1.5')).toBe(2);
    expect(version('3')).toBe(2);
    expect(version('')).toBe(2);
    expect(version(undefined)).toBe(2);
    expect(version(null)).toBe(2);
    expect(version(0)).toBe(2);
    expect(version(false)).toBe(2);
  });

  it('is_e2ee_message needs at least 3 chunks', () => {
    expect(isE2eeMessage({ chunks: ['a', 'b', 'c'] })).toBe(true);
    expect(isE2eeMessage({ chunks: ['a', 'b'] })).toBe(false);
    expect(isE2eeMessage({})).toBe(false);
  });
});

describe('plaintext serialisation', () => {
  it('serialises text/location/REPLACE as compact JSON, in that order', () => {
    const bytes = serializePlaintext({
      text: 'héllo',
      location: { latitude: 1.5 },
      contentMetadata: { REPLACE: '{"sid":"1"}' },
    });
    expect(bytes.toString('utf8')).toBe('{"text":"héllo","location":{"latitude":1.5},"REPLACE":{"sid":"1"}}');
  });

  it('omits absent fields, drops an unparsable REPLACE and passes non-string REPLACE through', () => {
    expect(serializePlaintext({ text: 'a', location: null, contentMetadata: { REPLACE: '{bad' } }).toString()).toBe('{"text":"a"}');
    expect(serializePlaintext({ contentMetadata: { REPLACE: { a: 1 } } }).toString()).toBe('{"REPLACE":{"a":1}}');
    expect(serializePlaintext({}).toString()).toBe('{}');
  });

  it('seals ENC_KM as keyMaterial and FILE_NAME as fileName', () => {
    const text = serializePlaintext({ contentMetadata: { ENC_KM: 'a2V5', FILE_NAME: 'x.png' } }).toString();
    expect(JSON.parse(text)).toEqual({ keyMaterial: 'a2V5', fileName: 'x.png' });
    expect(JSON.parse(serializePlaintext({ contentMetadata: { FILE_NAME: 'x.png' } }).toString())).toEqual({});
  });

  it('REPLACE and ENC_KM use Python truthiness (P7, OkLine e2ee_crypto.py:69-80)', () => {
    const utf8 = (s: string) => Buffer.from(s, 'utf8');
    expect(serializePlaintext({ text: 'x', contentMetadata: { REPLACE: [], ENC_KM: {}, FILE_NAME: 'f' } })).toEqual(utf8('{"text":"x"}'));
    expect(serializePlaintext({ text: 'x', contentMetadata: { REPLACE: '', ENC_KM: '', FILE_NAME: 'f' } })).toEqual(utf8('{"text":"x"}'));
    expect(serializePlaintext({ text: 'x', contentMetadata: { REPLACE: [1], ENC_KM: 'k', FILE_NAME: 'f' } })).toEqual(
      utf8('{"text":"x","REPLACE":[1],"keyMaterial":"k","fileName":"f"}'),
    );
    expect(serializePlaintext({ text: 'x', contentMetadata: { REPLACE: { a: 1 }, ENC_KM: 'k' } })).toEqual(utf8('{"text":"x","REPLACE":{"a":1},"keyMaterial":"k"}'));
  });

  it('deserialises leniently: control characters survive, garbage becomes {text}', () => {
    expect(deserializePlaintext(Buffer.from('{"text":"a\u0001b"}', 'utf8'))).toEqual({ text: 'a\u0001b' });
    expect(deserializePlaintext(Buffer.from('not json', 'utf8'))).toEqual({ text: 'not json' });
    expect(() => deserializePlaintext(Buffer.from('"just a string"', 'utf8'))).toThrow('E2EE plaintext is not an object');
  });

  it('keeps integers beyond 2^53 as decimal strings', () => {
    const plain = deserializePlaintext(Buffer.from('{"REPLACE":{"id":9007199254740993}}', 'utf8'));
    expect(plain).toEqual({ REPLACE: { id: '9007199254740993' } });
  });
});

describe('build_e2ee_message', () => {
  const base = {
    id: '1',
    from: 'uSELF',
    to: 'uPEER',
    toType: 0,
    contentType: 0,
    text: 'secret',
    location: { latitude: 1 },
    sessionId: 0,
    contentMetadata: { REPLACE: '{"a":1}', KEEP: 'yes' },
  };

  it('sets e2eeVersion as a STRING, drops text/location/REPLACE and deletes `from` (OkLine live-verified deviation)', () => {
    const sealed = buildE2eeMessage(base, ['c0', 'c1', 'c2', 'c3', 'c4'], 2);
    expect(sealed.contentMetadata).toEqual({ KEEP: 'yes', e2eeVersion: '2' });
    expect(typeof (sealed.contentMetadata as Record<string, unknown>).e2eeVersion).toBe('string');
    expect('text' in sealed).toBe(false);
    expect('location' in sealed).toBe(false);
    expect('from' in sealed).toBe(false);
    expect(sealed.chunks).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(sealed.to).toBe('uPEER');
    expect(sealed.sessionId).toBe(0);
    expect(base.from).toBe('uSELF'); // input untouched
    expect(base.contentMetadata.REPLACE).toBeDefined();
  });

  it('removes ENC_KM and FILE_NAME only when key material was sealed', () => {
    const media = buildE2eeMessage({ ...base, contentMetadata: { ENC_KM: 'a2V5', FILE_NAME: 'f', OID: 'o' } }, [], 2);
    expect(media.contentMetadata).toEqual({ OID: 'o', e2eeVersion: '2' });
    const plainName = buildE2eeMessage({ ...base, contentMetadata: { FILE_NAME: 'f' } }, [], 2);
    expect(plainName.contentMetadata).toEqual({ FILE_NAME: 'f', e2eeVersion: '2' });
  });

  it('a falsy ENC_KM stays in the clear metadata with FILE_NAME (Python truthiness)', () => {
    expect(buildE2eeMessage({ to: 'u1', contentMetadata: { ENC_KM: {}, FILE_NAME: 'f', REPLACE: [] } }, []).contentMetadata).toEqual({
      ENC_KM: {},
      FILE_NAME: 'f',
      e2eeVersion: '2',
    });
    expect(buildE2eeMessage({ to: 'u1', contentMetadata: { ENC_KM: 'k', FILE_NAME: 'f' } }, []).contentMetadata).toEqual({ e2eeVersion: '2' });
  });

  it('V1 stamps "1"', () => {
    expect((buildE2eeMessage(base, [], 1).contentMetadata as Record<string, unknown>).e2eeVersion).toBe('1');
  });
});

describe('merge decrypted', () => {
  it('throws when the plaintext is valid JSON but not an object', () => {
    const wire = { id: '9', chunks: ['a', 'b', 'c'], contentMetadata: {} };
    for (const text of ['[]', 'null', '42', '"x"']) {
      expect(() => mergeDecrypted(wire, Buffer.from(text, 'utf8')), text).toThrow('E2EE plaintext is not an object');
    }
    expect(mergeDecrypted(wire, Buffer.from('not json', 'utf8')).text).toBe('not json');
    expect(mergeDecrypted(wire, Buffer.from('{"text":"a"}', 'utf8')).text).toBe('a');
  });

  it('restores text, location, REPLACE, ENC_KM and FILE_NAME into contentMetadata and clears chunks', () => {
    const wire = { id: '9', chunks: ['a', 'b', 'c'], contentMetadata: { e2eeVersion: '2', OID: 'o' } };
    const plaintext = Buffer.from(
      JSON.stringify({ text: 'hi', location: { title: 't' }, REPLACE: { x: 1 }, keyMaterial: 'a2V5', fileName: 'f.bin' }),
    );
    const merged = mergeDecrypted(wire, plaintext);
    expect(merged.text).toBe('hi');
    expect(merged.location).toEqual({ title: 't' });
    expect(merged.chunks).toEqual([]);
    expect(merged.contentMetadata).toEqual({
      e2eeVersion: '2',
      OID: 'o',
      REPLACE: { x: 1 },
      ENC_KM: 'a2V5',
      FILE_NAME: 'f.bin',
    });
  });
});

describe('pythonBase64Decode (Python base64.b64decode, validate=False)', () => {
  const hex = (s: string): string => pythonBase64Decode(s).toString('hex');
  it.each([
    ['AAAAAQ==', '00000001'],
    ['AAAAAQ===', '00000001'],
    ['AAAAAQ==zz', '00000001'],
    ['AAAA', '000000'],
    ['AAAA====', '000000'],
    ['AA AA', '000000'],
    ['AA-AA', '000000'],
    ['', ''],
  ])('decodes %j', (input, expected) => {
    expect(hex(input)).toBe(expected);
  });
  it.each(['AAAAAQ', 'AAAAAQ=', 'AA=', 'AAAAA', 'AA-A', 'AAAÄ'])('throws RangeError on %j', (input) => {
    expect(() => pythonBase64Decode(input)).toThrow(RangeError);
    expect(() => pythonBase64Decode(input)).toThrow('E2EE chunk is not valid base64');
  });
  it.each(['AAAAAQ==é', 'AAAAAQ===é', 'AAAA====é', 'AA AAé', 'é'])('throws RangeError on a non-ASCII character anywhere: %j', (input) => {
    expect(() => pythonBase64Decode(input)).toThrow(RangeError);
    expect(() => pythonBase64Decode(input)).toThrow('E2EE chunk is not valid base64');
  });
  it('control: trailing garbage after padding is ignored when it is ASCII', () => {
    expect(hex('AAAAAQ==zz')).toBe('00000001');
    expect(hex('AAAAAQ==')).toBe('00000001');
    expect(hex('AAAA====')).toBe('000000');
  });
  it('parseChunks throws RangeError for a Uint8Array chunk with a byte above 0x7f after its padding', () => {
    const b = Buffer.from('AAAAAQ==', 'latin1');
    expect(() => parseChunks([Buffer.from('AAAAAQ==é', 'latin1'), b, b])).toThrow(RangeError);
  });
  it('chunkBytes decodes a Uint8Array as base64 text, not as raw bytes', () => {
    const asBytes = Buffer.from('AAAAAQ==', 'latin1');
    expect(parseChunks([asBytes, asBytes, asBytes]).ciphertext.toString('hex')).toBe('000000010000000100000001');
    expect(() => parseChunks([Buffer.from('AAAAAQ', 'latin1'), asBytes, asBytes])).toThrow(RangeError);
  });
});

describe('pythonTruthy (P7)', () => {
  it('is false for the Python falsy JSON values', () => {
    for (const v of [undefined, null, false, 0, -0, '', [], {}]) expect(pythonTruthy(v)).toBe(false);
  });
  it('is true for every other value', () => {
    for (const v of [true, 1, '0', ' ', [0], { a: null }]) expect(pythonTruthy(v)).toBe(true);
  });
});

describe('merge decrypted uses Python truthiness (OkLine e2ee.py:409-419)', () => {
  const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
  it('an empty array or object in keyMaterial and fileName restores nothing', () => {
    const wire = { id: '9', contentMetadata: { ENC_KM: 'clear', FILE_NAME: 'f' }, chunks: ['a', 'b', 'c'] };
    const merged = mergeDecrypted(wire, utf8('{"keyMaterial":[],"fileName":{}}'));
    const meta = merged.contentMetadata as Record<string, unknown>;
    expect(meta.ENC_KM).toBe('clear');
    expect(meta.FILE_NAME).toBe('f');
    expect(merged.chunks).toEqual([]);
  });
  it('an empty text, location and REPLACE restore nothing', () => {
    const merged = mergeDecrypted({ id: '9', chunks: ['a', 'b', 'c'] }, utf8('{"text":[],"location":{},"REPLACE":""}'));
    expect('text' in merged).toBe(false);
    expect('location' in merged).toBe(false);
    expect('REPLACE' in (merged.contentMetadata as Record<string, unknown>)).toBe(false);
  });
  it('non-empty values restore (control)', () => {
    const merged = mergeDecrypted({ id: '9', chunks: ['a', 'b', 'c'] }, utf8('{"text":"a","REPLACE":[1],"keyMaterial":"k"}'));
    const meta = merged.contentMetadata as Record<string, unknown>;
    expect(merged.text).toBe('a');
    expect(meta.REPLACE).toEqual([1]);
    expect(meta.ENC_KM).toBe('k');
  });
});
