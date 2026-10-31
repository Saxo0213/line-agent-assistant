import { AGENT_ROOM_HISTORY_TOOL_NAME, LIST_SEND_TARGETS_TOOL_NAME, SEND_TO_TARGET_TOOL_NAME, SCHEDULE_TOOL_NAMES, isScheduleToolName, MCP_TOOL_EFFECTS, MCP_TOOL_PERMISSIONS, MCP_TOOL_NAMES, McpToolNameSchema, type McpInternalToolName, type EffectivePermissions, type ConversationKey, type McpToolName } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { lockAndCheckAgentAuthorization, lockAndCheckRoomAgentGrant } from './agent-authorization.js';
import { findSharedAdminChat, type SharedAdminChat } from './agent-repository.js';
import { FREE_MODE_MEMBER_ID, allPermissions, findPrimaryAdminUser, resolveLinkedChats, resolveUserPermissions } from './agent-permissions.js';
import { parseRoleScope, type ProductRole } from './managed-mcp-scopes.js';

/** Fixed principal and account scopes of the token-less external local MCP client. */
export const LOCAL_CLIENT_PRINCIPAL_ID = 'local-client';
const LOCAL_CLIENT_ACCOUNT_SCOPES = ['role:AGENT', 'role:PRIMARY_ADMIN'] as const;

export type McpErrorCode =
  | 'MCP_INVALID_ACCOUNT_SCOPE'
  | 'AUTH_INVALID'
  | 'REVOKED'
  | 'EXPIRED'
  | 'SCOPE_DENIED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'CONTROL_CHANGED'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_INPUT';

export class McpDomainError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpDomainError';
  }
}

/**
 * Only the Primary Admin's LINE jobs, the desktop operator's Agent room jobs and the operator's scheduled runs may send to LINE;
 * never a friend, room-grant user or external token.
 */
export const mayLineSend = (principalId: string): boolean =>
  principalId === 'internal:ui' || principalId === SCHEDULE_PRINCIPAL_ID || principalId.startsWith('internal:primary_admin:');

/**
 * Principal of a scheduled Agent run. Same data scope and permissions as the room operator (internal:ui), but a distinct audit
 * identity, and it is not an Agent room job: it has no room history. It is accepted by exactly the tools `mayLineSend` gates
 * (list_send_targets, send_to_target and the schedule tools; create/update/delete_schedule are refused for schedule jobs by McpService).
 */
export const SCHEDULE_PRINCIPAL_ID = 'internal:schedule';

/** Data scope derived server-side from the job row; never from tool arguments. */
export type InternalDataScope =
  | { kind: 'full' }
  /** Account scope copied from an externally created schedule to its durable job row. */
  | { kind: 'accounts'; accountIds: readonly string[] }
  /** `records.query_all_chats` ALLOW: every chat of the job's own account, the only widening past the current chat. */
  | { kind: 'account'; accountId: string }
  /** The job's own chat plus the group/room chats of the user's linked folders. */
  | { kind: 'chat'; accountId: string; chatType: ConversationKey['chatType']; chatId: string;
      linkedChats: ReadonlyArray<Pick<ConversationKey, 'chatType' | 'chatId'>> };

export type InternalAgentExecutionContext =
  | { sourceType: 'ui'; requestId?: string }
  | { sourceType: 'line'; jobId: string }
  /**
   * Main itself reading for a program schedule (new_messages) with no job row. Same principal (`internal:schedule`), scope, permissions and
   * audit row as a scheduled Agent run (resolveInternalPrincipal maps a schedule job to this same context); no Agent room history.
   */
  | { sourceType: 'schedule'; accountScope?: readonly string[] | null }
  /**
   * Built-in Agent MCP capability: the durable job row (running, exact generation, account)
   * is rechecked on every request and its source_type decides the authority.
   */
  | { sourceType: 'job'; jobId: string; generation: number; accountId: string | null };

export interface McpAuditRecord {
  auditId: number;
  tokenId: string | null;
  principalId: string;
  initiator: 'user' | 'external_agent' | 'internal_agent';
  action: 'TOKEN_ISSUED' | 'TOKEN_REVOKED' | 'TOOL_CALLED' | 'AUTH_REJECTED';
  toolName: McpInternalToolName | null;
  accountScopes: string[];
  grantVersion: number | null;
  disposition:
    | 'ISSUED'
    | 'REVOKED_BY_OPERATOR'
    | 'ALLOWED'
    | 'AUTH_INVALID'
    | 'REVOKED'
    | 'EXPIRED'
    | 'SCOPE_DENIED'
    | 'PERMISSION_DENIED'
    | 'RATE_LIMITED'
    | 'CONTROL_CHANGED'
    | 'APPROVAL_REQUIRED'
    | 'INVALID_INPUT';
  resultCount: number | null;
  occurredAt: string;
}

