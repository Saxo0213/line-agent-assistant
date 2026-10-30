// Sealed-media blob encryption (V2 flow). Faithful port of OkLine okline/e2ee_crypto.py:197-276 (the bundle's NL/_L/CL/TL):
// HKDF-SHA256 (empty salt, info "FileEncryption", 608 bits) -> AES-CTR key (32) + HMAC key (32) + nonce (12), then
// ciphertext || HMAC-SHA256(ciphertext). Counter block = nonce || 00 00 00 00.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { pythonBase64Decode } from './framing.js';

const FILE_ENCRYPTION_INFO = Buffer.from('FileEncryption', 'utf8');
const ENC_KM_KEY_BYTES = 32;
const BLOB_TAG_BYTES = 32;

/** `NL`: fresh `contentMetadata.ENC_KM`, base64 of 32 random bytes. */
export function generateEncKm(): string {
  return randomBytes(ENC_KM_KEY_BYTES).toString('base64');
}

/** OkLine e2ee.py:394 `base64.b64decode(enc_km + "=" * (-len(enc_km) % 4))`: pad to a multiple of 4, then Python base64 (P3, L1). */
export function decodeEncKm(encKm: string): Buffer {
  return pythonBase64Decode(encKm + '='.repeat((4 - (encKm.length % 4)) % 4));
}

export interface FileKeys {
  encKey: Buffer;
  macKey: Buffer;
  nonce: Buffer;
}

/** `_L`: HKDF-SHA256 over the key material. A zero-length salt equals the all-zero HashLen salt (RFC 5869). */
export function deriveFileKeys(keyMaterial: Uint8Array): FileKeys {
  const okm = Buffer.from(hkdfSync('sha256', keyMaterial, Buffer.alloc(0), FILE_ENCRYPTION_INFO, 76));
  return { encKey: okm.subarray(0, 32), macKey: okm.subarray(32, 64), nonce: okm.subarray(64, 76) };
}

function counterBlock(nonce: Buffer): Buffer {
  return Buffer.concat([nonce, Buffer.alloc(4)]);
}

/** `CL`/`TL`: encrypt a sealed-media file blob to `ciphertext || tag`. */
export function encryptBlob(keyMaterial: Uint8Array, data: Uint8Array): Buffer {
  const { encKey, macKey, nonce } = deriveFileKeys(keyMaterial);
  const cipher = createCipheriv('aes-256-ctr', encKey, counterBlock(nonce));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = createHmac('sha256', macKey).update(ciphertext).digest();
  return Buffer.concat([ciphertext, tag]);
}

/** Inverts `encryptBlob`; verifies the trailing HMAC tag first. */
export function decryptBlob(keyMaterial: Uint8Array, blob: Uint8Array): Buffer {
  if (blob.length < BLOB_TAG_BYTES) throw new RangeError('blob too short to carry an HMAC tag');
  const b = Buffer.from(blob);
  const ciphertext = b.subarray(0, b.length - BLOB_TAG_BYTES);
  const tag = b.subarray(b.length - BLOB_TAG_BYTES);
  const { encKey, macKey, nonce } = deriveFileKeys(keyMaterial);
  const expected = createHmac('sha256', macKey).update(ciphertext).digest();
  if (!timingSafeEqual(expected, tag)) throw new Error('sealed-media blob HMAC verification failed');
  const decipher = createDecipheriv('aes-256-ctr', encKey, counterBlock(nonce));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
