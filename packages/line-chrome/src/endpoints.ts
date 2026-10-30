// Typed endpoint registry of the LINE Chrome gateway.
// Ported from OkLine okline/endpoints.py (THRIFT_ENDPOINTS :51-140, SPECIAL_ENDPOINTS :144-165, thrift_path :167-172)
// and okline/transport.py:114-131 (talk-auth scope).

import { GATEWAY_BASE_URL } from './constants.js';

/** Every Thrift-over-JSON endpoint, keyed `<Namespace>.<Service>.<method>`; the value is the path below `/api/`. */
export const THRIFT_ENDPOINTS = {
  'LoginQrCode.SecondaryQrCodeLoginService.createSession': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
  'LoginQrCode.SecondaryQrCodeLoginService.createQrCode': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode',
  'LoginQrCode.SecondaryQrCodeLoginService.verifyCertificate': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate',
  'LoginQrCode.SecondaryQrCodeLoginService.createPinCode': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode',
  'LoginQrCode.SecondaryQrCodeLoginService.qrCodeLoginV2': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkPinCodeVerified': 'talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified',
  'Talk.AuthService.loginV2': 'talk/thrift/Talk/AuthService/loginV2',
  'Talk.AuthService.logoutV2': 'talk/thrift/Talk/AuthService/logoutV2',
  'Talk.AuthService.confirmE2EELogin': 'talk/thrift/Talk/AuthService/confirmE2EELogin',
  'Talk.ChannelService.issueChannelToken': 'talk/thrift/Talk/ChannelService/issueChannelToken',
  'Talk.BuddyService.getBuddyDetail': 'talk/thrift/Talk/BuddyService/getBuddyDetail',
  'Relation.RelationService.addFriendByMid': 'talk/thrift/Relation/RelationService/addFriendByMid',
  'Relation.RelationService.getTargetProfileNotice': 'talk/thrift/Relation/RelationService/getTargetProfileNotice',
  'ShopService.ShopService.getOwnedProductSummaries': 'shop/thrift/ShopService/ShopService/getOwnedProductSummaries',
  'ShopService.ShopService.setCustomizedImageText': 'shop/thrift/ShopService/ShopService/setCustomizedImageText',
  'ShopService.ShopService.previewCustomizedImageText': 'shop/thrift/ShopService/ShopService/previewCustomizedImageText',
  'Talk.TalkService.getRSAKeyInfo': 'talk/thrift/Talk/TalkService/getRSAKeyInfo',
  'Talk.TalkService.getEncryptedIdentityV3': 'talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
  'Talk.TalkService.acquireEncryptedAccessToken': 'talk/thrift/Talk/TalkService/acquireEncryptedAccessToken',
  'Talk.TalkService.getProfile': 'talk/thrift/Talk/TalkService/getProfile',
  'Talk.TalkService.updateProfileAttributes': 'talk/thrift/Talk/TalkService/updateProfileAttributes',
  'Talk.TalkService.getSettings': 'talk/thrift/Talk/TalkService/getSettings',
  'Talk.TalkService.getSettingsAttributes2': 'talk/thrift/Talk/TalkService/getSettingsAttributes2',
  'Talk.TalkService.updateSettingsAttributes2': 'talk/thrift/Talk/TalkService/updateSettingsAttributes2',
  'Talk.TalkService.getConfigurations': 'talk/thrift/Talk/TalkService/getConfigurations',
  'Talk.TalkService.getServerTime': 'talk/thrift/Talk/TalkService/getServerTime',
  'Talk.TalkService.reportAbuseEx': 'talk/thrift/Talk/TalkService/reportAbuseEx',
  'Talk.TalkService.findAndAddContactsByMid': 'talk/thrift/Talk/TalkService/findAndAddContactsByMid',
  'Talk.TalkService.getAllContactIds': 'talk/thrift/Talk/TalkService/getAllContactIds',
  'Talk.TalkService.getContactsV2': 'talk/thrift/Talk/TalkService/getContactsV2',
  'Talk.TalkService.blockContact': 'talk/thrift/Talk/TalkService/blockContact',
  'Talk.TalkService.unblockContact': 'talk/thrift/Talk/TalkService/unblockContact',
  'Talk.TalkService.getBlockedContactIds': 'talk/thrift/Talk/TalkService/getBlockedContactIds',
  'Talk.TalkService.findContactsByPhone': 'talk/thrift/Talk/TalkService/findContactsByPhone',
  'Talk.TalkService.findContactByUserid': 'talk/thrift/Talk/TalkService/findContactByUserid',
  'Talk.TalkService.updateContactSetting': 'talk/thrift/Talk/TalkService/updateContactSetting',
  'Talk.TalkService.getFavoriteMids': 'talk/thrift/Talk/TalkService/getFavoriteMids',
  'Talk.TalkService.blockRecommendation': 'talk/thrift/Talk/TalkService/blockRecommendation',
  'Talk.TalkService.getRecommendationIds': 'talk/thrift/Talk/TalkService/getRecommendationIds',
  'Talk.TalkService.getBlockedRecommendationIds': 'talk/thrift/Talk/TalkService/getBlockedRecommendationIds',
  'Talk.TalkService.getLastOpRevision': 'talk/thrift/Talk/TalkService/getLastOpRevision',
  'Talk.TalkService.sendMessage': 'talk/thrift/Talk/TalkService/sendMessage',
  'Talk.TalkService.unsendMessage': 'talk/thrift/Talk/TalkService/unsendMessage',
  'Talk.TalkService.sendChatChecked': 'talk/thrift/Talk/TalkService/sendChatChecked',
  'Talk.TalkService.sendChatRemoved': 'talk/thrift/Talk/TalkService/sendChatRemoved',
  'Talk.TalkService.setChatHiddenStatus': 'talk/thrift/Talk/TalkService/setChatHiddenStatus',
  'Talk.TalkService.react': 'talk/thrift/Talk/TalkService/react',
  'Talk.TalkService.cancelReaction': 'talk/thrift/Talk/TalkService/cancelReaction',
  'Talk.TalkService.sendPostback': 'talk/thrift/Talk/TalkService/sendPostback',
  'Talk.TalkService.determineMediaMessageFlow': 'talk/thrift/Talk/TalkService/determineMediaMessageFlow',
  'Talk.TalkService.getMessageReadRange': 'talk/thrift/Talk/TalkService/getMessageReadRange',
  'Talk.TalkService.getMessageBoxesByIds': 'talk/thrift/Talk/TalkService/getMessageBoxesByIds',
  'Talk.TalkService.getMessagesByIds': 'talk/thrift/Talk/TalkService/getMessagesByIds',
  'Talk.TalkService.getMessageBoxes': 'talk/thrift/Talk/TalkService/getMessageBoxes',
  'Talk.TalkService.getPreviousMessagesV2WithRequest': 'talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
  'Talk.TalkService.getRecentMessagesV2': 'talk/thrift/Talk/TalkService/getRecentMessagesV2',
  'Talk.TalkService.inviteIntoRoom': 'talk/thrift/Talk/TalkService/inviteIntoRoom',
  'Talk.TalkService.leaveRoom': 'talk/thrift/Talk/TalkService/leaveRoom',
  'Talk.TalkService.getRoomsV2': 'talk/thrift/Talk/TalkService/getRoomsV2',
  'Talk.TalkService.createChat': 'talk/thrift/Talk/TalkService/createChat',
  'Talk.TalkService.updateChat': 'talk/thrift/Talk/TalkService/updateChat',
  'Talk.TalkService.inviteIntoChat': 'talk/thrift/Talk/TalkService/inviteIntoChat',
  'Talk.TalkService.deleteOtherFromChat': 'talk/thrift/Talk/TalkService/deleteOtherFromChat',
  'Talk.TalkService.cancelChatInvitation': 'talk/thrift/Talk/TalkService/cancelChatInvitation',
  'Talk.TalkService.deleteSelfFromChat': 'talk/thrift/Talk/TalkService/deleteSelfFromChat',
  'Talk.TalkService.rejectChatInvitation': 'talk/thrift/Talk/TalkService/rejectChatInvitation',
  'Talk.TalkService.acceptChatInvitation': 'talk/thrift/Talk/TalkService/acceptChatInvitation',
  'Talk.TalkService.getAllChatMids': 'talk/thrift/Talk/TalkService/getAllChatMids',
  'Talk.TalkService.getChats': 'talk/thrift/Talk/TalkService/getChats',
  'Talk.TalkService.getE2EEPublicKey': 'talk/thrift/Talk/TalkService/getE2EEPublicKey',
  'Talk.TalkService.negotiateE2EEPublicKey': 'talk/thrift/Talk/TalkService/negotiateE2EEPublicKey',
  'Talk.TalkService.getE2EEPublicKeysEx': 'talk/thrift/Talk/TalkService/getE2EEPublicKeysEx',
  'Talk.TalkService.registerE2EEGroupKey': 'talk/thrift/Talk/TalkService/registerE2EEGroupKey',
  'Talk.TalkService.getE2EEGroupSharedKey': 'talk/thrift/Talk/TalkService/getE2EEGroupSharedKey',
  'Talk.TalkService.getLastE2EEGroupSharedKey': 'talk/thrift/Talk/TalkService/getLastE2EEGroupSharedKey',
  'Talk.TalkService.getLastE2EEPublicKeys': 'talk/thrift/Talk/TalkService/getLastE2EEPublicKeys',
} as const;

