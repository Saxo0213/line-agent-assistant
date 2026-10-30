import { SendDetailSchema } from './diagnostics.js';

/** Fixed TalkException projections shared by the adapter, worker, and desktop. */
export const TALK_SERVER_ERRORS = {
  ILLEGAL_ARGUMENT: [0, 'LINE 請求參數無效。'],
  AUTHENTICATION_FAILED: [1, 'LINE 驗證失敗，請重新登入。'],
  EXCESSIVE_ACCESS: [4, 'LINE 暫時限制此請求。'],
  NOT_FOUND: [5, 'LINE 找不到指定資料。'],
  INVALID_LENGTH: [6, 'LINE 請求數量超過限制。'],
  NOT_AVAILABLE_USER: [7, 'LINE 帳號目前無法使用。'],
  NOT_AUTHORIZED_DEVICE: [8, 'LINE 裝置驗證已失效，請重新登入。'],
  INVALID_MID: [9, 'LINE 使用者識別碼無效。'],
  NOT_A_MEMBER: [10, 'LINE 帳號不是此聊天室成員。'],
  NO_SUCH_MESSAGE_BOX: [25, 'LINE 找不到此聊天室。'],
  NOT_AVAILABLE_MESSAGE_BOX: [26, 'LINE 聊天室目前無法使用。'],
  NOT_YOUR_MESSAGE: [28, '只能收回自己傳送的 LINE 訊息。'],
  ABUSE_BLOCK: [35, 'LINE 已限制此操作。'],
  NOT_FRIEND: [36, '對方目前不是 LINE 好友。'],
  NOT_ALLOWED_ADD_CONTACT: [42, 'LINE 不允許新增此聯絡人。'],
  EXCEED_FILE_MAX_SIZE: [47, '檔案超過 LINE 大小限制。'],
  EXCEED_DAILY_QUOTA: [48, '已達 LINE 每日使用額度。'],
  NOT_SUPPORT_SEND_FILE: [49, 'LINE 不支援傳送此檔案。'],
  EXPIRED_REVISION: [52, 'LINE 同步位置已過期。'],
  MESSAGE_NOT_FOUND: [64, 'LINE 找不到此訊息。'],
  FEATURE_RESTRICTED: [70, 'LINE 已限制此功能。'],
  MESSAGE_NOT_DESTRUCTIBLE: [71, '此 LINE 訊息無法收回。'],
  E2EE_INVALID_PROTOCOL: [81, 'LINE 加密協定不相容。'],
  E2EE_RETRY_ENCRYPT: [82, 'LINE 要求以加密方式傳送。'],
  E2EE_UPDATE_SENDER_KEY: [83, 'LINE 傳送端加密金鑰需要更新。'],
  E2EE_UPDATE_RECEIVER_KEY: [84, 'LINE 接收端加密金鑰需要更新。'],
  E2EE_INVALID_ARGUMENT: [85, 'LINE 加密資料無效。'],
  E2EE_INVALID_VERSION: [86, 'LINE 加密版本不相容。'],
  E2EE_SENDER_DISABLED: [87, 'LINE 傳送端加密功能未啟用。'],
  E2EE_RECEIVER_DISABLED: [88, 'LINE 接收端加密功能未啟用。'],
  E2EE_SENDER_NOT_ALLOWED: [89, 'LINE 不允許傳送端使用加密功能。'],
  E2EE_RECEIVER_NOT_ALLOWED: [90, 'LINE 不允許接收端使用加密功能。'],
  E2EE_RESEND_FAIL: [91, 'LINE 加密訊息重新傳送失敗。'],
  E2EE_RESEND_OK: [92, 'LINE 已完成加密訊息重新傳送。'],
  E2EE_UPDATE_PRIMARY_DEVICE: [94, 'LINE 主要裝置的加密金鑰需要更新。'],
  E2EE_PRIMARY_NOT_SUPPORT: [97, 'LINE 主要裝置不支援此加密功能。'],
  E2EE_RETRY_PLAIN: [98, 'LINE 要求以未加密方式重試。'],
  E2EE_RECREATE_GROUP_KEY: [99, 'LINE 群組加密金鑰需要重建。'],
  E2EE_GROUP_TOO_MANY_MEMBERS: [100, 'LINE 群組人數超過加密功能限制。'],
  SERVER_BUSY: [101, 'LINE 伺服器忙碌，請稍後再試。'],
  INCOMING_FRIEND_REQUEST_LIMIT: [103, 'LINE 收到的好友邀請已達上限。'],
  OUTGOING_FRIEND_REQUEST_LIMIT: [104, 'LINE 發出的好友邀請已達上限。'],
  OUTGOING_FRIEND_REQUEST_QUOTA: [105, 'LINE 好友邀請額度已用完。'],
  DUPLICATED: [106, 'LINE 已有相同請求。'],
  SHOULD_RETRY: [115, 'LINE 要求稍後再試。'],
  MUST_REFRESH_V3_TOKEN: [119, 'LINE 登入憑證需要更新。'],
  REFRESH_MEDIA_FLOW: [122, 'LINE 媒體傳送方式需要更新。'],
  DB_FAILED: [2, 'LINE 資料服務發生錯誤。'],
  INVALID_STATE: [3, 'LINE 目前狀態不允許此操作。'],
  INCOMPATIBLE_APP_VERSION: [11, 'LINE 應用程式版本不相容。'],
  NOT_READY: [12, 'LINE 服務尚未準備完成。'],
  NOT_AVAILABLE_SESSION: [13, 'LINE 工作階段無法使用。'],
  NOT_AUTHORIZED_SESSION: [14, 'LINE 工作階段未獲授權。'],
  SYSTEM_ERROR: [15, 'LINE 系統發生錯誤。'],
  NO_AVAILABLE_VERIFICATION_METHOD: [16, 'LINE 沒有可用的驗證方式。'],
  NOT_AUTHENTICATED: [17, 'LINE 尚未完成身分驗證。'],
  INVALID_IDENTITY_CREDENTIAL: [18, 'LINE 身分憑證無效。'],
  NOT_AVAILABLE_IDENTITY_IDENTIFIER: [19, 'LINE 身分識別資料無法使用。'],
  INTERNAL_ERROR: [20, 'LINE 發生內部錯誤。'],
  NO_SUCH_IDENTITY_IDENFIER: [21, 'LINE 找不到此身分識別資料。'],
  DEACTIVATED_ACCOUNT_BOUND_TO_THIS_IDENTITY: [22, '此身分綁定的 LINE 帳號已停用。'],
  ILLEGAL_IDENTITY_CREDENTIAL: [23, 'LINE 身分憑證格式不合法。'],
  UNKNOWN_CHANNEL: [24, 'LINE 找不到此頻道。'],
  CHANNEL_DOES_NOT_MATCH: [27, 'LINE 頻道與請求不相符。'],
  MESSAGE_DEFINED_ERROR: [29, 'LINE 訊息處理失敗。'],
  USER_CANNOT_ACCEPT_PRESENTS: [30, '此 LINE 使用者無法接收贈禮。'],
  USER_NOT_STICKER_OWNER: [32, '此 LINE 使用者沒有該貼圖的使用權。'],
  MAINTENANCE_ERROR: [33, 'LINE 服務正在維護。'],
  ACCOUNT_NOT_MATCHED: [34, 'LINE 帳號與請求不相符。'],
  NOT_ALLOWED_CALL: [37, 'LINE 不允許此通話。'],
  BLOCK_FRIEND: [38, 'LINE 好友已被封鎖。'],
  INCOMPATIBLE_VOIP_VERSION: [39, 'LINE 通話版本不相容。'],
  INVALID_SNS_ACCESS_TOKEN: [40, 'LINE 社群服務憑證無效。'],
  EXTERNAL_SERVICE_NOT_AVAILABLE: [41, 'LINE 外部服務無法使用。'],
  NOT_CERTIFICATED: [43, 'LINE 裝置尚未通過認證。'],
  NOT_ALLOWED_SECONDARY_DEVICE: [44, 'LINE 不允許此裝置作為次要裝置。'],
  INVALID_PIN_CODE: [45, 'LINE 驗證碼無效。'],
  MUST_UPGRADE: [50, 'LINE 要求升級應用程式。'],
  NOT_AVAILABLE_PIN_CODE_SESSION: [51, 'LINE 驗證碼工作階段無法使用。'],
  NOT_YET_PHONE_NUMBER: [54, 'LINE 帳號尚未設定電話號碼。'],
  BAD_CALL_NUMBER: [55, 'LINE 通話號碼無效。'],
  UNAVAILABLE_CALL_NUMBER: [56, 'LINE 通話號碼無法使用。'],
  NOT_SUPPORT_CALL_SERVICE: [57, 'LINE 不支援此通話服務。'],
  CONGESTION_CONTROL: [58, 'LINE 暫時限制流量。'],
  NO_BALANCE: [59, 'LINE 帳戶餘額不足。'],
  NOT_PERMITTED_CALLER_ID: [60, 'LINE 不允許此來電號碼。'],
  NO_CALLER_ID_LIMIT_EXCEEDED: [61, 'LINE 無來電號碼通話已達上限。'],
  CALLER_ID_VERIFICATION_REQUIRED: [62, 'LINE 要求驗證來電號碼。'],
  NO_CALLER_ID_LIMIT_EXCEEDED_AND_VERIFICATION_REQUIRED: [63, 'LINE 無來電號碼通話已達上限，並要求驗證來電號碼。'],
  INVALID_ACCOUNT_MIGRATION_PINCODE_FORMAT: [65, 'LINE 帳號移轉驗證碼格式無效。'],
  ACCOUNT_MIGRATION_PINCODE_NOT_MATCHED: [66, 'LINE 帳號移轉驗證碼不相符。'],
  ACCOUNT_MIGRATION_PINCODE_BLOCKED: [67, 'LINE 帳號移轉驗證碼已被封鎖。'],
  INVALID_PASSWORD_FORMAT: [69, 'LINE 密碼格式無效。'],
  PAID_CALL_REDEEM_FAILED: [72, 'LINE 付費通話兌換失敗。'],
  PREVENTED_JOIN_BY_TICKET: [73, 'LINE 不允許使用邀請票券加入群組。'],
  SEND_MESSAGE_NOT_PERMITTED_FROM_LINE_AT: [75, 'LINE 不允許此官方帳號傳送訊息。'],
  SEND_MESSAGE_NOT_PERMITTED_WHILE_AUTO_REPLY: [76, 'LINE 自動回覆啟用時不允許傳送訊息。'],
  SECURITY_CENTER_NOT_VERIFIED: [77, 'LINE 安全中心尚未完成驗證。'],
  SECURITY_CENTER_BLOCKED_BY_SETTING: [78, 'LINE 安全設定封鎖了此操作。'],
  SECURITY_CENTER_BLOCKED: [79, 'LINE 安全中心封鎖了此操作。'],
  TALK_PROXY_EXCEPTION: [80, 'LINE 聊天服務代理發生錯誤。'],
  HITOKOTO_BACKUP_NO_AVAILABLE_DATA: [93, 'LINE 找不到可用的聊天備份資料。'],
  SUCCESS: [95, 'LINE 回傳了成功狀態碼。'],
  CANCEL: [96, 'LINE 已取消此操作。'],
  NOT_ALLOWED_ADD_FOLLOW: [102, 'LINE 不允許新增追蹤。'],
  BANNED: [107, 'LINE 已封鎖此帳號或操作。'],
  NOT_AN_INVITEE: [108, '此 LINE 帳號不在邀請名單中。'],
  NOT_AN_OUTSIDER: [109, '此 LINE 帳號已是聊天室成員。'],
  EMPTY_GROUP: [111, 'LINE 群組沒有成員。'],
  EXCEED_FOLLOW_LIMIT: [112, 'LINE 追蹤人數已達上限。'],
  UNSUPPORTED_ACCOUNT_TYPE: [113, 'LINE 不支援此帳號類型。'],
  AGREEMENT_REQUIRED: [114, 'LINE 要求先同意服務條款。'],
  OVER_MAX_CHATS_PER_USER: [116, '此 LINE 帳號的聊天室數量已達上限。'],
  NOT_AVAILABLE_API: [117, '此 LINE 介面目前無法使用。'],
  INVALID_OTP: [118, 'LINE 一次性驗證碼無效。'],
  ALREADY_EXPIRED: [120, '此 LINE 項目已過期。'],
  USER_NOT_STICON_OWNER: [121, '此 LINE 使用者沒有該表情貼的使用權。'],
  EXCEED_FOLLOWER_LIMIT: [123, 'LINE 追蹤者人數已達上限。'],
  INCOMPATIBLE_APP_TYPE: [124, 'LINE 應用程式類型不相容。'],
  NOT_PREMIUM: [125, '此 LINE 帳號沒有進階功能資格。'],
  BITMAX_ACCOUNT_EXIST: [126, '此 LINE 帳號已綁定 BITMAX 帳戶。'],
} as const satisfies Record<string, readonly [number, string]>;

