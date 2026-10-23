import type { Pool, PoolClient } from 'pg';

/**
 * Display names for the MIDs of a native type-18 chat event, read with the same precedence as SENDER_NAME_SQL:
 * the account owner's MID -> the account display name; community/thread -> the member name only; everyone else ->
 * contact nickname -> contact display name -> member display name. MIDs without a name are simply absent (the bridge
 * then falls back to 「成員」).
 */
export async function loadChatEventNames(db: Pool | PoolClient, accountId: string, chatType: string, chatId: string,
  mids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  if (mids.length === 0) return names;
  const result = await db.query<{ mid: string; name: string | null }>(
    `SELECT t.mid,
       CASE WHEN la.own_mid IS NOT NULL AND t.mid = la.own_mid THEN NULLIF(la.display_name, '')
            WHEN $3 IN ('community', 'thread') THEN NULLIF(cm.display_name, '')
            ELSE COALESCE(NULLIF(lc.nickname, ''), NULLIF(lc.display_name, ''), NULLIF(cm.display_name, '')) END AS name
     FROM unnest($4::text[]) AS t(mid)
     JOIN line_accounts la ON la.account_id = $1
     LEFT JOIN line_contacts lc ON lc.account_id = $1 AND lc.mid = t.mid
     LEFT JOIN conversation_members cm ON cm.account_id = $1 AND cm.chat_type = $3 AND cm.chat_id = $2 AND cm.member_id = t.mid`,
    [accountId, chatId, chatType, [...new Set(mids)]]);
  for (const row of result.rows) if (row.name) names.set(row.mid, row.name);
  return names;
}
