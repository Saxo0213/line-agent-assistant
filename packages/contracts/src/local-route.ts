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

/**
 * Account-less queue key of scheduled Agent runs (migration 072, source_type 'schedule'). It is NOT the Agent room: schedule jobs
 * never share the room's queue, concurrency slot or provider session. The key exists only in memory; job rows store NULL columns.
 */
export interface AgentScheduleQueueKey { accountId: null; chatType: 'schedule'; chatId: null }
export const AGENT_SCHEDULE_QUEUE_KEY: Readonly<AgentScheduleQueueKey> = Object.freeze({ accountId: null, chatType: 'schedule', chatId: null });

export function isAgentScheduleQueueKey(key: { accountId: string | null; chatType?: string | null }): key is AgentScheduleQueueKey {
  return key.accountId === null && key.chatType === 'schedule';
}

export function isAgentRoomKey(key: { accountId: string | null; chatType?: string | null }): key is AgentRoomKey {
  return key.accountId === null && key.chatType !== 'schedule';
}

export function localAgentRoomKey(accountId: string): ConversationKey {
  return { accountId, chatType: 'direct', chatId: LOCAL_AGENT_ROOM_CHAT_ID };
}

export function isLocalOnlyConversation(key: Pick<ConversationKey, 'chatType' | 'chatId'>): boolean {
  return key.chatType === 'direct' && key.chatId === LOCAL_AGENT_ROOM_CHAT_ID;
}

export const isLocalAgentRoom = isLocalOnlyConversation;