export type TalkServerErrorName = keyof typeof TALK_SERVER_ERRORS;
export type TalkServerErrorCode = `LINE_TALK_${TalkServerErrorName}`;

/** RelationService.addFriendByMid uses AddFriendResult, not TalkException. */
export const RELATION_ADD_SERVER_ERRORS = {
  UNKNOWN: [0, 'LINE 無法判定新增好友的拒絕原因。'],
  INVALID_TARGET_USER: [1, 'LINE 找不到可新增的目標使用者。'],
  AGE_VALIDATION: [2, 'LINE 要求完成年齡驗證後才能新增好友。'],
  TOO_MANY_FRIENDS: [3, 'LINE 好友人數已達上限。'],
  TOO_MANY_REQUESTS: [4, 'LINE 暫時限制新增好友請求。'],
  MALFORMED_REQUEST: [5, 'LINE 新增好友請求格式無效。'],
  TRACKING_META_QRCODE_FAVORED: [6, 'LINE 要求改用 QR 碼新增好友。'],
  TRACKING_META_UPGRADE_FAVORED: [7, 'LINE 要求更新後再新增好友。'],
} as const satisfies Record<string, readonly [number, string]>;
export type RelationAddServerErrorName = keyof typeof RELATION_ADD_SERVER_ERRORS;
export type RelationAddServerErrorCode = `LINE_RELATION_ADD_${RelationAddServerErrorName}`;
export type LineServerErrorCode = TalkServerErrorCode | RelationAddServerErrorCode;