export type ThriftEndpointKey = keyof typeof THRIFT_ENDPOINTS;

/** Non-Thrift REST helpers (OkLine endpoints.py:144-165). Paths are relative to the gateway base, no leading slash. */
export const SPECIAL_ENDPOINTS = {
  /** Server-Sent-Events stream of incoming operations (the modern fetchOps). */
  'operation.receive': 'api/operation/receive',
  /** Classic long-poll fallbacks. Not used by this port. */
  'longpoll.LF1': 'api/talk/long-polling/LF1',
  'longpoll.JQ': 'api/talk/long-polling/JQ',
  /** Token refresh; body `{"refreshToken": "..."}`. */
  'auth.tokenRefresh': 'api/auth/tokenRefresh',
  'lan.notice': 'api/lan/notice',
  'obs.uploadProfile': 'api/obs/uploadProfile',
  'obs.copyForMessage': 'api/obs/copyForMessage',
  'timeline.home': 'api/timeline/homeId',
  'timeline.getCover': 'api/timeline/getCover',
  'timeline.updateCover': 'api/timeline/updateCover',
  /** LEGY page-info helper (served from a LEGY host, not the gateway). */
  'legy.pageinfo': 'sc/api/v2/pageinfo/get',
} as const;

export type SpecialEndpointKey = keyof typeof SPECIAL_ENDPOINTS;

