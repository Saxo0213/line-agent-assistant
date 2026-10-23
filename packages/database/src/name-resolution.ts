import type { Pool, PoolClient } from 'pg';
import { normalizeNativePicturePath } from '@line-agent/contracts';

/**
 * The single read entry for every person and conversation name shown by the app
 * (timeline sender, reply previews, search, MCP targets and messages, conversation
 * list). Every read path embeds these fragments instead of keeping its own rule.
 *
 * Required aliases, always joined by account_id:
 *   m               messages
 *   la              line_accounts (the account that owns the message)
 *   c               conversations (nullable)
 *   cm              conversation_members for the sender (nullable)
 *   sender_contact  line_contacts for the sender (see SENDER_CONTACT_JOIN)
 *   peer_contact    line_contacts for a direct conversation's peer (see PEER_CONTACT_JOIN)
 *
 * Sender rule:
 *   own message                -> the account's display name, else 「我」
 *   community / thread sender  -> conversation_members.display_name (community profile name;
 *                                 contact nicknames do not apply there)
 *   everyone else              -> contact nickname -> contact display name -> member display name
 *                                 -> direct-chat title
 * Conversation title rule (direct chats only gain a fallback):
 *   conversations.title, else the peer contact's nickname -> display name.
 */
export const SENDER_CONTACT_JOIN =
  'LEFT JOIN line_contacts sender_contact ON sender_contact.account_id = m.account_id AND sender_contact.mid = m.sender_id';

export const PEER_CONTACT_JOIN =
  `LEFT JOIN line_contacts peer_contact ON peer_contact.account_id = c.account_id
        AND c.chat_type = 'direct' AND peer_contact.mid = c.chat_id`;

/** True for messages authored by this account, including native community rows where sender_id is not own_mid. */
export function ownMessageSql(m: string, la: string): string {
  return `(( ${la}.own_mid IS NOT NULL AND ${m}.sender_id = ${la}.own_mid) OR COALESCE((
    SELECT (CASE WHEN jsonb_typeof(${m}.raw->'native'->'row'->'columns') = 'array' THEN
      ${m}.raw->'native'->'row'->'cells'->((c.i - 1)::int)->>'value'
    END) IN ('2','4')
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${m}.raw->'native'->'row'->'columns') = 'array'
      THEN ${m}.raw->'native'->'row'->'columns' ELSE '[]'::jsonb END) WITH ORDINALITY c(col, i)
    WHERE c.col = '_status' LIMIT 1
  ), false))`;
}

export interface SenderNameAliases {
  m: string;
  la: string;
  c: string;
  cm: string;
  senderContact: string;
  peerContact: string;
}

const DEFAULT_SENDER_NAME_ALIASES: SenderNameAliases = {
  m: 'm', la: 'la', c: 'c', cm: 'cm', senderContact: 'sender_contact', peerContact: 'peer_contact',
};

export function conversationTitleSql(aliases: Pick<SenderNameAliases, 'c' | 'peerContact'> = DEFAULT_SENDER_NAME_ALIASES): string {
  return `COALESCE(NULLIF(${aliases.c}.title, ''), NULLIF(${aliases.peerContact}.nickname, ''), NULLIF(${aliases.peerContact}.display_name, ''))`;
}

export const CONVERSATION_TITLE_SQL = conversationTitleSql();

export function senderNameSql(overrides: Partial<SenderNameAliases> = {}): string {
  const aliases = { ...DEFAULT_SENDER_NAME_ALIASES, ...overrides };
  const { m, la, c, cm, senderContact, peerContact } = aliases;
  return `CASE
     WHEN ${la}.own_mid IS NOT NULL AND ${m}.sender_id = ${la}.own_mid THEN NULLIF(${la}.display_name, '')
     WHEN ${m}.chat_type IN ('community', 'thread') THEN NULLIF(${cm}.display_name, '')
     ELSE COALESCE(NULLIF(${senderContact}.nickname, ''), NULLIF(${senderContact}.display_name, ''),
       NULLIF(${cm}.display_name, ''), CASE WHEN ${m}.chat_type = 'direct' THEN ${conversationTitleSql({ c, peerContact })} END)
   END`;
}

