import { normalizeNativePicturePath, type ConversationCatalogItem } from '@line-agent/contracts';

export type DownloadedAttachment = Readonly<{
  name: string | null;
  source: AsyncIterable<Uint8Array>;
}>;

type CatalogChat = Readonly<{
  chatMid?: unknown;
  chatName?: unknown;
  picturePath?: unknown;
  extra?: { groupExtra?: { memberMids?: unknown } };
}>;
type CatalogTalk = Readonly<{
  ownMid: string;
  getAllChatMids(options: { request: { withMemberChats: true }; syncReason: 'INTERNAL' }): Promise<{ memberChatMids?: unknown }>;
  getMessageBoxes(options: { messageBoxListRequest: Record<string, never> }): Promise<{
    messageBoxes?: readonly Readonly<{ id?: unknown }>[];
  }>;
  getChats(options: { chatMids: string[] }): Promise<{ chats?: readonly CatalogChat[] }>;
  getContactsV2(options: { mids: string[] }): Promise<{ contacts?: unknown }>;
}>;

const CATALOG_BATCH_SIZE = 100;
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
function stringIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (value && typeof value === 'object') return Object.keys(value).filter((item) => item.length > 0);
  return [];
}
function chatType(chatId: string): ConversationCatalogItem['chatType'] | null {
  if (chatId.startsWith('u')) return 'direct';
  if (chatId.startsWith('c')) return 'group';
  if (chatId.startsWith('r')) return 'room';
  return null;
}

export function normalizeLinePicturePath(value: unknown, present = value !== undefined): string | null | undefined {
  if (!present) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || (!value.startsWith('/') && !value.startsWith('https://'))) return undefined;
  return normalizeNativePicturePath(value) ?? undefined;
}

