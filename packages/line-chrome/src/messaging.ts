// Request builders for the CHROMEOS write path. Pure functions: they return the exact JSON the gateway receives, so the
// adapter and the tests share one definition of every wire shape.
// Ported from OkLine okline/models.py (Message.text :64-121, media builders :237-372, mid_to_type :29-43),
// okline/services/messaging.py (react / cancel_reaction / unsend_message :102-159) and okline/services/contacts.py
// (add_friend_by_mid :158-189).

import { CONTENT_TYPE } from './e2ee/manager.js';
import type { ChromeMessage } from './e2ee/framing.js';

/** OkLine `MIDType`. */
export const MID_TYPE = { USER: 0, ROOM: 1, GROUP: 2, SQUARE: 3, SQUARE_CHAT: 4 } as const;
/** OkLine `MessageRelationType.REPLY`. */
export const MESSAGE_RELATION_REPLY = 3;
/** The extension's `relatedMessageServiceCode` for a Talk reply. */
export const RELATED_MESSAGE_SERVICE_CODE = 1;

/** OkLine `mid_to_type` (models.py:29-43): the mid prefix decides, case-insensitively; unknown prefixes are USER. */
export function midToType(mid: string): number {
  switch (mid.slice(0, 1).toLowerCase()) {
    case 'c': return MID_TYPE.GROUP;
    case 'r': return MID_TYPE.ROOM;
    case 's': return MID_TYPE.SQUARE_CHAT;
    default: return MID_TYPE.USER;
  }
}

export interface TextMessageInput {
  to: string;
  text: string;
  /** `contentMetadata.MENTION` (already serialised by the caller's mention builder). */
  mention?: string;
  /** Decimal message id this text replies to. */
  replyToMessageId?: string | null;
}

/**
 * OkLine `Message.text` (models.py:64-121, the bundle's `aP`): `from`/`id`/`createdTime` stay omitted (the gateway tolerates
 * it), `hasContent:false` is explicit, and reply fields are added only for a reply.
 */
export function buildTextMessage(input: TextMessageInput): ChromeMessage {
  const message: ChromeMessage = {
    to: input.to,
    toType: midToType(input.to),
    contentMetadata: input.mention === undefined ? {} : { MENTION: input.mention },
    sessionId: 0,
    text: input.text,
    contentType: CONTENT_TYPE.NONE,
    hasContent: false,
  };
  if (input.replyToMessageId !== undefined && input.replyToMessageId !== null) {
    message.relatedMessageId = input.replyToMessageId;
    message.messageRelationType = MESSAGE_RELATION_REPLY;
    message.relatedMessageServiceCode = RELATED_MESSAGE_SERVICE_CODE;
  }
  return message;
}

export interface MediaMessageInput {
  to: string;
  kind: 'image' | 'file';
  /** OBS object id returned by the upload (`x-obs-oid`). */
  oid: string;
  /** `emi` for images, `emf` for files. */
  sid: 'emi' | 'emf';
  /** Size of the PLAINTEXT media (line-cli internal/messaging/files.go:135-153). It is sealed inside the message. */
  fileSize: number;
  /** base64 of the 32-byte file key material; sealed into the ciphertext, so it never travels in clear. */
  encKm: string;
  fileName: string;
}

/**
 * Sealed media placeholder (OkLine `Message.image` / `Message.file`, models.py:258-372, with the `SID/OID/FILE_SIZE` keys the
 * extension adds for the E2EE flow). `ENC_KM` and `FILE_NAME` are removed from the clear metadata by `ChromeE2ee.encrypt`
 * and sealed inside the chunks instead (framing.ts `buildE2eeMessage`).
 */
export function buildMediaMessage(input: MediaMessageInput): ChromeMessage {
  const contentMetadata: Record<string, string> = {
    SID: input.sid,
    OID: input.oid,
    FILE_SIZE: String(input.fileSize),
    ENC_KM: input.encKm,
    FILE_NAME: input.fileName,
  };
  // No MEDIA_CONTENT_INFO: the referenced sealed message carries SID, OID, FILE_SIZE, ENC_KM and FILE_NAME only.
  return {
    to: input.to,
    toType: midToType(input.to),
    contentMetadata,
    sessionId: 0,
    text: '',
    contentType: input.kind === 'image' ? CONTENT_TYPE.IMAGE : CONTENT_TYPE.FILE,
    hasContent: true,
  };
}

/** Our reaction contract values mapped onto OkLine `PredefinedReactionType`. UNDO is `cancelReaction`, not a type. */
export const PREDEFINED_REACTION_TYPE = { NICE: 2, LOVE: 3, FUN: 4, AMAZING: 5, SAD: 6, OMG: 7 } as const;
export type ReactionName = keyof typeof PREDEFINED_REACTION_TYPE;

/** OkLine `react`: `react [{reqSeq, messageId, reactionType:{predefinedReactionType}}]`. */
export function buildReactRequest(reqSeq: number, messageId: string, reaction: ReactionName): Record<string, unknown> {
  return { reqSeq, messageId, reactionType: { predefinedReactionType: PREDEFINED_REACTION_TYPE[reaction] } };
}

/** OkLine `cancel_reaction`: `cancelReaction [{reqSeq, messageId}]`. */
export function buildCancelReactionRequest(reqSeq: number, messageId: string): Record<string, unknown> {
  return { reqSeq, messageId };
}

/** OkLine `add_friend_by_mid` (contacts.py:158-189): tracking is the chat the user came from, else a friend recommendation. */
export function buildAddFriendRequest(reqSeq: number, userMid: string, sourceChatMid?: string): Record<string, unknown> {
  const trackingMetaV2 = sourceChatMid ? { chat: { chatMid: sourceChatMid } } : { friendRecommendation: {} };
  return { reqSeq, userMid, tracking: { reference: '', trackingMetaV2 } };
}
