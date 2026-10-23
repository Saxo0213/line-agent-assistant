import { isWritableChatType, type ConversationKey, type WritableConversationKey } from '@line-agent/contracts';

/** Return the same native route only when the transport supports write operations for it. */
export function toWritableConversationKey(key: ConversationKey): WritableConversationKey | null {
  if (!isWritableChatType(key.chatType)) return null;
  return { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId };
}
