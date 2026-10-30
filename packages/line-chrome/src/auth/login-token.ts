// Resume without QR. Ported from OkLine okline/client.py:279-316 (from_tokens_file) + services/profile.py:18-23
// (getProfile), shaped like the linejs adapter's loginToken (linejs-adapter.ts:856-871) and #profile().

import type { ChromeGateway } from '../gateway.js';
import { ChromeApiError, ChromeLoginRequiredError } from '../errors.js';
import type { ChromeSessionState } from './session-state.js';
import type { TokenRefresher } from './token-refresh.js';

/** Same shape as the worker's `TransportIdentity` (worker-loop.ts:19). */
export interface ChromeIdentity {
  ownMid: string;
  displayName: string | null;
  picturePath?: string | null;
}

/** `SyncReason.INITIALIZATION` = 2: the `getProfile [2]` argument from the design brief. */
const GET_PROFILE_SYNC_REASON = 2;
const MID_PATTERN = /^u[0-9a-f]{32}$/i;

/** linejs-adapter normalizeLinePicturePath minus the native-path normalisation: only '/..' or 'https://' paths pass. */
function picturePath(value: unknown, present: boolean): string | null | undefined {
  if (!present) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || (!value.startsWith('/') && !value.startsWith('https://'))) return undefined;
  return value;
}

/** `Talk.TalkService.getProfile [2]`, validated like the adapter's refreshOwnProfile. Records mid and regionCode. */
export async function fetchIdentity(gateway: ChromeGateway, state?: ChromeSessionState): Promise<ChromeIdentity> {
  const profile = await gateway.call('Talk.TalkService.getProfile', [GET_PROFILE_SYNC_REASON], { mode: 'read' });
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new ChromeApiError('LINE profile response is invalid');
  }
  const raw = profile as Record<string, unknown>;
  if (typeof raw.mid !== 'string' || !MID_PATTERN.test(raw.mid)) throw new ChromeApiError('LINE profile response is invalid');
  const mid = raw.mid.toLowerCase();
  const region = typeof raw.regionCode === 'string' && raw.regionCode !== '' ? raw.regionCode : null;
  state?.setProfile(mid, region);
  const path = picturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
  return {
    ownMid: mid,
    displayName: typeof raw.displayName === 'string' && raw.displayName.length <= 256 ? raw.displayName : null,
    ...(path === undefined ? {} : { picturePath: path }),
  };
}

export interface LoginWithTokenOptions {
  gateway: ChromeGateway;
  state: ChromeSessionState;
  refresher: TokenRefresher;
  /** The access token installed in the `token` slot. Adopted when the state does not already hold it. */
  token: string;
}

/**
 * Resume: past the stored expiry (and holding a refresh token), refresh first; then getProfile [2] proves the session
 * and yields the identity. Arms the proactive timer afterwards.
 */
export async function loginWithToken(options: LoginWithTokenOptions): Promise<ChromeIdentity> {
  const { gateway, state, refresher, token } = options;
  if (token === '') throw new ChromeLoginRequiredError('no access token to resume with');
  if (state.accessToken !== token) state.setAccessToken(token);
  if (state.refreshToken && refresher.isExpired()) await refresher.refreshOrThrow();
  const identity = await fetchIdentity(gateway, state);
  refresher.arm();
  return identity;
}