export const LINE_SERVER_ERROR_CODES: readonly LineServerErrorCode[] = [
  ...Object.keys(TALK_SERVER_ERRORS).map((name) => `LINE_TALK_${name}` as TalkServerErrorCode),
  ...Object.keys(RELATION_ADD_SERVER_ERRORS).map((name) => `LINE_RELATION_ADD_${name}` as RelationAddServerErrorCode),
];

export function talkServerError(name: unknown): Readonly<{ code: TalkServerErrorCode; upstreamCode: number; message: string }> | null {
  if (typeof name !== 'string' || !Object.hasOwn(TALK_SERVER_ERRORS, name)) return null;
  const [upstreamCode, description] = TALK_SERVER_ERRORS[name as TalkServerErrorName];
  const code = `LINE_TALK_${name as TalkServerErrorName}` as const;
  return { code, upstreamCode, message: `${code}：${description}` };
}

export function relationAddServerError(name: unknown): Readonly<{ code: RelationAddServerErrorCode; upstreamCode: number; message: string }> | null {
  if (typeof name !== 'string' || !Object.hasOwn(RELATION_ADD_SERVER_ERRORS, name)) return null;
  const [upstreamCode, description] = RELATION_ADD_SERVER_ERRORS[name as RelationAddServerErrorName];
  const code = `LINE_RELATION_ADD_${name as RelationAddServerErrorName}` as const;
  return { code, upstreamCode, message: `${code}：${description}` };
}

export function lineServerErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  if (code.startsWith('LINE_TALK_')) return talkServerError(code.slice('LINE_TALK_'.length))?.message ?? null;
  if (code.startsWith('LINE_RELATION_ADD_')) return relationAddServerError(code.slice('LINE_RELATION_ADD_'.length))?.message ?? null;
  return null;
}

export function isLineServerErrorCode(code: unknown): code is LineServerErrorCode {
  return lineServerErrorMessage(code) !== null;
}

const LOCAL_RESULT_FAILURES = ['SIDE_EFFECT_DENIED', 'LOCAL_ROUTE_DENIED', 'FILE_CHANGED', 'FILE_UNREADABLE', 'UPLOAD_FAILED'] as const;

/** Keep only stable machine codes when projecting a worker failure into UI text. */
export function lineResultErrorMessage(code: unknown, fallback: string, detail?: unknown): string {
  if (typeof code !== 'string' || !LOCAL_RESULT_FAILURES.includes(code as typeof LOCAL_RESULT_FAILURES[number])) return fallback;
  // The optional detail is the bounded worker detail (for example the media upload stage); it is appended only when it is safe.
  return typeof detail === 'string' && SendDetailSchema.safeParse(detail).success ? `${code}:${detail}` : code;
}
