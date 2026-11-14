// Reads the login state of the extension page. Local CDP reads only: no request goes to a LINE server from this module.
// Method: walk the React fibers, find the fiber whose props have `qrCodeLogin`, and copy primitive values.
// The one write is `refreshQr()`. It calls `qrCodeLogin.startLogin()`, the same function as the refresh button of the page.
// The caller must call `refreshQr()` only for a user request. Never call it from a timer.

import type { CdpPipe } from './cdp-pipe.js';
import type { ExtensionHandles } from './extension-handles.js';

export interface QrLoginReading {
  /** State of the extension QR flow: idle, qr_code_loading, wait_for_qr_code_verified, wait_for_pin_code_verified, success, error. */
  readonly state: string;
  readonly qrCodeLink?: string;
  readonly pinCode?: string;
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

export interface LoginReading {
  /** `IA.getState().auth.loginState`: logged_out, log_in_progressing or logged_in. */
  readonly loginState: string;
  /** Present only when `loginState` is logged_in. */
  readonly mid?: string;
  /** Null when the QR login component is not on the page. */
  readonly qr: QrLoginReading | null;
}

interface RemoteObject {
  value?: unknown;
}

const MAX_TEXT = 2048;

// Shared fiber walk. It returns the `qrCodeLogin` props object of the first fiber that has one, else null.
const FIND_QR_LOGIN = `(() => {
  const root = document.getElementById('root');
  if (!root) return null;
  const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
  if (!key) return null;
  const seen = new Set();
  const container = root[key];
  const start = (container && container.stateNode && container.stateNode.current) || container;
  const stack = [start];
  let visited = 0;
  while (stack.length > 0 && visited < 30000) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    visited += 1;
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object' && props.qrCodeLogin && typeof props.qrCodeLogin === 'object') return props.qrCodeLogin;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return null;
})()`;

const READ_QR = `(() => {
  const q = ${FIND_QR_LOGIN};
  if (!q) return null;
  const text = (value) => (typeof value === 'string' || typeof value === 'number') ? String(value).slice(0, ${MAX_TEXT}) : undefined;
  return { state: text(q.state), qrCodeLink: text(q.qrCodeLink), pinCode: text(q.pinCode), errorMessage: text(q.errorMessage), errorCode: text(q.errorCode) };
})()`;

const REFRESH_QR = `(() => {
  const q = ${FIND_QR_LOGIN};
  if (!q || typeof q.startLogin !== 'function') return false;
  try {
    const result = q.startLogin();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
    return true;
  } catch (error) {
    return false;
  }
})()`;

const READ_AUTH = `function() {
  try {
    const state = this.getState();
    const auth = state && state.auth;
    const loginState = String(auth && auth.loginState);
    const mid = loginState === 'logged_in' && auth.profile && typeof auth.profile.mid === 'string' ? auth.profile.mid.slice(0, 64) : undefined;
    return { loginState, mid };
  } catch (error) {
    return { loginState: 'error' };
  }
}`;

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** One poll. Local reads only. Throws BridgeError when CDP fails. */
export async function readLoginReading(cdp: CdpPipe, handles: ExtensionHandles): Promise<LoginReading> {
  const auth = (await cdp.send('Runtime.callFunctionOn', {
    objectId: handles.ids.IA,
    functionDeclaration: READ_AUTH,
    returnByValue: true,
  }, handles.sessionId)) as { result?: RemoteObject };
  const authValue = (auth.result?.value ?? {}) as { loginState?: unknown; mid?: unknown };
  const qrResponse = (await cdp.send('Runtime.evaluate', { expression: READ_QR, returnByValue: true }, handles.sessionId)) as { result?: RemoteObject };
  const qrValue = qrResponse.result?.value as Record<string, unknown> | null | undefined;
  const qr: QrLoginReading | null = qrValue && typeof qrValue === 'object'
    ? {
        state: optionalText(qrValue.state) ?? 'unknown',
        ...(optionalText(qrValue.qrCodeLink) ? { qrCodeLink: optionalText(qrValue.qrCodeLink) as string } : {}),
        ...(optionalText(qrValue.pinCode) ? { pinCode: optionalText(qrValue.pinCode) as string } : {}),
        ...(optionalText(qrValue.errorMessage) ? { errorMessage: optionalText(qrValue.errorMessage) as string } : {}),
        ...(optionalText(qrValue.errorCode) ? { errorCode: optionalText(qrValue.errorCode) as string } : {}),
      }
    : null;
  const mid = optionalText(authValue.mid);
  return { loginState: optionalText(authValue.loginState) ?? 'unknown', ...(mid ? { mid } : {}), qr };
}

/** Calls `qrCodeLogin.startLogin()` (the refresh button). Returns false when the QR login component is not on the page. */
export async function requestQrRefresh(cdp: CdpPipe, handles: ExtensionHandles): Promise<boolean> {
  const response = (await cdp.send('Runtime.evaluate', { expression: REFRESH_QR, returnByValue: true }, handles.sessionId)) as { result?: RemoteObject };
  return response.result?.value === true;
}