/** Mirrors LINEJS Client.fetchJoinedChats while preserving the worker read gate. */
export async function fetchLinejsConversationCatalog(
  talk: CatalogTalk,
  invokeRead: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<ConversationCatalogItem[]> {
  const joined = await invokeRead(() => talk.getAllChatMids({
    request: { withMemberChats: true }, syncReason: 'INTERNAL',
  }));
  const boxes = await invokeRead(() => talk.getMessageBoxes({ messageBoxListRequest: {} }));
  const messageBoxIds = (boxes.messageBoxes ?? []).flatMap((box) =>
    typeof box.id === 'string' && chatType(box.id) !== null ? [box.id] : []);
  const chatMids = [...new Set([...messageBoxIds, ...stringIds(joined.memberChatMids)])];
  return buildConversationCatalogItems(talk, invokeRead, chatMids);
}

/** getChats chunks + getContactsV2 chunks + item mapping, shared by the full catalog and the detail read. */
async function buildConversationCatalogItems(
  talk: Pick<CatalogTalk, 'getChats' | 'getContactsV2'>,
  invokeRead: <T>(call: () => Promise<T>) => Promise<T>,
  chatMids: readonly string[],
): Promise<ConversationCatalogItem[]> {
  const joinedChatMids = chatMids.filter((chatId) => chatType(chatId) !== 'direct');
  const chats: CatalogChat[] = [];
  for (const batch of chunks(joinedChatMids, CATALOG_BATCH_SIZE)) {
    const response = await invokeRead(() => talk.getChats({ chatMids: batch }));
    chats.push(...(response.chats ?? []));
  }
  const chatsById = new Map(chats.flatMap((chat) => typeof chat.chatMid === 'string' ? [[chat.chatMid, chat] as const] : []));
  const normalized = chatMids.flatMap((chatId) => {
    const type = chatType(chatId);
    if (type === null) return [];
    const raw = type === 'direct' ? { chatMid: chatId } : chatsById.get(chatId);
    if (!raw) return [];
    const memberIds = type === 'direct'
      ? [chatId]
      : stringIds(raw.extra?.groupExtra?.memberMids).sort();
    return [{ raw, chatId, chatType: type, memberIds }];
  });
  const memberIds = [...new Set(normalized.flatMap((chat) => chat.memberIds))].sort();
  const displayNames = new Map<string, string | null>();
  // Locally set contact names (Contact.displayNameOverridden) from the same getContactsV2 response.
  const nicknames = new Map<string, string>();
  const picturePaths = new Map<string, string | null | undefined>();
  for (const batch of chunks(memberIds, CATALOG_BATCH_SIZE)) {
    const response = await invokeRead(() => talk.getContactsV2({ mids: batch }));
    if (!response.contacts || typeof response.contacts !== 'object' || Array.isArray(response.contacts)) continue;
    for (const [memberId, value] of Object.entries(response.contacts)) {
      const contact = value && typeof value === 'object' ? (value as { contact?: unknown }).contact : null;
      const displayName = contact && typeof contact === 'object'
        && typeof (contact as { displayName?: unknown }).displayName === 'string'
        ? (contact as { displayName: string }).displayName : null;
      displayNames.set(memberId, displayName);
      const nickname = contact && typeof contact === 'object'
        && typeof (contact as { displayNameOverridden?: unknown }).displayNameOverridden === 'string'
        ? (contact as { displayNameOverridden: string }).displayNameOverridden.slice(0, 256) : undefined;
      if (nickname !== undefined) nicknames.set(memberId, nickname);
      const hasPicturePath = Boolean(contact && typeof contact === 'object' && Object.hasOwn(contact, 'picturePath'));
      picturePaths.set(memberId, normalizeLinePicturePath(
        contact && typeof contact === 'object' ? (contact as { picturePath?: unknown }).picturePath : undefined,
        hasPicturePath,
      ));
    }
  }
  return normalized.map(({ raw, chatId, chatType: type, memberIds: ids }) => {
    const members = ids.map((memberId) => {
      const picturePath = picturePaths.get(memberId);
      const nickname = nicknames.get(memberId);
      return { memberId, displayName: displayNames.get(memberId) ?? null,
        ...(nickname === undefined ? {} : { nickname }),
        ...(picturePath === undefined ? {} : { picturePath }) };
    });
    const rawTitle = typeof raw.chatName === 'string' && raw.chatName.length > 0 ? raw.chatName : null;
    // Direct title rule shared with the native reader: the owner's nickname wins over the profile name.
    const title = type === 'direct' ? (nicknames.get(chatId) || null) ?? displayNames.get(chatId) ?? rawTitle : rawTitle;
    const picturePath = type === 'direct'
      ? picturePaths.get(chatId)
      : normalizeLinePicturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
    return { chatType: type, chatId, title, members,
      ...(picturePath === undefined ? {} : { picturePath }) };
  });
}

/**
 * Group/room detail read for chats the catalog has not seen: getChats (chunks of 100), then getContactsV2 for the member MIDs.
 * Official ext 3.7.2 thunks talkChat/fetchTalkChats and contact/fetchContacts: same chunking, same request shape.
 */
export async function fetchLinejsConversationDetails(
  talk: Pick<CatalogTalk, 'getChats' | 'getContactsV2'>,
  invokeRead: <T>(call: () => Promise<T>) => Promise<T>,
  chatIds: readonly string[],
): Promise<ConversationCatalogItem[]> {
  const ids = [...new Set(chatIds)].filter((chatId) => chatType(chatId) === 'group' || chatType(chatId) === 'room');
  return buildConversationCatalogItems(talk, invokeRead, ids);
}

export async function decryptLinejsHistoryMessages(
  messages: readonly unknown[],
  decrypt: (message: unknown) => Promise<unknown>,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const message of messages) {
    const metadata = message && typeof message === 'object'
      ? (message as { contentMetadata?: unknown }).contentMetadata : null;
    const encrypted = metadata && typeof metadata === 'object'
      && Boolean((metadata as { e2eeVersion?: unknown }).e2eeVersion);
    result.push(encrypted ? await decrypt(message) : message);
  }
  return result;
}
