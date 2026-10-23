import { describe, expect, it } from 'vitest';
import { LOCAL_AGENT_ROOM_CHAT_ID, localAgentRoomKey, isLocalOnlyConversation } from './local-route.js';

describe('reserved local Agent room route', () => {
  it('creates and recognizes a route that can never be a LINE destination', () => {
    expect(localAgentRoomKey('account-a')).toEqual({
      accountId: 'account-a', chatType: 'direct', chatId: LOCAL_AGENT_ROOM_CHAT_ID,
    });
    expect(isLocalOnlyConversation(localAgentRoomKey('account-a'))).toBe(true);
    expect(isLocalOnlyConversation({ accountId: 'account-a', chatType: 'direct', chatId: 'u-real' })).toBe(false);
  });
});
