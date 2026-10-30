import { describe, expect, it } from 'vitest';
import { decodeEncKm, decryptBlob, deriveFileKeys, encryptBlob, generateEncKm } from './media-crypto.js';

const km = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

describe('sealed media key material (OkLine e2ee_crypto.py:212-276)', () => {
  it('derives 32 + 32 + 12 bytes (608 bits)', () => {
    const { encKey, macKey, nonce } = deriveFileKeys(km);
    expect([encKey.length, macKey.length, nonce.length]).toEqual([32, 32, 12]);
  });

  it('matches the OkLine fixed vector (HKDF-SHA256 "FileEncryption", AES-CTR, HMAC-SHA256)', () => {
    // OkLine tests/test_e2ee.py::test_blob_encrypt_fixed_vector
    const blob = encryptBlob(km, Buffer.from('okline'));
    expect(blob.toString('base64')).toBe('OgtqusWMqZLZ+9pICPfDisnDS5CoOqmDISRWpW794GeFPdNFmWI=');
  });

  it('decrypts the OkLine fixed vector', () => {
    const blob = Buffer.from('OgtqusWMqZLZ+9pICPfDisnDS5CoOqmDISRWpW794GeFPdNFmWI=', 'base64');
    expect(decryptBlob(km, blob).toString()).toBe('okline');
  });

  it('round-trips and appends a 32-byte tag', () => {
    const data = Buffer.from('the quick brown fox jumps over the lazy dog'.repeat(10));
    const blob = encryptBlob(km, data);
    expect(blob.length).toBe(data.length + 32);
    expect(blob.subarray(0, data.length).equals(data)).toBe(false);
    expect(decryptBlob(km, blob).equals(data)).toBe(true);
  });

  it('round-trips an empty blob', () => {
    expect(decryptBlob(km, encryptBlob(km, Buffer.alloc(0))).length).toBe(0);
  });

  it('rejects a tampered ciphertext, a tampered tag, the wrong key and a short blob', () => {
    const blob = Buffer.from(encryptBlob(km, Buffer.from('payload')));
    const flipped = Buffer.from(blob);
    flipped[0]! ^= 1;
    expect(() => decryptBlob(km, flipped)).toThrow(/HMAC/);
    const tag = Buffer.from(blob);
    tag[tag.length - 1]! ^= 1;
    expect(() => decryptBlob(km, tag)).toThrow(/HMAC/);
    expect(() => decryptBlob(Buffer.alloc(32), blob)).toThrow(/HMAC/);
    expect(() => decryptBlob(km, Buffer.from('too short'))).toThrow(RangeError);
  });

  it('generates 32 random bytes of base64 ENC_KM', () => {
    const a = generateEncKm();
    expect(decodeEncKm(a)).toHaveLength(32);
    expect(generateEncKm()).not.toBe(a);
    expect(decodeEncKm(a.replace(/=+$/, ''))).toHaveLength(32); // padding optional
  });

  it('decodeEncKm follows OkLine e2ee.py:394 (pad, then Python base64)', () => {
    for (const text of ['AAAAAQ', 'AAAAAQ=', 'AAAAAQ==', 'AAAAAQ==zz']) expect(decodeEncKm(text).toString('hex')).toBe('00000001');
    expect(decodeEncKm('AA').toString('hex')).toBe('00');
    expect(decodeEncKm('')).toHaveLength(0);
    for (const text of ['AAAAA', 'AAAAAQ==é', 'AAAÄ']) expect(() => decodeEncKm(text)).toThrow(RangeError);
    const km = Buffer.alloc(32, 7);
    expect(decodeEncKm(km.toString('base64').slice(0, 43)).equals(km)).toBe(true);
    expect(decodeEncKm(Buffer.alloc(45, 9).toString('base64'))).toHaveLength(45);
    expect(Buffer.alloc(45, 9).toString('base64')).toHaveLength(60);
  });
});
