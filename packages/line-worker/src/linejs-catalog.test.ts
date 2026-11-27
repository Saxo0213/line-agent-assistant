import { expect, it, vi } from 'vitest';
import { decryptLinejsHistoryMessages, fetchLinejsConversationCatalog, fetchLinejsConversationDetails, normalizeLinePicturePath } from './linejs-catalog.js';

it('mirrors LINEJS fetchJoinedChats and resolves direct and group member display names in bounded batches', async () => {
  const calls: Array<{ method: string; mids: string[] }> = [];
  let joinedOptions: unknown;
  const memberChatMids = Array.from({ length: 101 }, (_, index) => `c-group-${index}`);
  const chats = memberChatMids.map((chatMid) => ({
    chatMid,
    chatName: `Group ${chatMid.slice(8)}`,
    extra: { groupExtra: { memberMids: { 'u-self': 0, [`u-member-${chatMid.slice(8)}`]: 0 } } },
  }));
  const catalog = await fetchLinejsConversationCatalog({
    ownMid: 'u-self',
    getAllChatMids: async (...args: unknown[]) => { [joinedOptions] = args; return { memberChatMids }; },
    getMessageBoxes: async () => ({ messageBoxes: [{ id: 'u-peer' }, { id: 'c-group-0' }] }),
    getChats: async ({ chatMids }) => {
      calls.push({ method: 'getChats', mids: chatMids });
      return { chats: chats.filter((chat) => chatMids.includes(chat.chatMid)) };
    },
    getContactsV2: async ({ mids }) => {
      calls.push({ method: 'getContactsV2', mids });
      return { contacts: Object.fromEntries(mids.map((mid) => [mid, {
        contact: { displayName: mid === 'u-self' ? 'Agent' : 'Alice' },
      }])) };
    },
  }, async (call) => await call());
  expect(joinedOptions).toEqual({ request: { withMemberChats: true }, syncReason: 'INTERNAL' });
  expect(calls.filter((call) => call.method === 'getChats').map((call) => call.mids.length)).toEqual([100, 1]);
  expect(calls.filter((call) => call.method === 'getContactsV2').map((call) => call.mids.length)).toEqual([100, 3]);
  expect(catalog[0]).toEqual({ chatType: 'direct', chatId: 'u-peer', title: 'Alice',
    members: [{ memberId: 'u-peer', displayName: 'Alice' }] });
  expect(catalog[1]).toEqual({ chatType: 'group', chatId: 'c-group-0', title: 'Group 0', members: [
    { memberId: 'u-member-0', displayName: 'Alice' }, { memberId: 'u-self', displayName: 'Agent' },
  ] });
});

it('carries the owner-set contact name (displayNameOverridden) from the existing contact response and titles direct chats with it', async () => {
  const catalog = await fetchLinejsConversationCatalog({
    ownMid: 'u-self',
    getAllChatMids: async () => ({ memberChatMids: ['c-group'] }),
    getMessageBoxes: async () => ({ messageBoxes: [{ id: 'u-friend' }, { id: 'u-plain' }, { id: 'c-group' }] }),
    getChats: async () => ({ chats: [{ chatMid: 'c-group', chatName: 'Team',
      extra: { groupExtra: { memberMids: { 'u-friend': 0, 'u-stranger': 0 } } } }] }),
    getContactsV2: async ({ mids }) => ({ contacts: Object.fromEntries(mids.map((mid) => [mid, { contact: {
      displayName: `Profile ${mid}`,
      ...(mid === 'u-friend' ? { displayNameOverridden: '張襄君' } : mid === 'u-stranger' ? { displayNameOverridden: '' } : {}),
    } }])) }),
  }, async (call) => await call());
  expect(catalog.find((item) => item.chatId === 'u-friend')).toEqual({ chatType: 'direct', chatId: 'u-friend', title: '張襄君',
    members: [{ memberId: 'u-friend', displayName: 'Profile u-friend', nickname: '張襄君' }] });
  // No override in the response: the profile name titles the chat and no nickname is claimed.
  expect(catalog.find((item) => item.chatId === 'u-plain')).toEqual({ chatType: 'direct', chatId: 'u-plain', title: 'Profile u-plain',
    members: [{ memberId: 'u-plain', displayName: 'Profile u-plain' }] });
  expect(catalog.find((item) => item.chatId === 'c-group')?.members).toEqual([
    { memberId: 'u-friend', displayName: 'Profile u-friend', nickname: '張襄君' },
    { memberId: 'u-stranger', displayName: 'Profile u-stranger', nickname: '' },
  ]);
});

