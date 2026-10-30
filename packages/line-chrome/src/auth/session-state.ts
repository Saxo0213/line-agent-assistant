// Persisted session state of the CHROMEOS transport, mapped onto the worker's three secret slots.
//   token        = accessToken
//   qrCert       = certificate
//   e2eeStorage  = JSON snapshot (see ChromeSessionState.snapshot), guarded by `transport: "CHROMEOS-3.7.2"`
// Ported from OkLine okline/session.py (Session fields :48-104, camelCase keys) and okline/client.py (_reqseq :98,
// next_req_seq :318-320, token mirrors on Tokens). The OkLine file format is replaced by one JSON value because the
// worker owns encrypted storage; the guard keeps a DESKTOPWIN (linejs) snapshot from ever being read as ours.

import { CHROME_EXTENSION_VERSION } from '../constants.js';
import { ChromeError } from '../errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Value of the `transport` guard field. Built from the one version constant. */
export const CHROME_TRANSPORT_TAG = `CHROMEOS-${CHROME_EXTENSION_VERSION}`;

/** Events the worker listens to (`LineTransport.on`, worker-loop.ts:40), 1:1. */
export type ChromeSessionEvent = 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure';
export type ChromeSessionListener = (value?: any) => void;

/** The three secret slots the worker hands to `installSecrets`. */
export interface ChromeSecretSlots {
  token: string | null;
  qrCert: string | null;
  e2eeStorage: JsonValue | null;
}

/** OkLine `E2EEManager.export_keys()` (e2ee.py:142-170): the extension's exportedKeyMap. Private-key material. */
export interface ExportedE2eeKeys {
  mid: string | null;
  latestKeyId: number | null;
  /** keyId (decimal string) to base64 exported key blob. */
  keys: Record<string, string>;
}

/** Raw `refreshApiRetryPolicy` block of a tokenV3IssueResult, kept as sent. */
export type RawRefreshPolicy = Record<string, JsonValue>;

export interface TokenIssue {
  accessToken: string;
  refreshToken: string | null;
  tokenIssueTimeEpochSec: number | null;
  durationUntilRefreshInSec: number | null;
  refreshApiRetryPolicy: RawRefreshPolicy | null;
}

export interface LoginAdoption extends TokenIssue {
  certificate: string | null;
  mid: string | null;
  e2eeKeys: ExportedE2eeKeys | null;
}

export class ChromeSessionStateError extends ChromeError {}

interface SnapshotData {
  refreshToken: string | null;
  tokenIssueTimeEpochSec: number | null;
  durationUntilRefreshInSec: number | null;
  refreshApiRetryPolicy: RawRefreshPolicy | null;
  mid: string | null;
  regionCode: string | null;
  e2eeKeys: ExportedE2eeKeys | null;
  reqSeq: number;
}