export const SENDER_NAME_SQL = senderNameSql();

export interface SenderPictureAliases extends Pick<SenderNameAliases, 'm' | 'la' | 'c' | 'cm' | 'senderContact' | 'peerContact'> {}
const DEFAULT_SENDER_PICTURE_ALIASES: SenderPictureAliases = { ...DEFAULT_SENDER_NAME_ALIASES };

export function senderPictureSql(overrides: Partial<SenderPictureAliases> = {}): string {
  const { m, la, c, cm, senderContact, peerContact } = { ...DEFAULT_SENDER_PICTURE_ALIASES, ...overrides };
  return `CASE
    WHEN ${la}.own_mid IS NOT NULL AND ${m}.sender_id = ${la}.own_mid THEN ${la}.picture_path
    WHEN ${m}.chat_type IN ('community', 'thread') THEN ${cm}.picture_path
    WHEN ${m}.chat_type = 'direct' THEN COALESCE(${c}.picture_path, ${peerContact}.picture_path, ${senderContact}.picture_path, ${cm}.picture_path)
    ELSE COALESCE(${cm}.picture_path, ${senderContact}.picture_path)
  END`;
}

export const SENDER_PICTURE_SQL = senderPictureSql();

export function conversationPictureSql(aliases: Pick<SenderNameAliases, 'c' | 'la' | 'peerContact'> = DEFAULT_SENDER_NAME_ALIASES): string {
  return `COALESCE(${aliases.c}.picture_path, ${aliases.peerContact}.picture_path,
    CASE WHEN ${aliases.c}.chat_type = 'direct' AND ${aliases.c}.chat_id = ${aliases.la}.own_mid THEN ${aliases.la}.picture_path END)`;
}

export const CONVERSATION_PICTURE_SQL = conversationPictureSql();

/** Member display name in a conversation member list (alias member_contact joins line_contacts for non community/thread chats). */
export const MEMBER_NAME_SQL =
  `COALESCE(NULLIF(member_contact.nickname, ''), NULLIF(member_contact.display_name, ''), NULLIF(cm.display_name, ''))`;

export interface NameFragments {
  /** Conversation title expression (aliases c, peer_contact). */
  title: string;
  /** Sender name expression (aliases m, la, c, cm, sender_contact, peer_contact). */
  sender: string;
  /** Member name expression (aliases cm, member_contact). */
  member: string;
  /** `coalesce(<alias>.nickname, '')` for the full rule; an empty string for own-names so nicknames never match. */
  nickname(alias: string): string;
}

const FULL_NAME_FRAGMENTS: NameFragments = {
  title: CONVERSATION_TITLE_SQL, sender: SENDER_NAME_SQL, member: MEMBER_NAME_SQL,
  nickname: (alias) => `coalesce(${alias}.nickname, '')`,
};

/**
 * Name privacy for non-admin principals: the owner's local nicknames never reach (or match against) their output.
 * The line-worker stores the owner's nickname in conversations.title for direct chats, so a direct chat's title
 * comes only from the peer's own LINE display name; groups keep their title. Sender/member names skip nicknames.
 */
const OWN_TITLE_SQL =
  `COALESCE(CASE WHEN c.chat_type <> 'direct' THEN NULLIF(c.title, '') END, NULLIF(peer_contact.display_name, ''))`;
const OWN_NAME_FRAGMENTS: NameFragments = {
  title: OWN_TITLE_SQL,
  sender: `CASE
     WHEN la.own_mid IS NOT NULL AND m.sender_id = la.own_mid THEN COALESCE(NULLIF(la.display_name, ''), '我')
     WHEN m.chat_type IN ('community', 'thread') THEN NULLIF(cm.display_name, '')
     ELSE COALESCE(NULLIF(sender_contact.display_name, ''),
       NULLIF(cm.display_name, ''), CASE WHEN m.chat_type = 'direct' THEN ${OWN_TITLE_SQL} END)
   END`,
  member: `COALESCE(NULLIF(member_contact.display_name, ''), NULLIF(cm.display_name, ''))`,
  nickname: () => `''::text`,
};

