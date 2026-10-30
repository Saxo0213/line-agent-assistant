// E2EE (Letter Sealing) message framing: the pure half. Faithful port of OkLine okline/e2ee_crypto.py:54-186 (the
// extension bundle's gL/wL/bL/vL/hL/mL/fL/EL/yL helpers). The crypto itself runs inside the ltsm module (LtsmBridge).

import { parsePreciseJson, pythonTruthy } from '../json.js';

/** A LINE Message struct as it travels on the Chrome gateway (Thrift field names, numeric enums). */
export type ChromeMessage = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** OkLine e2ee_crypto.py `key_id_to_bytes` (`LR`): big-endian, fixed 4 bytes, truncated to 32 bits. */
export function keyIdToBytes(n: number | string | bigint): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(Number(BigInt.asUintN(32, BigInt(n))), 0);
  return out;
}

/** OkLine `key_id_from_bytes` (`IR`). */
export function keyIdFromBytes(bytes: Uint8Array): number {
  let n = 0n;
  for (const byte of Buffer.from(bytes)) n = (n << 8n) | BigInt(byte);
  return Number(n);
}

/** OkLine `serialize_plaintext` (`wL(gL(message))`): the UTF-8 JSON bytes that get encrypted. REPLACE and ENC_KM use Python truthiness (P7). */
export function serializePlaintext(message: ChromeMessage): Buffer {
  const obj: Record<string, unknown> = {};
  if (message.text !== undefined && message.text !== null) obj.text = message.text;
  if (message.location !== undefined && message.location !== null) obj.location = message.location;
  const meta = isRecord(message.contentMetadata) ? message.contentMetadata : {};
  const replace = meta.REPLACE;
  if (pythonTruthy(replace)) {
    // MR: JSON.parse on strings, non-strings pass through; a parse failure drops the key, never keeps the raw string.
    if (typeof replace === 'string') {
      try {
        obj.REPLACE = JSON.parse(replace);
      } catch {
        /* dropped */
      }
    } else {
      obj.REPLACE = replace;
    }
  }
  if (pythonTruthy(meta.ENC_KM)) {
    obj.keyMaterial = meta.ENC_KM;
    if (meta.FILE_NAME !== undefined && meta.FILE_NAME !== null) obj.fileName = meta.FILE_NAME;
  }
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

/** OkLine `_escape_controls` (`xL`): C0 and 0x80-0xFF characters become `\u00XX` JSON escapes, preserved not deleted. */
function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u0080-ÿ]/g, (c) => `\\u00${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** OkLine `deserialize_plaintext` (`bL`): decrypted bytes back into `{text, location, ...}`; lenient on bad JSON. */
export function deserializePlaintext(data: Uint8Array): Record<string, unknown> {
  const text = Buffer.from(data).toString('utf8');
  let parsed: unknown;
  try {
    parsed = parsePreciseJson(escapeControls(text));
  } catch {
    // Deliberate leniency (the extension throws): surface the raw text when the bytes are not JSON.
    return { text };
  }
  // Valid JSON that is not an object fails the decrypt (OkLine e2ee_crypto.py:95-103).
  if (!isRecord(parsed)) throw new TypeError('E2EE plaintext is not an object');
  return parsed;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

/** OkLine `build_chunks` (`vL`): V2 chunks `[ct[0:16], ct[28:], ct[16:28], senderKeyId, receiverKeyId]`. */
export function buildChunks(ciphertext: Uint8Array, senderKeyId: number | string, receiverKeyId: number | string): string[] {
  const e = Buffer.from(ciphertext);
  return [
    b64(e.subarray(0, 16)),
    b64(e.subarray(28)),
    b64(e.subarray(16, 28)),
    b64(keyIdToBytes(senderKeyId)),
    b64(keyIdToBytes(receiverKeyId)),
  ];
}

export interface ParsedChunks {
  ciphertext: Buffer;
  /** null unless all five chunks are present (OkLine `parse_chunks`: a short message yields None, never a silent 0). */
  senderKeyId: number | null;
  receiverKeyId: number | null;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Python `base64.b64decode(s)` with `validate=False` (`binascii.a2b_base64(s, strict_mode=False)`).
 * It ignores characters outside the alphabet. It throws on a non-ASCII character, on bad padding
 * and on a dangling sextet. It discards the bits left over after the last full byte.
 */
export function pythonBase64Decode(text: string): Buffer {
  const fail = (): never => {
    throw new RangeError('E2EE chunk is not valid base64');
  };
  const out: number[] = [];
  let quadPos = 0;
  let pads = 0;
  let acc = 0;
  // Python `str.encode('ascii')` runs before `a2b_base64`: a non-ASCII character anywhere throws, also after the padding stop (P3 rule 1).
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7f) fail();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '=') {
      if (quadPos >= 2) {
        pads += 1;
        if (quadPos + pads >= 4) return Buffer.from(out);
      }
      continue;
    }
    const v = B64_ALPHABET.indexOf(ch as string);
    if (v < 0) continue;
    pads = 0;
    if (quadPos === 0) {
      acc = v;
      quadPos = 1;
    } else if (quadPos === 1) {
      out.push(((acc << 2) | (v >> 4)) & 0xff);
      acc = v & 0x0f;
      quadPos = 2;
    } else if (quadPos === 2) {
      out.push(((acc << 4) | (v >> 2)) & 0xff);
      acc = v & 0x03;
      quadPos = 3;
    } else {
      out.push(((acc << 6) | v) & 0xff);
      acc = 0;
      quadPos = 0;
    }
  }
  if (quadPos !== 0) fail();
  return Buffer.from(out);
}

function chunkBytes(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return pythonBase64Decode(chunk);
  if (chunk instanceof Uint8Array) return pythonBase64Decode(Buffer.from(chunk).toString('latin1'));
  throw new TypeError('E2EE chunk is neither a base64 string nor bytes');
}

function keyIds(chunks: readonly unknown[]): Pick<ParsedChunks, 'senderKeyId' | 'receiverKeyId'> {
  if (chunks.length >= 5) return { senderKeyId: keyIdFromBytes(chunkBytes(chunks[3])), receiverKeyId: keyIdFromBytes(chunkBytes(chunks[4])) };
  return { senderKeyId: null, receiverKeyId: null };
}

/** OkLine `parse_chunks` (`hL`): V2 ciphertext is `c[0] + c[2] + c[1]` (salt/tag swapped back). */
export function parseChunks(chunks: readonly unknown[]): ParsedChunks {
  if (chunks.length < 3) throw new RangeError('E2EE message has fewer than 3 chunks');
  const ciphertext = Buffer.concat([chunkBytes(chunks[0]), chunkBytes(chunks[2]), chunkBytes(chunks[1])]);
  return { ciphertext, ...keyIds(chunks) };
}

/** OkLine `build_chunks_v1` (`mL`): V1 chunks `[salt(8), body, tag(16), senderKeyId, receiverKeyId]`. */
export function buildChunksV1(ciphertext: Uint8Array, senderKeyId: number | string, receiverKeyId: number | string): string[] {
  const e = Buffer.from(ciphertext);
  return [
    b64(e.subarray(0, 8)),
    b64(e.subarray(8, e.length - 16)),
    b64(e.subarray(e.length - 16)),
    b64(keyIdToBytes(senderKeyId)),
    b64(keyIdToBytes(receiverKeyId)),
  ];
}

/** OkLine `parse_chunks_v1` (`fL`): V1 chunks concatenate in order. */
export function parseChunksV1(chunks: readonly unknown[]): ParsedChunks {
  if (chunks.length < 3) throw new RangeError('E2EE message has fewer than 3 chunks');
  const ciphertext = Buffer.concat([chunkBytes(chunks[0]), chunkBytes(chunks[1]), chunkBytes(chunks[2])]);
  return { ciphertext, ...keyIds(chunks) };
}

/** OkLine `message_e2ee_version`: the Letter-Sealing version of a received message (1 or 2; default 2). */
export function messageE2eeVersion(message: ChromeMessage): 1 | 2 {
  const meta = isRecord(message.contentMetadata) ? message.contentMetadata : {};
  const raw = meta.e2eeVersion;
  // Python int() rules (OkLine e2ee_crypto.py:160-166): an empty or falsy value gives 2.
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === false) return 2;
  let n: number;
  if (typeof raw === 'number') n = Math.trunc(raw);
  else if (raw === true) n = 1;
  else if (typeof raw === 'string' && /^\s*[+-]?\d+\s*$/.test(raw)) n = Number(raw.trim());
  else return 2;
  return n === 1 ? 1 : 2;
}

/**
 * OkLine `build_e2ee_message` (`EL`): turn a plain message plus chunks into the sealed Message struct.
 * `e2eeVersion` is a STRING; text and location are removed; REPLACE (and ENC_KM/FILE_NAME when key material was sealed)
 * leave contentMetadata because they now live in the ciphertext. `from` is deleted too: a live-verified deviation from
 * the bundle that OkLine documents (the gateway 500s on `from`). Do not "fix" it. REPLACE and ENC_KM use Python truthiness (P7).
 */
export function buildE2eeMessage(message: ChromeMessage, chunks: string[], version: 1 | 2 = 2): ChromeMessage {
  const meta: Record<string, unknown> = isRecord(message.contentMetadata) ? { ...message.contentMetadata } : {};
  const hasEncKm = pythonTruthy(meta.ENC_KM);
  meta.e2eeVersion = String(version);
  delete meta.REPLACE;
  if (hasEncKm) {
    delete meta.ENC_KM;
    delete meta.FILE_NAME;
  }
  const out: ChromeMessage = { ...message, contentMetadata: meta, chunks };
  delete out.text;
  delete out.location;
  delete out.from;
  return out;
}

/** OkLine `is_e2ee_message`: a received message is Letter-Sealed when it carries at least 3 chunks. */
export function isE2eeMessage(message: ChromeMessage): boolean {
  return Array.isArray(message.chunks) && message.chunks.length >= 3;
}

/**
 * OkLine e2ee.py:398-422 `_finish_decrypt` (`yL`; fields at :409-419 use Python truthiness, P7): merge decrypted plaintext back into the message. Restores text and
 * location and, inside contentMetadata, REPLACE, ENC_KM and FILE_NAME; clears the chunks.
 */
export function mergeDecrypted(message: ChromeMessage, plaintext: Uint8Array): ChromeMessage {
  const plain = deserializePlaintext(plaintext);
  const out: ChromeMessage = { ...message, chunks: [] };
  if (pythonTruthy(plain.text)) out.text = plain.text;
  if (pythonTruthy(plain.location)) out.location = plain.location;
  const meta: Record<string, unknown> = isRecord(out.contentMetadata) ? { ...out.contentMetadata } : {};
  if (pythonTruthy(plain.REPLACE)) meta.REPLACE = plain.REPLACE;
  if (pythonTruthy(plain.keyMaterial)) meta.ENC_KM = plain.keyMaterial;
  if (pythonTruthy(plain.fileName)) meta.FILE_NAME = plain.fileName;
  out.contentMetadata = meta;
  return out;
}