/** `/api/...` path for a `Namespace.Service.method` key (OkLine `thrift_path`). */
export function thriftPath(key: ThriftEndpointKey): string {
  const suffix = (THRIFT_ENDPOINTS as Record<string, string | undefined>)[key];
  if (suffix === undefined) throw new RangeError(`unknown thrift endpoint ${JSON.stringify(key)}`);
  return `/api/${suffix}`;
}

/** Path (with leading slash) of a special endpoint. */
export function specialPath(key: SpecialEndpointKey): string {
  return `/${SPECIAL_ENDPOINTS[key]}`;
}

export function isThriftEndpointKey(key: string): key is ThriftEndpointKey {
  return Object.prototype.hasOwnProperty.call(THRIFT_ENDPOINTS, key);
}

/** All fully-qualified endpoint keys, sorted (OkLine `all_method_names`). */
export function allEndpointKeys(): ThriftEndpointKey[] {
  return (Object.keys(THRIFT_ENDPOINTS) as ThriftEndpointKey[]).sort();
}

/**
 * Endpoints the Chrome transport is expected to call in later steps. `access` tells the caller of the gateway client
 * whether a call is a `read` (may retry) or a `write` (never retried), or `auth` for the unauthenticated login
 * bootstrap. Entries absent here are registered data only. Source: the design brief per-method table.
 */
