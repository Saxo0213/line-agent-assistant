// Secondary-device QR login. Ported from OkLine okline/auth.py:822-997 (qr_create_session .. qr_login) and the keychain
// unwrap from okline/e2ee.py:117-141 (load_from_login) + export :142-170. Every call uses requireAuth=false and is
// signed with the empty token (the gateway signs with the current token, which is empty during login).

import type { ChromeGateway } from '../gateway.js';
import { ChromeApiError, ChromeError, tagLoginStage } from '../errors.js';
import type { LtsmBridge } from '../ltsm/bridge.js';
import { coerceNumber, parseTokenIssue } from './token-refresh.js';
import type { ChromeSessionState, ExportedE2eeKeys } from './session-state.js';

/** OkLine auth.py:14 PIN_POLL_LST_MS (bundle `rH = 11e4`). NOT derived from longPollingIntervalSec. */
export const PIN_POLL_LST_MS = 110_000;
/** Margin added to X-LST for the HTTP timeout, so the server's own 410 arrives before the client gives up. */
export const LONG_POLL_TIMEOUT_MARGIN_MS = 20_000;
const DEFAULT_POLL_INTERVAL_SEC = 10;
const DEFAULT_POLL_MAX_COUNT = 12;

/** The slice of the ltsm bridge the login needs (a fake in tests). */
export type QrLoginBridge = Pick<
  LtsmBridge,
  'curveKeyGenerate' | 'e2eePublicKey' | 'e2eeCreateChannel' | 'e2eeUnwrapKeychain' | 'e2eeGetKeyId' | 'e2eeExportKey'
>;

/** The user did not confirm the scan or the PIN within the allowed number of long polls. */
export class ChromeLoginTimeoutError extends ChromeError {
  readonly stage: 'qr' | 'pin';
  constructor(stage: 'qr' | 'pin', cause: unknown) {
    super(`QR login timed out waiting for ${stage === 'qr' ? 'the QR scan' : 'the PIN confirmation'}`, { cause });
    this.stage = stage;
  }
}

/** The gateway answered but the payload lacked what the flow needs. */
export class ChromeLoginProtocolError extends ChromeError {
  /** Fixed machine slug of the reason (a diagnostic, never free text). */
  readonly slug: string;
  constructor(message: string, slug: string) {
    super(message);
    this.slug = slug;
  }
}

export interface QrLoginOptions {
  gateway: ChromeGateway;
  bridge: QrLoginBridge;
  /** Receives the `qr` / `pin` / `qrCert` / `storage` / `token` events and the new credentials. */
  state: ChromeSessionState;
  /** Certificate for verifyCertificate. Defaults to the state's stored certificate. Null or empty is sent as an empty string. */
  certificate?: string | null;
  signal?: AbortSignal;
}

export interface QrLoginE2ee {
  /** keyId to live bridge handle for this process. */
  handles: Record<string, number>;
  /** Persistable key blobs (also stored in the session state). */
  exported: ExportedE2eeKeys;
}

export interface QrLoginResult {
  mid: string | null;
  certificate: string | null;
  /** True when verifyCertificate succeeded, so the PIN step was skipped. */
  skippedPin: boolean;
  /** Present when the metaData keychain was unwrapped. */
  e2ee: QrLoginE2ee | null;
  /** Set when unwrap was attempted and failed. Login still succeeds (OkLine load_from_login is non-fatal). */
  e2eeError: string | null;
}

/**
 * `URL.searchParams.set` semantics of the extension (OkLine _append_secret auth.py:128-137): existing parameters keep
 * their order, `secret` and `e2eeVersion` are set (replaced in place if present, else appended).
 */
export function appendQrSecret(callbackUrl: string, secretB64: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set('secret', secretB64);
  url.searchParams.set('e2eeVersion', '1');
  return url.toString();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(data: unknown, key: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Long poll helper (OkLine _poll auth.py:962-990), minus its retry of transport errors: a retry only on `statuses`. */
async function poll<T>(
  stage: 'qr' | 'pin',
  attempts: number,
  statuses: readonly number[],
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new ChromeError('QR login aborted');
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChromeApiError && error.status !== undefined && statuses.includes(error.status)) {
        last = error; // the poll window elapsed
        continue;
      }
      throw error;
    }
  }
  throw new ChromeLoginTimeoutError(stage, last);
}

