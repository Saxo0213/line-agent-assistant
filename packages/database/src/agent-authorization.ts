import type { ConversationKey } from '@line-agent/contracts';
import type { PoolClient } from 'pg';

export type AgentAdmissionAuthorization = { directGrantId: string; directGrantVersion: number };

/**
 * Single authority for "is this sender's stored friend grant still valid for this chat".
 * Used by message admission and by internal-Agent MCP calls; runs inside the caller's transaction.
 */
export async function lockAndCheckAgentAuthorization(
  client: PoolClient, accountId: string, chatType: ConversationKey['chatType'], chatId: string, senderId: string,
  authorization: AgentAdmissionAuthorization,
): Promise<boolean> {
  const locks = [JSON.stringify([accountId, senderId, 'ACCOUNT'])];
  if (chatType !== 'direct') locks.push(JSON.stringify([accountId, senderId, 'CHAT', chatType, chatId]));
  for (const lock of locks.sort()) {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [lock]);
  }
  const direct = await client.query<{ scope_kind: 'ACCOUNT' | 'CHAT' }>(
    `SELECT scope_kind FROM line_friend_whitelist_grants
     WHERE account_id = $1 AND target_mid = $2 AND grant_id = $3 AND version = $4
       AND capability = 'AGENT_USE' AND state = 'ACTIVE'
       AND ((scope_kind = 'ACCOUNT' AND chat_type IS NULL AND chat_id IS NULL)
         OR (scope_kind = 'CHAT' AND chat_type = $5 AND chat_id = $6)) FOR SHARE`,
    [accountId, senderId, authorization.directGrantId, authorization.directGrantVersion,
      chatType === 'direct' ? null : chatType, chatType === 'direct' ? null : chatId],
  );
  if (direct.rowCount !== 1) return false;
  // A group or room needs no activation: the whitelist grant alone authorizes the sender.
  return chatType !== 'direct' || direct.rows[0]!.scope_kind === 'ACCOUNT';
}

/**
 * Room-level half of the predicate above, for a free-mode job: the room's free mode is still on.
 * A free-mode job has no per-sender friend grant; the active free-mode window alone authorizes it.
 */
export async function lockAndCheckFreeMode(
  client: PoolClient, accountId: string, chatType: ConversationKey['chatType'], chatId: string,
): Promise<boolean> {
  if (chatType === 'direct') return false;
  const room = await client.query(
    `SELECT 1 FROM room_free_mode
     WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND expires_at > clock_timestamp() FOR SHARE`,
    [accountId, chatType, chatId],
  );
  return room.rowCount === 1;
}