export class McpTokenRepository {
  private pendingMcpAcquisitions = 0;
  constructor(private readonly pool: Pool) {}

  private async withMcpTransaction<T>(signal: AbortSignal | undefined, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new Error('MCP request cancelled');
    let client: PoolClient | undefined;
    let released = false;
    let cancelled = false;
    const release = (destroy = false) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    let rejectCancellation!: (error: Error) => void;
    const cancelledPromise = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = () => {
      cancelled = true;
      release(true);
      rejectCancellation(new Error('MCP request cancelled'));
    };
    signal?.addEventListener('abort', cancel, { once: true });

    if (this.pendingMcpAcquisitions >= 8) {
      signal?.removeEventListener('abort', cancel);
      throw new Error('MCP database connection admission limit exceeded');
    }
    this.pendingMcpAcquisitions += 1;
    let acquisitionSettled = false;
    const acquisition = this.pool.connect().then((acquired) => {
      acquisitionSettled = true;
      this.pendingMcpAcquisitions -= 1;
      client = acquired;
      if (cancelled) release(true);
      return acquired;
    }, (error: unknown) => {
      acquisitionSettled = true;
      this.pendingMcpAcquisitions -= 1;
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        release(true);
        reject(new Error('MCP database acquisition or transaction deadline exceeded'));
      }, 4_000);
    });
    try {
      const connection = await Promise.race([acquisition, cancelledPromise, deadline]);
      if (cancelled || signal?.aborted) throw new Error('MCP request cancelled');
      await connection.query('BEGIN');
      await connection.query("SET LOCAL statement_timeout = '2000ms'");
      await connection.query("SET LOCAL lock_timeout = '1000ms'");
      const result = await operation(connection);
      if (cancelled || signal?.aborted) throw new Error('MCP request cancelled');
      await connection.query('COMMIT');
      if (cancelled || signal?.aborted) throw new Error('MCP request cancelled');
      return result;
    } catch (error) {
      if (!cancelled && client) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      release(cancelled || signal?.aborted === true);
      if (!acquisitionSettled) void acquisition.then(() => release(true), () => undefined);
    }
  }

  /**
   * Request path of the external local MCP client. The client has no token. The 127.0.0.1 bind and the HTTP
   * request guard are the only gate. Authority is fixed: the AGENT and PRIMARY_ADMIN accounts, every external tool.
   */
  async executeLocalClientRead<T>(input: {
    toolName: McpInternalToolName | null;
    /** A unique identity for one external MCP request; never supplied by the client. */
    principalId?: string;
    requestedAccountId?: string;
    rateLimiter?: () => boolean;
    signal?: AbortSignal;
    execute: (context: {
      client: PoolClient;
      principalId: string;
      authorizedAccountIds: string[];
      toolScopes: McpInternalToolName[];
    }) => Promise<{ data: T; resultCount?: number }>;
  }): Promise<T> {
    return this.withMcpTransaction(input.signal, async (client) => {
      const principalId = input.principalId ?? LOCAL_CLIENT_PRINCIPAL_ID;
      const reject = async (accountScopes: readonly string[], disposition: McpAuditRecord['disposition']): Promise<void> => {
        await this.insertAudit(client, {
          tokenId: null, principalId, initiator: 'external_agent', action: 'AUTH_REJECTED', toolName: input.toolName,
          accountScopes, grantVersion: null, disposition, resultCount: null,
        });
        await client.query('COMMIT');
      };

      // One shared bucket limits all external requests.
      if (input.rateLimiter && !input.rateLimiter()) {
        await reject([], 'RATE_LIMITED');
        throw new McpDomainError('RATE_LIMITED', 'MCP request rate limit exceeded.');
      }

      // The local loopback client can use the explicitly supported LINE send and schedule tools.
      // Agent-room history remains internal-only.
      const externalTool = input.toolName === null ? null : McpToolNameSchema.safeParse(input.toolName);
      const localEffectTool = input.toolName === LIST_SEND_TARGETS_TOOL_NAME || input.toolName === SEND_TO_TARGET_TOOL_NAME || isScheduleToolName(input.toolName);
      if (input.toolName !== null && !externalTool?.success && !localEffectTool) {
        await reject([], 'SCOPE_DENIED');
        throw new McpDomainError('SCOPE_DENIED', `The external MCP endpoint does not offer tool "${input.toolName}".`);
      }

      // Approval is fail-closed for every tool without an explicit read classification.
      if (input.toolName !== null && externalTool?.success && MCP_TOOL_EFFECTS[externalTool.data] !== 'read') {
        await reject([], 'APPROVAL_REQUIRED');
        throw new McpDomainError('APPROVAL_REQUIRED', 'Operator approval is required for this MCP tool.');
      }

      const requestedAccount = input.requestedAccountId?.trim();
      const roleScopes = LOCAL_CLIENT_ACCOUNT_SCOPES.flatMap((scope) => {
        const role = parseRoleScope(scope);
        return role ? [role] : [];
      });
      const existingAccounts = await client.query<{ account_id: string; control_epoch: string; product_role: ProductRole | null }>(
        `SELECT a.account_id, c.control_epoch, a.product_role
         FROM line_accounts a CROSS JOIN account_control c
         WHERE a.product_role = ANY($1::text[])
           AND a.mode <> 'PAUSED' AND c.singleton = true
         ORDER BY a.account_id ASC`,
        [roleScopes],
      );
      const resolvedAccountIds = existingAccounts.rows.map((item) => item.account_id);
      if (requestedAccount && !resolvedAccountIds.includes(requestedAccount)) {
        await reject([requestedAccount], 'SCOPE_DENIED');
        throw new McpDomainError('SCOPE_DENIED', `The external MCP client is not authorized for LINE account "${requestedAccount}".`);
      }
      const authorizedAccountIds = requestedAccount ? [requestedAccount] : resolvedAccountIds;
      const resolvedRoleBindings = existingAccounts.rows.filter((account) => account.product_role !== null
        && authorizedAccountIds.includes(account.account_id));
      const controlEpoch = existingAccounts.rows[0]?.control_epoch;
      if (authorizedAccountIds.length === 0) {
        await reject(LOCAL_CLIENT_ACCOUNT_SCOPES, 'SCOPE_DENIED');
        throw new McpDomainError('SCOPE_DENIED', 'No authorized LINE accounts remain active for the external MCP client.');
      }

      let data: T;
      let resultCount: number | undefined;
      try {
        ({ data, resultCount } = await input.execute({
          client,
          principalId,
          authorizedAccountIds,
          toolScopes: [...MCP_TOOL_NAMES, LIST_SEND_TARGETS_TOOL_NAME, SEND_TO_TARGET_TOOL_NAME, ...SCHEDULE_TOOL_NAMES],
        }));
      } catch (stepError) {
        if (stepError instanceof McpDomainError && stepError.code === 'INVALID_INPUT') {
          await reject(authorizedAccountIds, 'INVALID_INPUT');
        }
        throw stepError;
      }

      // Recheck account control with fresh statements. Hold control -> account locks only until COMMIT
      // (never across the protected read).
      const currentControl = (await client.query<{ control_epoch: string }>(
        'SELECT control_epoch FROM account_control WHERE singleton=true FOR SHARE')).rows[0];
      const currentAccounts = (await client.query<{ account_id: string; product_role: ProductRole | null; mode: string }>(
        `SELECT account_id,product_role,mode FROM line_accounts WHERE account_id=ANY($1::text[])
         ORDER BY CASE product_role WHEN 'PRIMARY_ADMIN' THEN 0 WHEN 'AGENT' THEN 1 ELSE 2 END,account_id FOR SHARE`,
        [authorizedAccountIds])).rows;
      const authorityCurrent = currentControl?.control_epoch === controlEpoch
        && currentAccounts.length === authorizedAccountIds.length && currentAccounts.every((account) => account.mode !== 'PAUSED')
        && resolvedRoleBindings.every((expected) => currentAccounts.some((account) => account.account_id === expected.account_id
          && account.product_role === expected.product_role));
      if (!authorityCurrent) {
        await reject(authorizedAccountIds, 'CONTROL_CHANGED');
        throw new McpDomainError('CONTROL_CHANGED', 'Account control changed before the request completed.');
      }

      if (input.toolName !== null) {
        await this.insertAudit(client, {
          tokenId: null,
          principalId,
          initiator: 'external_agent',
          action: 'TOOL_CALLED',
          toolName: input.toolName,
          accountScopes: authorizedAccountIds,
          grantVersion: null,
          disposition: 'ALLOWED',
          resultCount: resultCount ?? null,
        });
      }

      return data;
    });
  }

  private async rejectInternal(client: PoolClient, toolName: McpInternalToolName | null, accountScopes: string[], message: string): Promise<never> {
    await this.insertAudit(client, {
      tokenId: null,
      principalId: 'internal:line:unauthorized',
      initiator: 'internal_agent',
      action: 'AUTH_REJECTED',
      toolName,
      accountScopes,
      grantVersion: null,
      disposition: 'SCOPE_DENIED',
      resultCount: null,
    });
    await client.query('COMMIT');
    throw new McpDomainError('SCOPE_DENIED', message);
  }

  /** Resolves the internal principal from durable state; audits and throws on denial. */
  private async resolveInternalPrincipal(
    client: PoolClient,
    initial: InternalAgentExecutionContext,
    toolName: McpInternalToolName | null,
    includeHistory = toolName === AGENT_ROOM_HISTORY_TOOL_NAME,
  ): Promise<{ principalId: string; scope: InternalDataScope; permissions: EffectivePermissions; history: { allowed: boolean; shared: SharedAdminChat | null } }> {
    let context: { sourceType: 'ui' } | { sourceType: 'schedule'; accountScope: string[] | null } | { sourceType: 'line'; jobId: string };
    if (initial.sourceType === 'job') {
      const row = (await client.query<{ account_id: string | null; generation: string | number; status: string; source_type: string; mcp_account_scope: string[] | null }>(
        `SELECT account_id, generation, status, source_type, mcp_account_scope FROM agent_jobs WHERE job_id = $1`,
        [initial.jobId],
      )).rows[0];
      // A UI job of the shared Agent room has no account (NULL === NULL); a LINE job must match its account exactly,
      // and the DB CHECK guarantees a LINE job is never account-less.
      if (!row || row.status !== 'running' || Number(row.generation) !== initial.generation || row.account_id !== initial.accountId
        || (row.source_type !== 'ui' && row.source_type !== 'line' && row.source_type !== 'schedule') || (row.source_type === 'line' && row.account_id === null)) {
        return this.rejectInternal(client, toolName, row?.account_id ? [row.account_id] : [], 'The Agent job is no longer authorized to use LINEJS MCP tools.');
      }
      context = row.source_type === 'ui' ? { sourceType: 'ui' } : row.source_type === 'schedule' ? { sourceType: 'schedule', accountScope: row.mcp_account_scope } : { sourceType: 'line', jobId: initial.jobId };
    } else context = initial.sourceType === 'schedule' ? { sourceType: 'schedule', accountScope: initial.accountScope == null ? null : [...initial.accountScope] } : initial;
    if (context.sourceType === 'schedule') {
      // NULL is legacy/internal full operator scope; externally created schedules carry their fixed account scope.
      return { principalId: SCHEDULE_PRINCIPAL_ID,
        scope: context.accountScope === null ? { kind: 'full' } : { kind: 'accounts', accountIds: context.accountScope },
        permissions: allPermissions('ALLOW'), history: { allowed: false, shared: null } };
    }
    if (context.sourceType === 'ui') {
      return { principalId: 'internal:ui', scope: { kind: 'full' }, permissions: allPermissions('ALLOW'),
        history: { allowed: true, shared: includeHistory ? await findSharedAdminChat(client) : null } };
    }
    const jobResult = await client.query<{
      job_id: string;
      account_id: string;
      chat_type: ConversationKey['chatType'];
      chat_id: string;
      source_type: string;
      source_message_id: string | null;
      direct_friend_grant_id: string | null;
      direct_friend_grant_version: string | number | null;
      room_agent_grant_id: string | null;
      room_agent_grant_version: string | number | null;
      free_mode: boolean;
    }>(
      `SELECT job_id, account_id, chat_type, chat_id, source_type, source_message_id, direct_friend_grant_id, direct_friend_grant_version,
              room_agent_grant_id, room_agent_grant_version, free_mode
       FROM agent_jobs
       WHERE job_id = $1`,
      [context.jobId],
    );
    const job = jobResult.rows[0];
    if (!job || job.source_type !== 'line' || !job.source_message_id) {
      return this.rejectInternal(client, toolName, [], 'Internal MCP archive queries are restricted to authorized LINE-origin Agent jobs and the local console UI.');
    }
    if (job.free_mode) {
      // Group free mode: always the room-member principal, even when the batch contains the administrator's messages.
      // Only the stored room grant is rechecked (there is no per-sender friend grant); permissions are the default member rules.
      const roomStillAuthorized = job.chat_type !== 'direct' && job.room_agent_grant_id !== null && job.room_agent_grant_version !== null
        && await lockAndCheckRoomAgentGrant(client, job.account_id, job.chat_type, job.chat_id,
          { grantId: job.room_agent_grant_id, version: Number(job.room_agent_grant_version) });
      if (!roomStillAuthorized) return this.rejectInternal(client, toolName, [job.account_id], 'The Agent job grant is no longer active.');
      const memberPermissions = await resolveUserPermissions(client, job.account_id, FREE_MODE_MEMBER_ID,
        { chatType: job.chat_type, chatId: job.chat_id });
      const memberAccountWide = memberPermissions['records.query_all_chats'] === 'ALLOW';
      return {
        principalId: (memberAccountWide ? `internal:account_scoped:${job.account_id}` : `internal:chat_scoped:${job.chat_type}:${job.chat_id}`).slice(0, 128),
        scope: memberAccountWide
          ? { kind: 'account', accountId: job.account_id }
          : { kind: 'chat', accountId: job.account_id, chatType: job.chat_type, chatId: job.chat_id, linkedChats: [] },
        permissions: memberPermissions,
        history: { allowed: false, shared: null },
      };
    }
    const adminUserId = await findPrimaryAdminUser(client, job.account_id, job.source_message_id);
    if (adminUserId) {
      // History access: only the admin-direct chat the Agent room currently shares, re-derived on every call.
      const shared = includeHistory && job.chat_type === 'direct' ? await findSharedAdminChat(client) : null;
      const sharedHere = shared !== null && shared.accountId === job.account_id && shared.adminMid === job.chat_id;
      return { principalId: `internal:primary_admin:${adminUserId}`, scope: { kind: 'full' }, permissions: allPermissions('ALLOW'),
        history: { allowed: sharedHere, shared: sharedHere ? shared : null } };
    }
    // Whitelisted friend (1:1) or Agent-enabled group member: only while the stored grants still pass the same
    // predicate message admission uses; the effective permissions then decide the scope (current chat by default).
    if (job.direct_friend_grant_id !== null || job.room_agent_grant_id !== null) {
      const sender = (await client.query<{ sender_id: string }>(
        'SELECT sender_id FROM messages WHERE account_id = $1 AND message_id = $2', [job.account_id, job.source_message_id],
      )).rows[0];
      const stillAuthorized = !!sender && job.direct_friend_grant_id !== null && job.direct_friend_grant_version !== null
        && await lockAndCheckAgentAuthorization(client, job.account_id, job.chat_type, job.chat_id, sender.sender_id, {
          directGrantId: job.direct_friend_grant_id,
          directGrantVersion: Number(job.direct_friend_grant_version),
          ...(job.room_agent_grant_id !== null ? { roomGrantId: job.room_agent_grant_id } : {}),
          ...(job.room_agent_grant_version !== null ? { roomGrantVersion: Number(job.room_agent_grant_version) } : {}),
        });
      if (!stillAuthorized) {
        return this.rejectInternal(client, toolName, [job.account_id], 'The Agent job grant is no longer active.');
      }
      // Same transaction as the grant recheck; job-row data only (sender, account), never tool arguments.
      const permissions = await resolveUserPermissions(client, job.account_id, sender!.sender_id,
        { chatType: job.chat_type, chatId: job.chat_id });
      const accountWide = permissions['records.query_all_chats'] === 'ALLOW';
      return {
        // Audit rows carry the scope in the principal (column limit 128 chars).
        principalId: (accountWide ? `internal:account_scoped:${job.account_id}` : `internal:chat_scoped:${job.chat_type}:${job.chat_id}`).slice(0, 128),
        scope: accountWide
          ? { kind: 'account', accountId: job.account_id }
          : { kind: 'chat', accountId: job.account_id, chatType: job.chat_type, chatId: job.chat_id,
              linkedChats: await resolveLinkedChats(client, job.account_id, sender!.sender_id) },
        permissions,
        history: { allowed: false, shared: null },
      };
    }
    return this.rejectInternal(client, toolName, [job.account_id], 'Only the verified Primary Administrator or a granted chat participant may invoke internal MCP archive queries from LINE.');
  }

  /** Per-request durable authority recheck for non-tool MCP methods (initialize, tools/list). */
  async verifyInternalAgent(input: { context: InternalAgentExecutionContext; signal?: AbortSignal }): Promise<EffectivePermissions> {
    return (await this.verifyInternalAgentAccess(input)).permissions;
  }

  /**
   * Like verifyInternalAgent, plus whether the Agent room history and LINE send tools may be listed (hints; tools/call
   * re-checks). `lineSend` is true only for the Primary Admin and the desktop operator (internal:ui).
   */
  async verifyInternalAgentAccess(input: { context: InternalAgentExecutionContext; signal?: AbortSignal }): Promise<{ permissions: EffectivePermissions; roomHistory: boolean; lineSend: boolean }> {
    return this.withMcpTransaction(input.signal, async (client) => {
      const resolved = await this.resolveInternalPrincipal(client, input.context, null, true);
      return { permissions: resolved.permissions, roomHistory: resolved.history.allowed, lineSend: mayLineSend(resolved.principalId) };
    });
  }

  async executeForInternalAgent<T>(input: {
    context: InternalAgentExecutionContext;
    toolName: McpInternalToolName;
    requestedAccountId?: string;
    /** Explicit chat the tool call asks for; a chat-scoped job asking for any other chat is denied. */
    requestedChat?: { chatType?: ConversationKey['chatType']; chatId?: string };
    signal?: AbortSignal;
    execute: (context: {
      client: PoolClient;
      principalId: string;
      authorizedAccountIds: string[];
      /** Present for chat-scoped jobs; must be passed to the message queries so SQL enforces it. */
      conversationScope?: ConversationKey;
      /** Linked-folder chats that stay visible next to conversationScope; pass both to the message queries. */
      extraConversationScopes?: ReadonlyArray<Pick<ConversationKey, 'chatType' | 'chatId'>>;
      /** True for every non-admin principal: names come from each member's own LINE display name, never the owner's nickname. */
      ownLineNamesOnly: boolean;
      /** Present for schedule jobs; null is full operator scope and an array is the persisted account fence. */
      accountScope?: readonly string[] | null;
      /** Agent room history only: the admin-direct chat shared at this call, or null; pass to queryAgentRoomHistory. */
      sharedAdminChat?: SharedAdminChat | null;
    }) => Promise<{ data: T; resultCount?: number }>;
  }): Promise<T> {
    return this.withMcpTransaction(input.signal, async (client) => {

      const { principalId, scope, permissions, history } = await this.resolveInternalPrincipal(client, input.context, input.toolName);

      // Agent room history: the Agent room (internal:ui) or the admin-direct LINE job while the room shares that chat.
      // Re-derived from durable state on every call; tools/list is only a hint.
      if (input.toolName === AGENT_ROOM_HISTORY_TOOL_NAME) {
        if (!history.allowed) {
          await this.insertAudit(client, {
            tokenId: null, principalId, initiator: 'internal_agent', action: 'AUTH_REJECTED', toolName: input.toolName,
            accountScopes: scope.kind === 'accounts' ? [...scope.accountIds] : [], grantVersion: null, disposition: 'PERMISSION_DENIED', resultCount: null,
          });
          await client.query('COMMIT');
          throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
        }
        const { data, resultCount } = await input.execute({
          client, principalId, authorizedAccountIds: [], ownLineNamesOnly: false, sharedAdminChat: history.shared,
        });
        await this.insertAudit(client, {
          tokenId: null, principalId, initiator: 'internal_agent', action: 'TOOL_CALLED', toolName: input.toolName,
          accountScopes: scope.kind === 'accounts' ? [...scope.accountIds] : [], grantVersion: null, disposition: 'ALLOWED', resultCount: resultCount ?? null,
        });
        return data;
      }

      // Agent LINE send tools: only the Primary Admin and the desktop operator, re-derived on every call. The tool body
      // authorizes inside this transaction; any LINE effect happens after it commits, outside any transaction.
      // Schedule tools share the send tools' principals (Primary Admin and desktop operator only).
      if (input.toolName === LIST_SEND_TARGETS_TOOL_NAME || input.toolName === SEND_TO_TARGET_TOOL_NAME || isScheduleToolName(input.toolName)) {
        if (!mayLineSend(principalId)) {
          await this.insertAudit(client, {
            tokenId: null, principalId, initiator: 'internal_agent', action: 'AUTH_REJECTED', toolName: input.toolName,
            accountScopes: scope.kind === 'accounts' ? [...scope.accountIds] : [], grantVersion: null, disposition: 'PERMISSION_DENIED', resultCount: null,
          });
          await client.query('COMMIT');
          throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
        }
        let authorizedAccountIds: string[] = [];
        let effectiveAccountScope: string[] | null = null;
        if (scope.kind === 'accounts') {
          const requested = input.requestedAccountId?.trim();
          const live = (await client.query<{ account_id: string }>("SELECT account_id FROM line_accounts WHERE product_role = ANY($1::text[]) AND mode <> 'PAUSED' AND account_id = ANY($2::text[]) ORDER BY account_id ASC", [['AGENT', 'PRIMARY_ADMIN'], scope.accountIds])).rows.map((row) => row.account_id);
          effectiveAccountScope = live;
          if (requested && !live.includes(requested)) return this.rejectInternal(client, input.toolName, [requested], 'This scheduled Agent job may only access its authorized LINE accounts.');
          const agentAccount = (await client.query<{ account_id: string }>("SELECT account_id FROM line_accounts WHERE product_role = 'AGENT' AND connection_mode = 'SYSTEM_LOGIN' LIMIT 1")).rows[0]?.account_id ?? null;
          if ((input.toolName === LIST_SEND_TARGETS_TOOL_NAME || input.toolName === SEND_TO_TARGET_TOOL_NAME) && (!agentAccount || !scope.accountIds.includes(agentAccount) || !live.includes(agentAccount))) {
            return this.rejectInternal(client, input.toolName, agentAccount ? [agentAccount] : [], 'This scheduled Agent job may not send from an account outside its authorized scope.');
          }
          authorizedAccountIds = requested ? [requested] : live;
        }
        const { data, resultCount } = await input.execute({
          client, principalId, authorizedAccountIds, ownLineNamesOnly: false,
          accountScope: effectiveAccountScope,
        });
        await this.insertAudit(client, {
          tokenId: null, principalId, initiator: 'internal_agent', action: 'TOOL_CALLED', toolName: input.toolName,
          accountScopes: scope.kind === 'accounts' ? [...scope.accountIds] : [], grantVersion: null, disposition: 'ALLOWED', resultCount: resultCount ?? null,
        });
        return data;
      }

      // The tool's permission is re-resolved on every call and is the authority; tools/list is only a hint.
      if (!MCP_TOOL_PERMISSIONS[input.toolName as McpToolName].some((permission) => permissions[permission] === 'ALLOW')) {
        await this.insertAudit(client, {
          tokenId: null,
          principalId,
          initiator: 'internal_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: scope.kind === 'full' ? [] : scope.kind === 'accounts' ? [...scope.accountIds] : [scope.accountId],
          grantVersion: null,
          disposition: 'PERMISSION_DENIED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
      }

      const deny = async (accountScopes: string[], message: string): Promise<never> => {
        await this.insertAudit(client, {
          tokenId: null,
          principalId,
          initiator: 'internal_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes,
          grantVersion: null,
          disposition: 'SCOPE_DENIED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('SCOPE_DENIED', message);
      };

      const accountsResult = await client.query<{ account_id: string }>(
        "SELECT account_id FROM line_accounts WHERE mode <> 'PAUSED' ORDER BY account_id ASC",
      );
      const nonPausedAccounts = accountsResult.rows.map((row) => row.account_id);
      const requestedAccount = input.requestedAccountId?.trim();
      if (scope.kind === 'accounts') {
        const scopedLive = (await client.query<{ account_id: string }>(
          "SELECT account_id FROM line_accounts WHERE product_role = ANY($1::text[]) AND mode <> 'PAUSED' AND account_id = ANY($2::text[]) ORDER BY account_id ASC",
          [['AGENT', 'PRIMARY_ADMIN'], scope.accountIds],
        )).rows.map((row) => row.account_id);
        if (requestedAccount && !scopedLive.includes(requestedAccount)) return deny([requestedAccount], 'This scheduled Agent job may only query records of its authorized LINE accounts.');
        const authorizedAccountIds = requestedAccount ? [requestedAccount] : scopedLive;
        const { data, resultCount } = await input.execute({ client, principalId, authorizedAccountIds, ownLineNamesOnly: false,
          accountScope: scopedLive });
        await this.insertAudit(client, { tokenId: null, principalId, initiator: 'internal_agent', action: 'TOOL_CALLED', toolName: input.toolName,
          accountScopes: authorizedAccountIds, grantVersion: null, disposition: 'ALLOWED', resultCount: resultCount ?? null });
        return data;
      }
      // Chat-scoped principals get one uniform denial (below) so error text never reveals whether another account exists.
      if (scope.kind === 'full' && requestedAccount && !nonPausedAccounts.includes(requestedAccount)) {
        await this.insertAudit(client, {
          tokenId: null,
          principalId,
          initiator: 'internal_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: [requestedAccount],
          grantVersion: null,
          disposition: 'SCOPE_DENIED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError(
          'SCOPE_DENIED',
          `Requested LINE account "${requestedAccount}" is unavailable or paused.`,
        );
      }

      let conversationScope: ConversationKey | undefined;
      let extraConversationScopes: ReadonlyArray<Pick<ConversationKey, 'chatType' | 'chatId'>> = [];
      if (scope.kind === 'account') {
        if (!nonPausedAccounts.includes(scope.accountId) || (requestedAccount && requestedAccount !== scope.accountId)) {
          return deny([scope.accountId], 'This Agent job may only query records of its own LINE account.');
        }
      } else if (scope.kind === 'chat') {
        const requestedChat = input.requestedChat;
        const visible = [{ chatType: scope.chatType, chatId: scope.chatId }, ...scope.linkedChats];
        const requestedId = requestedChat?.chatId?.trim();
        if (
          !nonPausedAccounts.includes(scope.accountId)
          || (requestedAccount && requestedAccount !== scope.accountId)
          || (requestedChat?.chatType && !visible.some((chat) => chat.chatType === requestedChat.chatType))
          || (requestedId && !visible.some((chat) => chat.chatId === requestedId
            && (!requestedChat?.chatType || chat.chatType === requestedChat.chatType)))
        ) {
          return deny([scope.accountId], 'This Agent job may only query records of its own chat room.');
        }
        conversationScope = { accountId: scope.accountId, chatType: scope.chatType, chatId: scope.chatId };
        extraConversationScopes = scope.linkedChats;
      }

      const authorizedAccountIds = scope.kind === 'chat' || scope.kind === 'account'
        ? [scope.accountId]
        : requestedAccount ? [requestedAccount] : nonPausedAccounts;
      const { data, resultCount } = await input.execute({
        client,
        principalId,
        authorizedAccountIds,
        ownLineNamesOnly: scope.kind !== 'full',
        ...(conversationScope ? { conversationScope } : {}),
        ...(extraConversationScopes.length > 0 ? { extraConversationScopes } : {}),
      });

      await this.insertAudit(client, {
        tokenId: null,
        principalId,
        initiator: 'internal_agent',
        action: 'TOOL_CALLED',
        toolName: input.toolName,
        accountScopes: authorizedAccountIds,
        grantVersion: null,
        disposition: 'ALLOWED',
        resultCount: resultCount ?? null,
      });

      return data;
    });
  }

  async recordAudit(entry: {
    tokenId: string | null;
    principalId: string;
    initiator: 'user' | 'external_agent' | 'internal_agent';
    action: 'TOKEN_ISSUED' | 'TOKEN_REVOKED' | 'TOOL_CALLED' | 'AUTH_REJECTED';
    toolName: McpInternalToolName | null;
    accountScopes: readonly string[];
    grantVersion: number | null;
    disposition: McpAuditRecord['disposition'];
    resultCount: number | null;
  }): Promise<void> {
    await this.insertAudit(this.pool, entry);
  }

  async listAuditRecords(limit = 100): Promise<McpAuditRecord[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const result = await this.pool.query<{
      audit_id: string;
      token_id: string | null;
      principal_id: string;
      initiator: McpAuditRecord['initiator'];
      action: McpAuditRecord['action'];
      tool_name: McpInternalToolName | null;
      account_scopes: string[];
      grant_version: string | null;
      disposition: McpAuditRecord['disposition'];
      result_count: number | null;
      occurred_at: Date;
    }>(
      `SELECT audit_id, token_id, principal_id, initiator, action, tool_name,
              account_scopes, grant_version, disposition, result_count, occurred_at
       FROM mcp_agent_audit
       ORDER BY occurred_at DESC, audit_id DESC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      auditId: Number(row.audit_id),
      tokenId: row.token_id,
      principalId: row.principal_id,
      initiator: row.initiator,
      action: row.action,
      toolName: row.tool_name,
      accountScopes: row.account_scopes ?? [],
      grantVersion: row.grant_version === null ? null : Number(row.grant_version),
      disposition: row.disposition,
      resultCount: row.result_count,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }

  private async insertAudit(
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    entry: {
      tokenId: string | null;
      principalId: string;
      initiator: 'user' | 'external_agent' | 'internal_agent';
      action: 'TOKEN_ISSUED' | 'TOKEN_REVOKED' | 'TOOL_CALLED' | 'AUTH_REJECTED';
      toolName: McpInternalToolName | null;
      accountScopes: readonly string[];
      grantVersion: number | null;
      disposition: McpAuditRecord['disposition'];
      resultCount: number | null;
    },
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO mcp_agent_audit (
         token_id, principal_id, initiator, action, tool_name,
         account_scopes, grant_version, disposition, result_count
       )
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)`,
      [
        entry.tokenId,
        entry.principalId.trim().slice(0, 128) || 'unknown',
        entry.initiator,
        entry.action,
        entry.toolName,
        [...entry.accountScopes],
        entry.grantVersion,
        entry.disposition,
        entry.resultCount,
      ],
    );
  }
}