export function nameFragments(ownLineNamesOnly: boolean): NameFragments {
  return ownLineNamesOnly ? OWN_NAME_FRAGMENTS : FULL_NAME_FRAGMENTS;
}

/** Columns that must appear in a GROUP BY when the fragments above are used in an aggregate query. */
export const NAME_RESOLUTION_GROUP_COLUMNS =
  'la.display_name, la.own_mid, c.title, c.chat_type, cm.display_name, sender_contact.nickname, sender_contact.display_name, peer_contact.nickname, peer_contact.display_name';

export interface LineContactInput {
  mid: string;
  displayName: string | null;
  /** undefined = the source did not say (keep the stored nickname); null = the source says there is none. */
  nickname?: string | null;
  nativeType?: number | null;
  nativeStatus?: number | null;
  picturePath?: string | null;
}

const MAX_CONTACT_NAME = 256;
const MAX_MID = 512;

function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  return value.length <= MAX_CONTACT_NAME ? value : value.slice(0, MAX_CONTACT_NAME);
}

/**
 * Upserts a bounded batch of contacts for one account and returns how many rows changed.
 * Shared by both writers (native `_contact` pages and the live `getContactsV2` catalog):
 * the same columns, the same normalization, always keyed by (account_id, mid).
 */
export async function upsertLineContacts(client: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  accountId: string, contacts: readonly LineContactInput[]): Promise<number> {
  const unique = new Map<string, Record<string, unknown>>();
  for (const contact of contacts) {
    if (typeof contact.mid !== 'string' || contact.mid.length === 0 || contact.mid.length > MAX_MID || contact.mid.includes('\0')) continue;
    unique.set(contact.mid, { mid: contact.mid, display_name: cleanName(contact.displayName), nickname: cleanName(contact.nickname), nickname_set: contact.nickname !== undefined,
      picture_path: normalizeNativePicturePath(contact.picturePath),
      native_type: Number.isSafeInteger(contact.nativeType) ? contact.nativeType : null,
      native_status: Number.isSafeInteger(contact.nativeStatus) ? contact.nativeStatus : null });
  }
  if (unique.size === 0) return 0;
  const rows = JSON.stringify([...unique.values()]);
  const columns = 'row(mid text,display_name text,nickname text,nickname_set boolean,picture_path text,native_type integer,native_status integer)';
  const inserted = await client.query(`INSERT INTO line_contacts(account_id,mid,display_name,nickname,native_type,native_status,picture_path)
    SELECT $1,row.mid,row.display_name,row.nickname,row.native_type,row.native_status,row.picture_path
      FROM jsonb_to_recordset($2::jsonb) AS ${columns} ON CONFLICT(account_id,mid) DO NOTHING`, [accountId, rows]);
  // A known name is never blanked by a response that did not carry it; a nickname is cleared
  // only when the source states there is none (nickname_set with a null value).
  const updated = await client.query(`UPDATE line_contacts t SET
      display_name=COALESCE(r.display_name,t.display_name),
      nickname=CASE WHEN r.nickname_set THEN r.nickname ELSE t.nickname END,
      picture_path=COALESCE(r.picture_path,t.picture_path),
      native_type=COALESCE(r.native_type,t.native_type),native_status=COALESCE(r.native_status,t.native_status),updated_at=now()
    FROM jsonb_to_recordset($2::jsonb) AS ${columns.replace('row(', 'r(')}
    WHERE t.account_id=$1 AND t.mid=r.mid AND (
      t.display_name IS DISTINCT FROM COALESCE(r.display_name,t.display_name)
      OR t.nickname IS DISTINCT FROM CASE WHEN r.nickname_set THEN r.nickname ELSE t.nickname END
      OR t.native_type IS DISTINCT FROM COALESCE(r.native_type,t.native_type)
      OR t.native_status IS DISTINCT FROM COALESCE(r.native_status,t.native_status)
      OR t.picture_path IS DISTINCT FROM COALESCE(r.picture_path,t.picture_path))`, [accountId, rows]);
  return (inserted.rowCount ?? 0) + (updated.rowCount ?? 0);
}
