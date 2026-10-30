import { ChromeApiError, ChromeTransportError, thriftPath, type ThriftEndpointKey } from '@line-agent/line-chrome';
import { TALK_SERVER_ERRORS, talkServerError, type RelationAddServerErrorCode } from '@line-agent/contracts';
import { LineServerRejection } from './line-server-error.js';
import { friendAddResultCode, friendAddRejectionReason } from './linejs-adapter.js';

/** Talk endpoints whose TalkException is projected into a stable `LINE_TALK_*` code (same set the DESKTOPWIN decoder trusts). */
const TRUSTED_TALK_KEYS: ReadonlySet<ThriftEndpointKey> = new Set<ThriftEndpointKey>([
  'Talk.TalkService.sendMessage', 'Talk.TalkService.unsendMessage', 'Talk.TalkService.react', 'Talk.TalkService.cancelReaction',
  'Talk.TalkService.registerE2EEGroupKey', 'Talk.TalkService.acquireEncryptedAccessToken', 'Talk.TalkService.getE2EEPublicKey',
  'Talk.TalkService.negotiateE2EEPublicKey', 'Talk.TalkService.getE2EEGroupSharedKey', 'Talk.TalkService.getLastE2EEGroupSharedKey',
  'Talk.TalkService.getLastE2EEPublicKeys', 'Talk.TalkService.getAllContactIds', 'Talk.TalkService.getBlockedContactIds',
] as ThriftEndpointKey[]);
const TRUSTED_TALK_PATHS = new Set([...TRUSTED_TALK_KEYS].map((key) => thriftPath(key)));
const TALK_NAME_BY_NUMBER: ReadonlyMap<number, string> = new Map(
  Object.entries(TALK_SERVER_ERRORS).map(([name, [number]]) => [number, name] as const));

/**
 * The CHROMEOS counterpart of `decodeLinejsServerRejection`: a gateway answer that carries a nested TalkException code is a
 * definitive server rejection ("failed" with a stable code); everything else, including transport errors, stays an unknown
 * outcome for a write. 8 (NOT_AUTHORIZED_DEVICE) is a session event, not a rejection. 119 (MUST_REFRESH_V3_TOKEN) is a definitive rejection:
 * the gateway renews the token, does not replay the write, and the write did not run.
 */
export function decodeChromeServerRejection(error: unknown): LineServerRejection | null {
  if (!(error instanceof ChromeApiError) || error instanceof ChromeTransportError) return null;
  if (error.path === undefined || !TRUSTED_TALK_PATHS.has(error.path)) return null;
  const code = error.innerCode;
  if (code === undefined || code === 8) return null;
  const projection = talkServerError(TALK_NAME_BY_NUMBER.get(code));
  return projection ? new LineServerRejection(projection.code, projection.upstreamCode) : null;
}

/**
 * `RelationService.addFriendByMid` rejects with an AddFriendResult, not a TalkException. OkLine (contacts.py:163-176) says the
 * rejection carries one of those codes: either as the gateway code (0..7 with no nested TalkException) or as the nested
 * `rejectionReason` the 10052 envelope forwards in the error metadata.
 */
export function decodeChromeFriendAddRejection(error: unknown): RelationAddServerErrorCode | null {
  if (!(error instanceof ChromeApiError) || error instanceof ChromeTransportError) return null;
  if (error.path !== thriftPath('Relation.RelationService.addFriendByMid')) return null;
  const metadata = error.metadata;
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const reason = friendAddRejectionReason((metadata as Record<string, unknown>).rejectionReason);
    if (reason !== null) return reason;
  }
  if (error.innerCode === undefined) return friendAddResultCode(error.code);
  return null;
}
