import type { ConversationKey } from '@line-agent/contracts';
import type { PoolClient } from 'pg';

export type AgentAdmissionAuthorization = { directGrantId: string; directGrantVersion: number; roomGrantId?: string; roomGrantVersion?: number };

/**
 * Single authority for "is this sender's stored friend/room grant still valid for this chat".
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
  const grantScope = direct.rows[0]!.scope_kind;
  if (chatType === 'direct') return grantScope === 'ACCOUNT'
    && authorization.roomGrantId === undefined && authorization.roomGrantVersion === undefined;
  if (grantScope === 'CHAT') return true;
  if (!authorization.roomGrantId || !authorization.roomGrantVersion) return false;
  const room = await client.query(
    `SELECT 1 FROM room_agent_policies p
     JOIN room_agent_grants g ON g.account_id = p.account_id AND g.chat_type = p.chat_type AND g.chat_id = p.chat_id
     WHERE p.account_id = $1 AND p.chat_type = $2 AND p.chat_id = $3 AND p.state = 'ENABLED'
       AND p.authority_version = $4 AND g.grant_id = $5 AND g.version = $6
       AND g.capability = 'AGENT_USE_ROOM' AND g.state = 'ACTIVE' FOR SHARE OF p, g`,
    [accountId, chatType, chatId, authorization.roomGrantVersion, authorization.roomGrantId, authorization.roomGrantVersion],
  );
  return room.rowCount === 1;
}

/**
 * Room-level half of the predicate above, for a free-mode job: the room's stored Agent grant is still the active one.
 * A free-mode job has no per-sender friend grant; the room grant alone authorizes it.
 */
export async function lockAndCheckRoomAgentGrant(
  client: PoolClient, accountId: string, chatType: ConversationKey['chatType'], chatId: string,
  grant: { grantId: string; version: number },
): Promise<boolean> {
  if (chatType === 'direct') return false;
  const room = await client.query(
    `SELECT 1 FROM room_agent_policies p
     JOIN room_agent_grants g ON g.account_id = p.account_id AND g.chat_type = p.chat_type AND g.chat_id = p.chat_id
     WHERE p.account_id = $1 AND p.chat_type = $2 AND p.chat_id = $3 AND p.state = 'ENABLED'
       AND p.authority_version = $4 AND g.grant_id = $5 AND g.version = $4
       AND g.capability = 'AGENT_USE_ROOM' AND g.state = 'ACTIVE' FOR SHARE OF p, g`,
    [accountId, chatType, chatId, grant.version, grant.grantId],
  );
  return room.rowCount === 1;
}
