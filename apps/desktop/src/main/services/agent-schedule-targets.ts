import type { Pool } from 'pg';
import { LOCAL_AGENT_ROOM_CHAT_ID, type AgentScheduleTarget, type AgentScheduleTargetOption } from '@line-agent/contracts';
import { AgentScheduleError, findSharedAdminChat, type MessageRepository } from '@line-agent/database';
import type { AgentScheduleTargetPurpose, AgentScheduleTargetResolver } from './agent-schedule-service.js';

const readableAccounts = async (pool: Pick<Pool, 'query'>): Promise<string[]> =>
  (await pool.query<{ account_id: string }>("SELECT account_id FROM line_accounts WHERE mode <> 'PAUSED' ORDER BY account_id ASC")).rows.map((row) => row.account_id);

/**
 * Read targets: any chat the internal Agent job can read through list_targets / query_target_messages_by_time (every non-paused
 * account, every chat type, never the local Agent room). Delivery targets: the Agent account's direct, group and room chats
 * (the set the send tools use).
 */
export function createAgentScheduleTargetResolver(deps: {
  messages: Pick<MessageRepository, 'findAgentSendAccount' | 'listSendTargets' | 'getSendTarget' | 'listConversationTargets'>;
  pool: Pick<Pool, 'query'>;
}): AgentScheduleTargetResolver {
  const invalid = (target: Pick<AgentScheduleTarget, 'chatType' | 'chatId'>) =>
    new AgentScheduleError('SCHEDULE_INVALID_TARGET', `Unknown or unavailable chat: ${target.chatType}/${target.chatId}`);

  /** Marks the administrator's direct chat with the Agent account and sorts it first. */
  async function markAdmin(items: AgentScheduleTargetOption[]): Promise<AgentScheduleTargetOption[]> {
    const admin = await findSharedAdminChat(deps.pool).catch(() => null);
    if (!admin) return items;
    const marked = items.map((item): AgentScheduleTargetOption => item.accountId === admin.accountId && item.chatType === 'direct' && item.chatId === admin.adminMid
      ? { ...item, role: 'primary_admin' } : item);
    return [...marked.filter((item) => item.role), ...marked.filter((item) => !item.role)];
  }

  async function listDelivery(query: string | undefined, limit: number): Promise<AgentScheduleTargetOption[]> {
    const accountId = await deps.messages.findAgentSendAccount();
    if (!accountId) return [];
    const rows = await deps.messages.listSendTargets({ accountId, ...(query ? { query } : {}), limit });
    return markAdmin(rows.filter((row) => row.chatId !== LOCAL_AGENT_ROOM_CHAT_ID)
      .map((row): AgentScheduleTargetOption => ({ accountId, chatType: row.chatType, chatId: row.chatId, title: (row.title ?? '').slice(0, 200) })));
  }

  async function listRead(query: string | undefined, limit: number): Promise<AgentScheduleTargetOption[]> {
    const accountIds = await readableAccounts(deps.pool);
    const rows = await deps.messages.listConversationTargets({ accountIds, ...(query ? { query } : {}), limit });
    return markAdmin(rows.filter((row) => row.chatId !== LOCAL_AGENT_ROOM_CHAT_ID)
      .map((row): AgentScheduleTargetOption => ({ accountId: row.accountId, chatType: row.chatType, chatId: row.chatId, title: (row.conversationTitle ?? '').slice(0, 200) })));
  }

  async function resolveRead(targets: readonly AgentScheduleTarget[]): Promise<AgentScheduleTarget[]> {
    const accountIds = await readableAccounts(deps.pool);
    const resolved: AgentScheduleTarget[] = [];
    for (const target of targets) {
      // The same lookup list_targets uses, restricted in SQL to exactly this conversation.
      const found = target.chatId === LOCAL_AGENT_ROOM_CHAT_ID || !accountIds.includes(target.accountId) ? undefined
        : (await deps.messages.listConversationTargets({ accountIds: [target.accountId], conversationScope: target, limit: 1 }))[0];
      if (!found || found.chatType !== target.chatType || found.chatId !== target.chatId) throw invalid(target);
      resolved.push({ accountId: found.accountId, chatType: found.chatType, chatId: found.chatId, title: (found.conversationTitle ?? target.title).slice(0, 200) });
    }
    return resolved;
  }

  async function resolveDelivery(targets: readonly AgentScheduleTarget[]): Promise<AgentScheduleTarget[]> {
    const accountId = await deps.messages.findAgentSendAccount();
    const resolved: AgentScheduleTarget[] = [];
    for (const target of targets) {
      const found = accountId !== null && target.accountId === accountId
        ? await deps.messages.getSendTarget(target.accountId, target.chatType, target.chatId) : null;
      if (!found) throw invalid(target);
      const row = (await deps.pool.query<{ title: string | null }>(
        'SELECT title FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3', [found.accountId, found.chatType, found.chatId])).rows[0];
      resolved.push({ accountId: found.accountId, chatType: found.chatType, chatId: found.chatId, title: (row?.title ?? target.title).slice(0, 200) });
    }
    return resolved;
  }

  return {
    list: (query, limit, purpose: AgentScheduleTargetPurpose = 'read') => purpose === 'delivery' ? listDelivery(query, limit) : listRead(query, limit),
    resolve: (targets, purpose: AgentScheduleTargetPurpose = 'read') => purpose === 'delivery' ? resolveDelivery(targets) : resolveRead(targets),
  };
}