export type EndpointAccess = 'read' | 'write' | 'auth';
export interface EndpointUsage {
  readonly access: EndpointAccess;
  readonly area: 'login' | 'session' | 'conversations' | 'messaging' | 'contacts' | 'e2ee' | 'media' | 'resource';
}

export const USED_ENDPOINTS: Readonly<Partial<Record<ThriftEndpointKey, EndpointUsage>>> = {
  'LoginQrCode.SecondaryQrCodeLoginService.createSession': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginService.createQrCode': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginService.verifyCertificate': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginService.createPinCode': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginService.qrCodeLoginV2': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified': { access: 'auth', area: 'login' },
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkPinCodeVerified': { access: 'auth', area: 'login' },
  'Talk.AuthService.logoutV2': { access: 'write', area: 'session' },
  'Talk.TalkService.getProfile': { access: 'read', area: 'session' },
  'Talk.TalkService.getLastOpRevision': { access: 'read', area: 'session' },
  'Talk.TalkService.getAllChatMids': { access: 'read', area: 'conversations' },
  'Talk.TalkService.getMessageBoxes': { access: 'read', area: 'conversations' },
  'Talk.TalkService.getChats': { access: 'read', area: 'conversations' },
  'Talk.TalkService.getContactsV2': { access: 'read', area: 'conversations' },
  'Talk.TalkService.getRecentMessagesV2': { access: 'read', area: 'messaging' },
  'Talk.TalkService.getPreviousMessagesV2WithRequest': { access: 'read', area: 'messaging' },
  'Talk.TalkService.sendMessage': { access: 'write', area: 'messaging' },
  'Talk.TalkService.unsendMessage': { access: 'write', area: 'messaging' },
  'Talk.TalkService.react': { access: 'write', area: 'messaging' },
  'Talk.TalkService.cancelReaction': { access: 'write', area: 'messaging' },
  // line-cli pkg/line/methods.go:786 (AcquireChannelAccessToken); the gate pins the body to the album channel id.
  'Talk.ChannelService.issueChannelToken': { access: 'read', area: 'resource' },
  'Talk.TalkService.acquireEncryptedAccessToken': { access: 'read', area: 'media' },
  'Talk.TalkService.determineMediaMessageFlow': { access: 'read', area: 'media' },
  'Talk.TalkService.getAllContactIds': { access: 'read', area: 'contacts' },
  'Talk.TalkService.getBlockedContactIds': { access: 'read', area: 'contacts' },
  'Relation.RelationService.addFriendByMid': { access: 'write', area: 'contacts' },
  'Talk.TalkService.getE2EEPublicKey': { access: 'read', area: 'e2ee' },
  'Talk.TalkService.negotiateE2EEPublicKey': { access: 'read', area: 'e2ee' },
  'Talk.TalkService.getLastE2EEPublicKeys': { access: 'read', area: 'e2ee' },
  'Talk.TalkService.registerE2EEGroupKey': { access: 'write', area: 'e2ee' },
  'Talk.TalkService.getE2EEGroupSharedKey': { access: 'read', area: 'e2ee' },
  'Talk.TalkService.getLastE2EEGroupSharedKey': { access: 'read', area: 'e2ee' },
};

const TALK_AUTH_SCOPE_PREFIX = '/api/talk/thrift/Talk';
const TALK_AUTH_EXCLUDED_PREFIXES = [
  '/api/talk/thrift/Talk/ChannelService',
  '/api/talk/thrift/Talk/E2EEKeyBackupService',
] as const;

/**
 * True when `path` is inside the extension's talk-auth interceptor scope: `startsWith("/api/talk/thrift/Talk")` minus
 * the `Talk/ChannelService` and `Talk/E2EEKeyBackupService` sub-services (OkLine transport.py:114-131). Chat, Relation,
 * Buddy and LoginQrCode namespaces do not match the prefix.
 */
export function isTalkAuthScoped(path: string): boolean {
  return path.startsWith(TALK_AUTH_SCOPE_PREFIX) && !TALK_AUTH_EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}

/** Full URL of a gateway path. */
export function gatewayUrl(path: string, base: string = GATEWAY_BASE_URL): string {
  return base + path;
}
