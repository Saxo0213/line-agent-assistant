// Server logout. Ported from OkLine okline/auth.py:1165-1177 (logout: `Talk.AuthService.logoutV2`, empty argument list).
// The extension also drops its `lct` cookie and local auth state afterwards; the worker owns clearing secrets, so this
// only stops the refresh timer and reports the outcome.

import type { ChromeGateway } from '../gateway.js';
import { isSessionKickout } from '../errors.js';
import type { ChromeSessionState } from './session-state.js';
import type { TokenRefresher } from './token-refresh.js';

export interface LogoutOptions {
  gateway: ChromeGateway;
  state: ChromeSessionState;
  refresher?: TokenRefresher;
  signal?: AbortSignal;
}

/**
 * `Talk.AuthService.logoutV2 []`. A write: never retried. If the server answers that the session is already dead
 * (inner 1/7/8), that is the outcome the caller wanted: `authInvalidated` is emitted and the call resolves, like the
 * linejs adapter's logoutServer. Any other error is rethrown and the refresh timer is re-armed.
 */
export async function logoutV2(options: LogoutOptions): Promise<void> {
  const { gateway, state, refresher, signal } = options;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('server logout aborted');
  refresher?.stop();
  try {
    await gateway.call('Talk.AuthService.logoutV2', [], { mode: 'write', ...(signal ? { signal } : {}) });
  } catch (error) {
    if (isSessionKickout(error)) {
      state.emit('authInvalidated');
      return;
    }
    refresher?.resume();
    refresher?.arm();
    throw error;
  }
}
