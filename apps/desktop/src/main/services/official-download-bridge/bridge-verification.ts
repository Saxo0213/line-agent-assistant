// Verification of a message that the External Monitor built (from the official desktop row) against the same message
// that the Chrome extension received. Local reads only: no request goes to a LINE server.
// The comparison runs inside the extension page. The page gives back only booleans and the words below. It never gives a value.
// Never log or audit any metadata value (key, SID, OID, OBS_POP, DOWNLOAD_URL).

import type { BridgeVerificationCounts, BridgeVerificationKindCounts } from '@line-agent/database';

/** The store gets the message from the extension event stream. Read it again every 2 s, at most 60 s. */
export const BRIDGE_VERIFY_POLL_MS = 2_000;
export const BRIDGE_VERIFY_WAIT_MS = 60_000;

/**
 * Old-message gate. A message that is not in the extension store may download with the built message only when,
 * for its kind, the `match` count reaches the threshold and the `mismatch` count is 0.
 */
export const BRIDGE_GATE_IMAGE_MATCH_THRESHOLD = 50;
export const BRIDGE_GATE_FILE_MATCH_THRESHOLD = 20;

export type BridgeKind = 'image' | 'file';
export type BridgeVerifyResult = 'match' | 'mismatch' | 'not_in_store' | 'native_incomplete';

export interface BridgeVerification {
  readonly result: BridgeVerifyResult;
  /** Names only (item names and the words below). It matches `^[A-Za-z0-9_.:-]{1,160}$`. */
  readonly detail: string;
}

/** Audit result codes of the four results. */
export const BRIDGE_VERIFY_RESULT_CODES = {
  match: 'BRIDGE_VERIFY_MATCH',
  mismatch: 'BRIDGE_VERIFY_MISMATCH',
  not_in_store: 'BRIDGE_VERIFY_NOT_IN_STORE',
  native_incomplete: 'BRIDGE_VERIFY_NATIVE_INCOMPLETE',
} as const satisfies Record<BridgeVerifyResult, string>;

export function bridgeGateThreshold(kind: BridgeKind): number {
  return kind === 'image' ? BRIDGE_GATE_IMAGE_MATCH_THRESHOLD : BRIDGE_GATE_FILE_MATCH_THRESHOLD;
}

export function isBridgeGateOpen(kind: BridgeKind, counts: BridgeVerificationCounts): boolean {
  const own: BridgeVerificationKindCounts = counts[kind];
  return own.match >= bridgeGateThreshold(kind) && own.mismatch === 0;
}

/**
 * Runs on the store message (`this`). Arguments: the built message (by value) and the extension function `QO` (by object id).
 * `QO` only builds a path string. It sends no request. Both paths are compared here and not returned.
 */
export const BRIDGE_COMPARE_FUNCTION = `function(m,qo){
  const a=this.contentMetadata||{},b=m.contentMetadata||{};
  const e=v=>v===undefined||v===null||v==='';
  const f=k=>e(a[k])&&e(b[k])?'same':e(a[k])?'missing_chrome':e(b[k])?'missing_official':String(a[k])===String(b[k])?'same':'diff';
  const p=(x,o)=>{try{const r=qo(x,o);return typeof r==='string'&&r.length>0?r:null}catch(_){return null}};
  const pa=p(this),pb=p(m),ha=p(this,{withoutTid:true}),hb=p(m,{withoutTid:true});
  return {id:String(this.id)===String(m.id),contentType:Number(this.contentType)===Number(m.contentType),
    SID:f('SID'),OID:f('OID'),OBS_POP:f('OBS_POP'),DOWNLOAD_URL:f('DOWNLOAD_URL'),e2eeVersion:f('e2eeVersion'),ENC_KM:f('ENC_KM'),
    FILE_NAME:f('FILE_NAME'),FILE_SIZE:f('FILE_SIZE'),MEDIA_CONTENT_INFO:f('MEDIA_CONTENT_INFO'),
    path:pa!==null&&pa===pb,headPath:ha!==null&&ha===hb}
}`;

const FLAG_NAMES = ['id', 'contentType', 'path', 'headPath'] as const;
/** These must be `same`. */
const STRICT_NAMES = ['ENC_KM', 'DOWNLOAD_URL', 'e2eeVersion', 'SID', 'OBS_POP'] as const;
/** OID may be missing on one side. Only `diff` blocks. */
const OID_NAME = 'OID';
/** Information only. A difference is named in the detail and never blocks. */
const INFO_NAMES = ['FILE_NAME', 'FILE_SIZE', 'MEDIA_CONTENT_INFO'] as const;
const STATE_WORDS = ['same', 'diff', 'missing_chrome', 'missing_official'] as const;
type StateWord = (typeof STATE_WORDS)[number];

function isState(value: unknown): value is StateWord {
  return typeof value === 'string' && (STATE_WORDS as readonly string[]).includes(value);
}

/** Turns the page answer into a result. Returns null when the answer has a wrong shape. */
export function classifyBridgeComparison(raw: unknown): BridgeVerification | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  for (const name of FLAG_NAMES) if (typeof input[name] !== 'boolean') return null;
  for (const name of [...STRICT_NAMES, OID_NAME, ...INFO_NAMES]) if (!isState(input[name])) return null;
  const segments: string[] = [];
  const failedFlags = FLAG_NAMES.filter((name) => input[name] !== true);
  if (failedFlags.length > 0) segments.push(`false:${failedFlags.join(':')}`);
  for (const state of ['diff', 'missing_chrome', 'missing_official'] as const) {
    const names: string[] = STRICT_NAMES.filter((name) => input[name] === state);
    if (state === 'diff' && input[OID_NAME] === 'diff') names.push(OID_NAME);
    if (names.length > 0) segments.push(`${state}:${names.join(':')}`);
  }
  const blocking = segments.length > 0;
  const info = INFO_NAMES.filter((name) => input[name] !== 'same');
  if (info.length > 0) segments.push(`info:${info.join(':')}`);
  if (!blocking) segments.unshift('match');
  return { result: blocking ? 'mismatch' : 'match', detail: segments.join('.').slice(0, 160) };
}

/** First bytes of a photo: JPEG, PNG, GIF, WEBP or HEIF/HEIC. */
export function isSupportedImageHead(bytes: Uint8Array): boolean {
  const at = (index: number): number => bytes[index] ?? -1;
  const text = (start: number, value: string): boolean => [...value].every((char, offset) => at(start + offset) === char.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return true;
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return true;
  if (text(0, 'RIFF') && text(8, 'WEBP')) return true;
  return text(4, 'ftyp');
}