/** OkLine e2ee.py:117-141 + 142-170: channel from our curve key and the server public key, unwrap, export each blob. */
export async function unwrapLoginKeychain(
  bridge: QrLoginBridge,
  curveKeyId: number,
  metaData: { publicKey: string; encryptedKeyChain: string },
  mid: string | null,
): Promise<QrLoginE2ee> {
  const channel = await bridge.e2eeCreateChannel(curveKeyId, metaData.publicKey);
  const handles = await bridge.e2eeUnwrapKeychain(channel, metaData.encryptedKeyChain);
  const byId: Record<string, number> = {};
  const keys: Record<string, string> = {};
  let latest: number | null = null;
  for (const handle of handles) {
    let keyId: number;
    try {
      keyId = await bridge.e2eeGetKeyId(handle);
    } catch {
      continue; // OkLine e2ee.py:131-134 skips a handle without an id
    }
    byId[String(keyId)] = handle;
    if (latest === null || keyId > latest) latest = keyId;
    try {
      // Exported now, while the handle is fresh: the module cannot re-export a key that was loaded from an export
      // (OkLine e2ee.py:158-166). A key that fails to export stays usable in this process but is not persisted.
      keys[String(keyId)] = await bridge.e2eeExportKey(handle);
    } catch {
      /* skip */
    }
  }
  if (Object.keys(byId).length === 0) throw new ChromeLoginProtocolError('keychain unwrap produced no usable key', 'keychain_empty');
  return { handles: byId, exported: { mid, latestKeyId: latest, keys } };
}

/** Records the step that started last. A thrown error carries it as a diagnostic (no control flow change). */
export async function qrLogin(options: QrLoginOptions): Promise<QrLoginResult> {
  const track = { stage: 'create_session' };
  try {
    return await qrLoginSteps(options, track);
  } catch (error) {
    tagLoginStage(error, track.stage);
    throw error;
  }
}