it('normalizes LINE picture paths with unknown, explicit-empty, allowlisted, and rejected states', () => {
  const normalize = normalizeLinePicturePath;

  expect(normalize(undefined, false)).toBeUndefined();
  expect(normalize(null, true)).toBeNull();
  expect(normalize('', true)).toBeNull();
  expect(normalize('https://profile.line-scdn.net/p.png', true)).toBe('https://profile.line-scdn.net/p.png');
  expect(normalize('https://obs.line-apps.com/p.png', true)).toBe('https://obs.line-apps.com/p.png');
  for (const length of [79, 166]) {
    const segment = 'a'.repeat(length - 1) + 'Z';
    expect(normalize(`/${segment}`, true)).toBe(`https://profile.line-scdn.net/${segment}`);
  }
  expect(normalize("/a~b!$&'()*+,;=:@-._Z", true)).toBe("https://profile.line-scdn.net/a~b!$&'()*+,;=:@-._Z");
  expect(normalize('/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', true)).toBe('https://profile.line-scdn.net/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  for (const invalid of [
    'http://profile.line-scdn.net/p.png', 'https://attacker.example/p.png',
    'https://user:pass@profile.line-scdn.net/p.png', 'https://profile.line-scdn.net/p.png#fragment',
    'file:///secret.png', 'https://profile.line-scdn.net/' + 'a'.repeat(2049), 42,
    '//attacker.example/p.png', '/one?x=1', '/one#fragment', '/.', '/..', '/one/../two', '/one/./two', '/one/',
    '/%2fhost', '/%5cpath', '/%2e%2e/secret', '/one%2f..%2fsecret', '/%2e', '/one%252e', '/one\\two',
    '/one\u0000two', '/one\ntwo', '/one two', '/é', '/one%20two', '//', '/one//two', 'one', './one', '../one',
  ]) expect(normalize(invalid, true)).toBeUndefined();
});

it('decrypts E2EE history messages using the same marker as LINEJS TalkMessage.fromRawTalk', async () => {
  const decrypt = vi.fn(async (message: unknown) => ({ ...(message as object), text: 'decrypted' }));
  const plain = { id: '1', text: 'plain', contentMetadata: {} };
  const encrypted = { id: '2', text: '', contentMetadata: { e2eeVersion: '2' } };

  const result = await decryptLinejsHistoryMessages([plain, encrypted], decrypt);

  expect(decrypt).toHaveBeenCalledExactlyOnceWith(encrypted);
  expect(result).toEqual([plain, { ...encrypted, text: 'decrypted' }]);
});

it('reads conversation details with getChats then getContactsV2 in chunks of 100 and maps items like the catalog', async () => {
  const calls: Array<{ method: string; mids: string[] }> = [];
  const ids = Array.from({ length: 101 }, (_, index) => `c-new-${index}`);
  const talk = {
    getChats: async ({ chatMids }: { chatMids: string[] }) => {
      calls.push({ method: 'getChats', mids: chatMids });
      return { chats: chatMids.filter((id) => id !== 'c-new-5').map((chatMid) => ({ chatMid, chatName: `Name ${chatMid}`, picturePath: '/0hGroup',
        extra: { groupExtra: { memberMids: { 'u-self': 0, [`u-${chatMid}`]: 0 } } } })) };
    },
    getContactsV2: async ({ mids }: { mids: string[] }) => {
      calls.push({ method: 'getContactsV2', mids });
      return { contacts: Object.fromEntries(mids.map((mid) => [mid, { contact: { displayName: `D ${mid}`,
        ...(mid === 'u-self' ? { displayNameOverridden: 'Me' } : {}) } }])) };
    },
  };
  const details = await fetchLinejsConversationDetails(talk, async (call) => await call(), [...ids, 'r-room', 'u-direct', 'c-new-0']);
  expect(calls.filter((call) => call.method === 'getChats').map((call) => call.mids.length)).toEqual([100, 2]);
  expect(calls.filter((call) => call.method === 'getChats').flatMap((call) => call.mids)).not.toContain('u-direct');
  expect(calls.findIndex((call) => call.method === 'getContactsV2')).toBeGreaterThan(1);
  // Ids that LINE does not return give no item; the others match the catalog mapping.
  expect(details).toHaveLength(101);
  expect(details.find((item) => item.chatId === 'c-new-5')).toBeUndefined();
  expect(details.find((item) => item.chatId === 'r-room')).toMatchObject({ chatType: 'room', title: 'Name r-room' });
  const first = details.find((item) => item.chatId === 'c-new-0');
  const catalog = await fetchLinejsConversationCatalog({
    ownMid: 'u-self',
    getAllChatMids: async () => ({ memberChatMids: ['c-new-0'] }),
    getMessageBoxes: async () => ({ messageBoxes: [] }),
    getChats: talk.getChats,
    getContactsV2: talk.getContactsV2,
  }, async (call) => await call());
  expect(first).toEqual(catalog[0]);
  expect(first).toEqual({ chatType: 'group', chatId: 'c-new-0', title: 'Name c-new-0', picturePath: 'https://profile.line-scdn.net/0hGroup', members: [
    { memberId: 'u-c-new-0', displayName: 'D u-c-new-0' }, { memberId: 'u-self', displayName: 'D u-self', nickname: 'Me' },
  ] });
});