const emptyData = (): SnapshotData => ({
  refreshToken: null,
  tokenIssueTimeEpochSec: null,
  durationUntilRefreshInSec: null,
  refreshApiRetryPolicy: null,
  mid: null,
  regionCode: null,
  e2eeKeys: null,
  reqSeq: 0,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(message: string): never {
  throw new ChromeSessionStateError(`invalid CHROMEOS session snapshot: ${message}`);
}

function optString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return fail(`${key} must be a string or null`);
  return v;
}

function optNumber(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${key} must be a finite number or null`);
  return v;
}

function isJson(v: unknown, depth = 0): v is JsonValue {
  if (depth > 8) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isRecord(v)) return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}

function parseE2eeKeys(value: unknown): ExportedE2eeKeys | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return fail('chrome:e2eeKeys must be an object or null');
  const keysRaw = value.keys;
  if (!isRecord(keysRaw)) return fail('chrome:e2eeKeys.keys must be an object');
  const keys: Record<string, string> = {};
  for (const [id, blob] of Object.entries(keysRaw)) {
    if (!/^\d+$/.test(id)) return fail('chrome:e2eeKeys key ids must be decimal strings');
    if (typeof blob !== 'string' || blob === '') return fail('chrome:e2eeKeys blobs must be non-empty strings');
    keys[id] = blob;
  }
  const latest = value.latestKeyId;
  if (latest !== null && latest !== undefined && (typeof latest !== 'number' || !Number.isSafeInteger(latest))) {
    return fail('chrome:e2eeKeys.latestKeyId must be an integer or null');
  }
  const mid = value.mid;
  if (mid !== null && mid !== undefined && typeof mid !== 'string') return fail('chrome:e2eeKeys.mid must be a string or null');
  return { mid: (mid as string | null | undefined) ?? null, latestKeyId: (latest as number | null | undefined) ?? null, keys };
}

/**
 * Strict parse of the `e2eeStorage` slot. `null` yields an empty state. Any snapshot whose `transport` is not
 * CHROMEOS-3.7.2 (for example a DESKTOPWIN linejs storage) is rejected; so is any field of the wrong type.
 * Unknown keys are ignored. `expire` is derived (issue + duration); a stored `expire` is only used when the issue time
 * and duration are absent.
 */
export function parseSessionSnapshot(value: unknown): SnapshotData & { expire: number | null } {
  if (value === null || value === undefined) return { ...emptyData(), expire: null };
  if (!isRecord(value)) return fail('not an object');
  if (value.transport !== CHROME_TRANSPORT_TAG) {
    return fail(`transport is ${JSON.stringify(value.transport)}, expected ${JSON.stringify(CHROME_TRANSPORT_TAG)}`);
  }
  const issue = optNumber(value, 'tokenIssueTimeEpochSec');
  const duration = optNumber(value, 'durationUntilRefreshInSec');
  const storedExpire = optNumber(value, 'expire');
  const policyRaw = value['chrome:refreshApiRetryPolicy'];
  let policy: RawRefreshPolicy | null = null;
  if (policyRaw !== undefined && policyRaw !== null) {
    if (!isRecord(policyRaw) || !isJson(policyRaw)) return fail('chrome:refreshApiRetryPolicy must be a JSON object or null');
    policy = policyRaw as RawRefreshPolicy;
  }
  const reqSeqRaw = value['chrome:reqSeq'];
  let reqSeq = 0;
  if (reqSeqRaw !== undefined && reqSeqRaw !== null) {
    if (typeof reqSeqRaw !== 'number' || !Number.isSafeInteger(reqSeqRaw) || reqSeqRaw < 0) {
      return fail('chrome:reqSeq must be a non-negative integer');
    }
    reqSeq = reqSeqRaw;
  }
  const data: SnapshotData = {
    refreshToken: optString(value, 'refreshToken'),
    tokenIssueTimeEpochSec: issue,
    durationUntilRefreshInSec: duration,
    refreshApiRetryPolicy: policy,
    mid: optString(value, 'mid'),
    regionCode: optString(value, 'regionCode'),
    e2eeKeys: parseE2eeKeys(value['chrome:e2eeKeys']),
    reqSeq,
  };
  const expire = issue !== null && duration !== null ? issue + duration : storedExpire;
  return { ...data, expire };
}

/**
 * Mutable session state shared by the QR login, token refresh, logout and resume paths. It owns the secret slots, the
 * ReqSeq allocator and the worker-facing events. One listener per event (like the linejs adapter's `on`).
 */
export class ChromeSessionState {
  private token: string | null = null;
  private cert: string | null = null;
  private data: SnapshotData = emptyData();
  private expireSec: number | null = null;
  private readonly listeners: Partial<Record<ChromeSessionEvent, ChromeSessionListener>> = {};

  // -- events -----------------------------------------------------------------------------------------------------

  on(event: ChromeSessionEvent, listener: ChromeSessionListener): void {
    this.listeners[event] = listener;
  }

  /** A listener error never breaks an auth flow (OkLine: hooks must never break a call). */
  emit(event: ChromeSessionEvent, value?: unknown): void {
    try {
      this.listeners[event]?.(value);
    } catch {
      /* swallowed on purpose */
    }
  }

  // -- install / snapshot -----------------------------------------------------------------------------------------

  /** `installSecrets`: validates first, then replaces everything. Throws ChromeSessionStateError, leaving state untouched. */
  install(secrets: ChromeSecretSlots): void {
    const parsed = parseSessionSnapshot(secrets.e2eeStorage);
    const { expire, ...data } = parsed;
    this.data = data;
    this.expireSec = expire;
    this.token = secrets.token === '' ? null : secrets.token;
    this.cert = secrets.qrCert === '' ? null : secrets.qrCert;
  }

  /** The JSON written into the `e2eeStorage` slot. */
  snapshot(): JsonValue {
    const d = this.data;
    return {
      transport: CHROME_TRANSPORT_TAG,
      refreshToken: d.refreshToken,
      tokenIssueTimeEpochSec: d.tokenIssueTimeEpochSec,
      durationUntilRefreshInSec: d.durationUntilRefreshInSec,
      expire: this.expireSec,
      'chrome:refreshApiRetryPolicy': d.refreshApiRetryPolicy,
      mid: d.mid,
      regionCode: d.regionCode,
      'chrome:e2eeKeys':
        d.e2eeKeys === null ? null : { mid: d.e2eeKeys.mid, latestKeyId: d.e2eeKeys.latestKeyId, keys: { ...d.e2eeKeys.keys } },
      'chrome:reqSeq': d.reqSeq,
    };
  }

  // -- accessors --------------------------------------------------------------------------------------------------

  get accessToken(): string | null {
    return this.token;
  }
  get certificate(): string | null {
    return this.cert;
  }
  get refreshToken(): string | null {
    return this.data.refreshToken;
  }
  /** Epoch seconds when the access token must be refreshed (issue + duration), or null. */
  get expire(): number | null {
    return this.expireSec;
  }
  get tokenIssueTimeEpochSec(): number | null {
    return this.data.tokenIssueTimeEpochSec;
  }
  get durationUntilRefreshInSec(): number | null {
    return this.data.durationUntilRefreshInSec;
  }
  get refreshApiRetryPolicy(): RawRefreshPolicy | null {
    return this.data.refreshApiRetryPolicy;
  }
  get mid(): string | null {
    return this.data.mid;
  }
  get regionCode(): string | null {
    return this.data.regionCode;
  }
  get e2eeKeys(): ExportedE2eeKeys | null {
    return this.data.e2eeKeys;
  }
  /** Last allocated ReqSeq (0 when none). */
  get lastReqSeq(): number {
    return this.data.reqSeq;
  }

  /** Sets the access token only (resume path); no events. */
  setAccessToken(token: string | null): void {
    this.token = token === '' ? null : token;
  }

  // -- mutations --------------------------------------------------------------------------------------------------

  /**
   * After a successful qrCodeLoginV2: adopt tokens, certificate, mid and exported E2EE keys, then tell the worker
   * (qrCert, storage, token), as the linejs adapter does via update:qrcert / storage / update:authtoken
   * (linejs-adapter.ts:818-830).
   */
  adoptLogin(login: LoginAdoption): void {
    this.token = login.accessToken;
    this.applyIssue(login);
    if (login.mid) this.data.mid = login.mid;
    if (login.e2eeKeys) {
      this.data.e2eeKeys = {
        mid: login.e2eeKeys.mid ?? login.mid ?? this.data.mid,
        latestKeyId: login.e2eeKeys.latestKeyId,
        keys: { ...login.e2eeKeys.keys },
      };
    }
    const certChanged = !!login.certificate && login.certificate !== this.cert;
    if (login.certificate) this.cert = login.certificate;
    if (certChanged) this.emit('qrCert', this.cert);
    this.emit('storage', this.snapshot());
    this.emit('token', this.token);
  }

  /**
   * After a successful tokenRefresh: new access token, rotated refresh token, new schedule (OkLine
   * _apply_refresh_response auth.py:1100-1117). Like the linejs adapter (linejs-adapter.ts:751) the worker gets ONE
   * `credentials` event carrying token + the full snapshot, not separate token/storage events.
   */
  adoptRefresh(issue: TokenIssue): void {
    this.token = issue.accessToken;
    this.applyIssue(issue);
    this.emit('credentials', { token: this.token, e2eeStorage: this.snapshot() });
  }

  /** Records the profile mid / region from getProfile (OkLine profile.py:21-22 sets tokens.mid). */
  setProfile(mid: string | null, regionCode: string | null): void {
    const changed = (mid !== null && mid !== this.data.mid) || (regionCode !== null && regionCode !== this.data.regionCode);
    if (mid !== null) this.data.mid = mid;
    if (regionCode !== null) this.data.regionCode = regionCode;
    if (changed) this.emit('storage', this.snapshot());
  }

  /** Replaces the exported key blobs and checkpoints. */
  setE2eeKeys(keys: ExportedE2eeKeys | null): void {
    this.data.e2eeKeys = keys;
    this.emit('storage', this.snapshot());
  }

  /**
   * OkLine _set_token_schedule (auth.py:1119-1163): a response without a schedule CLEARS the previous one so a stale
   * retry policy or fire time never governs the next refresh.
   */
  private applyIssue(issue: TokenIssue): void {
    if (issue.refreshToken) this.data.refreshToken = issue.refreshToken;
    if (issue.tokenIssueTimeEpochSec === null || issue.durationUntilRefreshInSec === null) {
      this.data.tokenIssueTimeEpochSec = null;
      this.data.durationUntilRefreshInSec = null;
      this.data.refreshApiRetryPolicy = null;
      this.expireSec = null;
      return;
    }
    this.data.tokenIssueTimeEpochSec = issue.tokenIssueTimeEpochSec;
    this.data.durationUntilRefreshInSec = issue.durationUntilRefreshInSec;
    this.data.refreshApiRetryPolicy = issue.refreshApiRetryPolicy;
    this.expireSec = issue.tokenIssueTimeEpochSec + issue.durationUntilRefreshInSec;
  }

  // -- ReqSeq (ruling 8) ------------------------------------------------------------------------------------------

  /**
   * Next ReqSeq. OkLine client.py:318-320: `self._reqseq += 1; return self._reqseq` (starts at 0, so the first value is
   * 1). Added here: the counter lives in the persisted snapshot, resumes at saved+1 after a restart, and a `storage`
   * event checkpoints it after every allocation, before the value is used on the wire.
   */
  nextReqSeq(): number {
    if (this.data.reqSeq >= Number.MAX_SAFE_INTEGER) throw new ChromeSessionStateError('reqSeq space exhausted');
    this.data.reqSeq += 1;
    const value = this.data.reqSeq;
    this.emit('storage', this.snapshot());
    return value;
  }
}