async function qrLoginSteps(options: QrLoginOptions, track: { stage: string }): Promise<QrLoginResult> {
  const { gateway, bridge, state, signal } = options;
  const common = { mode: 'write' as const, requireAuth: false, ...(signal ? { signal } : {}) };

  // 1) createSession [{}] -> authSessionId (auth.py:828-838)
  const created = await gateway.call('LoginQrCode.SecondaryQrCodeLoginService.createSession', [{}], common);
  const sessionId = typeof created === 'string' && created !== '' ? created : str(created, 'authSessionId');
  if (!sessionId) throw new ChromeLoginProtocolError('createSession returned no authSessionId', 'no_session_id');

  track.stage = 'create_qr';
  // 2) createQrCode [{authSessionId}] -> callbackUrl, longPollingIntervalSec (default 10), longPollingMaxCount (12)
  const qr = await gateway.call('LoginQrCode.SecondaryQrCodeLoginService.createQrCode', [{ authSessionId: sessionId }], common);
  const callbackUrl = (typeof qr === 'string' ? qr : str(qr, 'callbackUrl')) ?? '';
  if (callbackUrl === '') throw new ChromeLoginProtocolError('createQrCode returned no callbackUrl', 'no_callback_url');
  const interval = (isRecord(qr) ? coerceNumber(qr.longPollingIntervalSec) : null) || DEFAULT_POLL_INTERVAL_SEC;
  const maxCount = Math.max(1, Math.floor((isRecord(qr) ? coerceNumber(qr.longPollingMaxCount) : null) || DEFAULT_POLL_MAX_COUNT));

  track.stage = 'curve_key';
  // 3) Curve25519 keypair inside the wasm (curvekey_generate); its public key is the QR `secret` (auth.py:927-935).
  const curveKeyId = await bridge.curveKeyGenerate();
  const publicKey = await bridge.e2eePublicKey(curveKeyId);
  state.emit('qr', appendQrSecret(callbackUrl, publicKey));

  // 4) checkQrCodeVerified: X-LST = interval*1000, retry on HTTP 410 only, at most longPollingMaxCount calls. OkLine
  //    additionally stretches the count to a caller wait budget (auth.py:921-926); the extension does not, so we don't.
  track.stage = 'qr_poll';
  const qrLst = interval * 1000;
  await poll('qr', maxCount, [410], signal, () =>
    gateway.call(
      'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified',
      [{ authSessionId: sessionId }],
      {
        ...common,
        extraHeaders: { 'X-Line-Session-ID': sessionId, 'X-LST': String(qrLst) },
        timeoutMs: qrLst + LONG_POLL_TIMEOUT_MARGIN_MS,
      },
    ),
  );

  // 5) verifyCertificate is always sent, with "" when no certificate is stored (OkLine auth.py:943-950). Success skips the
  //    PIN. A server rejection (ChromeApiError) goes to the PIN step. A transport error or an abort is thrown.
  track.stage = 'verify_certificate';
  const storedCertificate = options.certificate !== undefined ? options.certificate : state.certificate;
  let skippedPin = false;
  try {
    await gateway.call(
      'LoginQrCode.SecondaryQrCodeLoginService.verifyCertificate',
      [{ authSessionId: sessionId, certificate: storedCertificate ?? '' }],
      common,
    );
    skippedPin = true;
  } catch (error) {
    if (signal?.aborted || !(error instanceof ChromeApiError)) throw error;
    skippedPin = false;
  }

  // 6) createPinCode -> pin event, then checkPinCodeVerified with the fixed X-LST 110000 (auth.py:959-969).
  if (!skippedPin) {
    track.stage = 'create_pin';
    const pinData = await gateway.call(
      'LoginQrCode.SecondaryQrCodeLoginService.createPinCode',
      [{ authSessionId: sessionId }],
      common,
    );
    const pin = typeof pinData === 'string' ? pinData : str(pinData, 'pinCode');
    if (pin !== undefined) state.emit('pin', pin);
    track.stage = 'pin_poll';
    // The PIN poll uses OkLine's default retry statuses (408, 410) and the same attempt count as the scan poll.
    await poll('pin', maxCount, [408, 410], signal, () =>
      gateway.call(
        'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkPinCodeVerified',
        [{ authSessionId: sessionId }],
        {
          ...common,
          extraHeaders: { 'X-Line-Session-ID': sessionId, 'X-LST': String(PIN_POLL_LST_MS) },
          timeoutMs: PIN_POLL_LST_MS + LONG_POLL_TIMEOUT_MARGIN_MS,
        },
      ),
    );
  }

  track.stage = 'qr_login_v2';
  // 7) qrCodeLoginV2 with the exact payload (auth.py:891-912).
  const data = await gateway.call(
    'LoginQrCode.SecondaryQrCodeLoginService.qrCodeLoginV2',
    [{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId: sessionId }],
    common,
  );
  track.stage = 'token_parse';
  const issue = parseTokenIssue(data, { allowAuthToken: true });
  if (!issue) throw new ChromeLoginProtocolError('qrCodeLoginV2 returned no access token', 'no_access_token');
  const record = data as Record<string, unknown>;
  const mid = str(record, 'mid') ?? null;
  const certificate = str(record, 'certificate') ?? null;

  // Keychain: metaData{publicKey, encryptedKeyChain} unwrapped through the bridge with the QR curve key (auth.py:976-983,
  // client.py:368-380). A failure is non-fatal, as in OkLine: login stands, E2EE is just not ready.
  let e2ee: QrLoginE2ee | null = null;
  let e2eeError: string | null = null;
  const meta = record.metaData;
  const metaPublicKey = str(meta, 'publicKey');
  const metaChain = str(meta, 'encryptedKeyChain');
  if (metaPublicKey && metaChain) {
    track.stage = 'keychain';
    try {
      e2ee = await unwrapLoginKeychain(bridge, curveKeyId, { publicKey: metaPublicKey, encryptedKeyChain: metaChain }, mid);
    } catch (error) {
      e2eeError = error instanceof Error ? error.message : String(error);
    }
  }

  track.stage = 'adopt_login';
  state.adoptLogin({ ...issue, certificate, mid, e2eeKeys: e2ee ? e2ee.exported : null });
  return { mid, certificate, skippedPin, e2ee, e2eeError };
}
