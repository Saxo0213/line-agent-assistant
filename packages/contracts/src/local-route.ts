import type { ConversationKey } from './account.js';

export const LOCAL_AGENT_ROOM_CHAT_ID = '__local_agent_room__';
export const LOCAL_AGENT_ROOM_TITLE = 'Agent 室';

/**
 * Stable key of the one shared Agent room. The room belongs to the operator, not to any LINE account:
 * the renderer uses it as the room identity (selection, per-room provider memory) and Main uses it for
 * UI jobs, which are stored with no account.
 */
export const AGENT_ROOM_ID = 'agent-room';

/** Account-less queue/session key of the shared Agent room (UI jobs and UI sessions). */
export interface AgentRoomKey { accountId: null; chatType: null; chatId: null }
export const AGENT_ROOM_KEY: Readonly<AgentRoomKey> = Object.freeze({ accountId: null, chatType: null, chatId: null });

export function isAgentRoomKey(key: { accountId: string | null }): key is AgentRoomKey {
  return key.accountId === null;
}

export function localAgentRoomKey(accountId: string): ConversationKey {
  return { accountId, chatType: 'direct', chatId: LOCAL_AGENT_ROOM_CHAT_ID };
}

export function isLocalOnlyConversation(key: Pick<ConversationKey, 'chatType' | 'chatId'>): boolean {
  return key.chatType === 'direct' && key.chatId === LOCAL_AGENT_ROOM_CHAT_ID;
}

export const isLocalAgentRoom = isLocalOnlyConversation;
