import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AGENT_ROOM_HISTORY_TOOL_NAME, LIST_SEND_TARGETS_TOOL_NAME, SEND_TO_TARGET_TOOL_NAME, isScheduleToolName, MCP_TOOL_EFFECTS, MCP_TOOL_PERMISSIONS, MAX_MCP_TOOL_SCOPES, McpTokenExpirationSchema, McpToolNameSchema, type McpInternalToolName, type EffectivePermissions, type ConversationKey, type McpTokenExpiration, type McpTokenSummary, type McpToolName } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { lockAndCheckAgentAuthorization, lockAndCheckRoomAgentGrant } from './agent-authorization.js';
import { findSharedAdminChat, type SharedAdminChat } from './agent-repository.js';
import { FREE_MODE_MEMBER_ID, allPermissions, findPrimaryAdminUser, resolveLinkedChats, resolveUserPermissions } from './agent-permissions.js';
import { LOCAL_CLIENT_PRINCIPALS, parseRoleScope, normalizeManagedMcpScopes, type ProductRole } from './managed-mcp-scopes.js';

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
  /** `records.query_all_chats` ALLOW: every chat of the job's own account, the only widening past the current chat. */
  | { kind: 'account'; accountId: string }
  /** The job's own chat plus the group/room chats of the user's linked folders. */
  | { kind: 'chat'; accountId: string; chatType: ConversationKey['chatType']; chatId: string;
      linkedChats: ReadonlyArray<Pick<ConversationKey, 'chatType' | 'chatId'>> };

export type InternalAgentExecutionContext =
  | { sourceType: 'ui'; requestId?: string }
  | { sourceType: 'line'; jobId: string }
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

interface TokenRow {
  token_id: string;
  token_digest?: Buffer;
  principal_id: string;
  device_label: string;
  account_scopes: string[];
  tool_scopes: McpToolName[];
  grant_version: string;
  state: 'ACTIVE' | 'REVOKED';
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

function toTokenSummary(row: TokenRow): McpTokenSummary {
  return {
    tokenId: row.token_id,
    principalId: row.principal_id,
    deviceLabel: row.device_label,
    accountScopes: row.account_scopes,
    toolScopes: row.tool_scopes,
    grantVersion: Number(row.grant_version),
    state: row.state,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function generateMcpPlaintextToken(): string {
  return `la_mcp_${randomBytes(32).toString('base64url')}`;
}

export function hashMcpBearerToken(plaintextToken: string): Buffer {
  return createHash('sha256').update(plaintextToken, 'utf8').digest();
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

  async issueToken(input: {
    deviceLabel: string;
    principalId?: string;
    accountScopes: readonly string[];
    toolScopes: readonly McpToolName[];
    expiration: McpTokenExpiration;
    plaintextToken?: string;
  }): Promise<{ token: McpTokenSummary; plaintextToken: string }> {
    const deviceLabel = input.deviceLabel.trim();
    if (!deviceLabel || deviceLabel.length > 120) {
      throw new McpDomainError('INVALID_INPUT', 'Device label must be 1..120 characters.');
    }
    const tokenId = randomUUID();
    const principalId =
      input.principalId?.trim() || `external:${deviceLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48)}:${tokenId.slice(0, 8)}`;
    const accountScopes = [...new Set(input.accountScopes.map((id) => id.trim()).filter(Boolean))];
    const roleScopes = accountScopes.filter((scope) => parseRoleScope(scope) !== null);
    if (roleScopes.length > 0 && !LOCAL_CLIENT_PRINCIPALS.has(principalId)) {
      throw new McpDomainError('MCP_INVALID_ACCOUNT_SCOPE', 'Stable role scopes are reserved for managed local clients.');
    }
    if (LOCAL_CLIENT_PRINCIPALS.has(principalId)
      && accountScopes.some((scope) => parseRoleScope(scope) === null)) {
      throw new McpDomainError('MCP_INVALID_ACCOUNT_SCOPE', 'Managed local clients must use stable role scopes.');
    }
    const toolScopes = [...new Set(input.toolScopes)];
    // External scopes may only name external tools; the Agent room history tool is internal-only.
    if (toolScopes.some((tool) => !McpToolNameSchema.safeParse(tool).success)) {
      throw new McpDomainError('INVALID_INPUT', 'Unsupported MCP tool scope.');
    }
    if (accountScopes.length === 0 || toolScopes.length === 0 || toolScopes.length > MAX_MCP_TOOL_SCOPES) {
      throw new McpDomainError('INVALID_INPUT', 'At least one account scope and 1..64 supported tool scopes are required.');
    }
    const expiration = McpTokenExpirationSchema.safeParse(input.expiration);
    if (!expiration.success) throw new McpDomainError('INVALID_INPUT', 'Invalid token expiration.');
    const expiresInHours = expiration.data.mode === 'limited' ? expiration.data.hours : null;
    const plaintextToken = input.plaintextToken ?? generateMcpPlaintextToken();
    if (!/^la_mcp_[A-Za-z0-9_-]{43}$/.test(plaintextToken)) {
      throw new McpDomainError('INVALID_INPUT', 'Invalid MCP token format.');
    }
    const tokenDigest = hashMcpBearerToken(plaintextToken);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");

      const concreteScopes = accountScopes.filter((scope) => parseRoleScope(scope) === null);
      const existingAccounts = await client.query<{ account_id: string }>(
        'SELECT account_id FROM line_accounts WHERE account_id = ANY($1::text[]) FOR SHARE',
        [concreteScopes],
      );
      if (existingAccounts.rowCount !== concreteScopes.length) {
        throw new McpDomainError(
          'MCP_INVALID_ACCOUNT_SCOPE',
          'One or more requested LINE account scopes do not exist.',
        );
      }

      const inserted = await client.query<TokenRow>(
        `INSERT INTO mcp_agent_tokens (
           token_id, token_digest, principal_id, device_label,
           account_scopes, tool_scopes, grant_version, state, expires_at
         )
         VALUES ($1, $2, $3, $4, $5::text[], $6::text[], 1, 'ACTIVE',
                 CASE WHEN $7::integer IS NULL THEN NULL ELSE clock_timestamp() + ($7 * interval '1 hour') END)
         RETURNING token_id, principal_id, device_label, account_scopes, tool_scopes,
                   grant_version, state, expires_at, revoked_at, last_used_at, created_at`,
        [tokenId, tokenDigest, principalId, deviceLabel, accountScopes, toolScopes, expiresInHours],
      );
      const row = inserted.rows[0]!;

      await this.insertAudit(client, {
        tokenId: row.token_id,
        principalId: row.principal_id,
        initiator: 'user',
        action: 'TOKEN_ISSUED',
        toolName: null,
        accountScopes: row.account_scopes,
        grantVersion: Number(row.grant_version),
        disposition: 'ISSUED',
        resultCount: null,
      });

      await client.query('COMMIT');
      return { token: toTokenSummary(row), plaintextToken };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listTokens(): Promise<McpTokenSummary[]> {
    const result = await this.pool.query<TokenRow>(
      `SELECT token_id, principal_id, device_label, account_scopes, tool_scopes,
              grant_version, state, expires_at, revoked_at, last_used_at, created_at
       FROM mcp_agent_tokens
       ORDER BY created_at DESC, token_id DESC`,
    );
    return result.rows.map(toTokenSummary);
  }

  async normalizeManagedLocalClientScopes(): Promise<void> {
    await this.withMcpTransaction(undefined, normalizeManagedMcpScopes);
  }

  async findTokenByBearerToken(plaintextToken: string): Promise<McpTokenSummary | null> {
    if (!/^la_mcp_[A-Za-z0-9_-]{43}$/.test(plaintextToken)) return null;
    const digest = hashMcpBearerToken(plaintextToken);
    const result = await this.pool.query<TokenRow>(
      `SELECT token_id, principal_id, device_label, account_scopes, tool_scopes,
              grant_version, state, expires_at, revoked_at, last_used_at, created_at
       FROM mcp_agent_tokens WHERE token_digest = $1`, [digest],
    );
    const row = result.rows[0];
    return row ? toTokenSummary(row) : null;
  }

  async countActiveTokens(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM mcp_agent_tokens
       WHERE state = 'ACTIVE' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");

      const locked = await client.query<TokenRow>(
        `SELECT token_id, principal_id, device_label, account_scopes, tool_scopes,
                grant_version, state, expires_at, revoked_at, last_used_at, created_at
         FROM mcp_agent_tokens
         WHERE token_id = $1
         FOR UPDATE`,
        [tokenId],
      );
      const current = locked.rows[0];
      if (!current || current.state === 'REVOKED') {
        await client.query('COMMIT');
        return false;
      }

      const updated = await client.query<{ grant_version: string }>(
        `UPDATE mcp_agent_tokens
         SET state = 'REVOKED',
             revoked_at = clock_timestamp(),
             grant_version = grant_version + 1
         WHERE token_id = $1 AND state = 'ACTIVE'
         RETURNING grant_version`,
        [tokenId],
      );
      if (updated.rowCount !== 1) {
        await client.query('COMMIT');
        return false;
      }

      const nextGrantVersion = Number(updated.rows[0]!.grant_version);
      await this.insertAudit(client, {
        tokenId: current.token_id,
        principalId: current.principal_id,
        initiator: 'user',
        action: 'TOKEN_REVOKED',
        toolName: null,
        accountScopes: current.account_scopes,
        grantVersion: nextGrantVersion,
        disposition: 'REVOKED_BY_OPERATOR',
        resultCount: null,
      });

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async executeWithVerifiedToken<T>(input: {
    bearerToken: string;
    toolName: McpInternalToolName | null;
    requestedAccountId?: string;
    rateLimiter?: (tokenId: string) => boolean;
    signal?: AbortSignal;
    execute: (context: {
      client: PoolClient;
      tokenId: string;
      principalId: string;
      grantVersion: number;
      authorizedAccountIds: string[];
      toolScopes: McpToolName[];
    }) => Promise<{ data: T; resultCount?: number }>;
  }): Promise<T> {
    const trimmedToken = input.bearerToken.trim();
    return this.withMcpTransaction(input.signal, async (client) => {

      if (!/^la_mcp_[A-Za-z0-9_-]{43}$/.test(trimmedToken)) {
        await this.insertAudit(client, {
          tokenId: null,
          principalId: 'unknown',
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: [],
          grantVersion: null,
          disposition: 'AUTH_INVALID',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('AUTH_INVALID', 'Invalid or missing MCP bearer token.');
      }

      const digest = hashMcpBearerToken(trimmedToken);

      // Step 1: Lock-Free Snapshot Pre-Check (no FOR SHARE so concurrent same-token queries never upgrade-deadlock)
      const snapshot = await client.query<TokenRow & { is_expired: boolean }>(
        `SELECT token_id, token_digest, principal_id, device_label, account_scopes, tool_scopes,
                grant_version, state, expires_at, revoked_at, last_used_at, created_at,
                COALESCE(expires_at <= clock_timestamp(), false) AS is_expired
         FROM mcp_agent_tokens
         WHERE token_digest = $1`,
        [digest],
      );
      let row = snapshot.rows[0];

      // Step 2: Digest Check
      if (
        !row?.token_digest ||
        row.token_digest.byteLength !== digest.byteLength ||
        !timingSafeEqual(row.token_digest, digest)
      ) {
        await this.insertAudit(client, {
          tokenId: null,
          principalId: 'unknown',
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: [],
          grantVersion: null,
          disposition: 'AUTH_INVALID',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('AUTH_INVALID', 'Invalid or unrecognized MCP bearer token.');
      }

      if (LOCAL_CLIENT_PRINCIPALS.has(row.principal_id) && row.account_scopes.some((scope) => parseRoleScope(scope) === null)) {
        await normalizeManagedMcpScopes(client);
        row = (await client.query<TokenRow & { is_expired: boolean }>(
          `SELECT *,COALESCE(expires_at<=clock_timestamp(),false) is_expired FROM mcp_agent_tokens WHERE token_id=$1`, [row.token_id])).rows[0]!;
      }
      const grantVersion = Number(row.grant_version);

      // Step 3: Revocation Check
      if (row.state !== 'ACTIVE' || row.revoked_at !== null) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: row.account_scopes,
          grantVersion,
          disposition: 'REVOKED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('REVOKED', 'MCP bearer token has been revoked.');
      }

      // Step 4: Expiry Check
      if (row.is_expired) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: row.account_scopes,
          grantVersion,
          disposition: 'EXPIRED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('EXPIRED', 'MCP bearer token has expired.');
      }

      // Optional per-token rate limit check after token identity is verified
      if (input.rateLimiter && !input.rateLimiter(row.token_id)) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: row.account_scopes,
          grantVersion,
          disposition: 'RATE_LIMITED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('RATE_LIMITED', 'Per-token MCP request rate limit exceeded.');
      }

      // Internal-only tools (Agent room history, LINE send) are never available to an external token.
      const externalTool = input.toolName === null ? null : McpToolNameSchema.safeParse(input.toolName);
      if (input.toolName !== null && externalTool && !externalTool.success) {
        await this.insertAudit(client, {
          tokenId: row.token_id, principalId: row.principal_id, initiator: 'external_agent',
          action: 'AUTH_REJECTED', toolName: input.toolName, accountScopes: row.account_scopes,
          grantVersion, disposition: 'SCOPE_DENIED', resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('SCOPE_DENIED', `Token is not authorized for tool "${input.toolName}".`);
      }

      // Approval is fail-closed for every tool without an explicit read classification.
      if (input.toolName !== null && externalTool?.success && MCP_TOOL_EFFECTS[externalTool.data] !== 'read') {
        await this.insertAudit(client, {
          tokenId: row.token_id, principalId: row.principal_id, initiator: 'external_agent',
          action: 'AUTH_REJECTED', toolName: input.toolName, accountScopes: row.account_scopes,
          grantVersion, disposition: 'APPROVAL_REQUIRED', resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('APPROVAL_REQUIRED', 'Operator approval is required for this MCP tool.');
      }

      // Step 5: Tool Scope Check
      if (input.toolName !== null && externalTool?.success && !row.tool_scopes.includes(externalTool.data)) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: row.account_scopes,
          grantVersion,
          disposition: 'SCOPE_DENIED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError(
          'SCOPE_DENIED',
          `Token is not authorized for tool "${input.toolName}".`,
        );
      }

      // Step 6: Account Scope Check
      const requestedAccount = input.requestedAccountId?.trim();
      const hasRoleScopes = row.account_scopes.some((scope) => parseRoleScope(scope) !== null);
      if (hasRoleScopes && !LOCAL_CLIENT_PRINCIPALS.has(row.principal_id)) {
        throw new McpDomainError('SCOPE_DENIED', 'Stable role scopes are reserved for managed local clients.');
      }
      const concreteAccountIds = row.account_scopes.filter((scope) => parseRoleScope(scope) === null);
      if (LOCAL_CLIENT_PRINCIPALS.has(row.principal_id) && concreteAccountIds.length > 0) {
        throw new McpDomainError('SCOPE_DENIED', 'Managed local clients require stable role scopes.');
      }
      const roleScopes = row.account_scopes.flatMap((scope) => {
        const role = parseRoleScope(scope);
        return role ? [role] : [];
      });
      const existingAccounts = await client.query<{ account_id: string; control_epoch: string; product_role: ProductRole | null }>(
        `SELECT a.account_id, c.control_epoch, a.product_role
         FROM line_accounts a CROSS JOIN account_control c
         WHERE (a.account_id = ANY($1::text[]) OR a.product_role = ANY($2::text[]))
           AND a.mode <> 'PAUSED' AND c.singleton = true
         ORDER BY a.account_id ASC`,
        [concreteAccountIds, roleScopes],
      );
      const resolvedAccountIds = existingAccounts.rows.map((item) => item.account_id);
      if (requestedAccount && !resolvedAccountIds.includes(requestedAccount)) {
        await this.insertAudit(client, { tokenId: row.token_id, principalId: row.principal_id, initiator: 'external_agent',
          action: 'AUTH_REJECTED', toolName: input.toolName, accountScopes: [requestedAccount], grantVersion,
          disposition: 'SCOPE_DENIED', resultCount: null });
        await client.query('COMMIT');
        throw new McpDomainError('SCOPE_DENIED', `Token is not authorized for LINE account "${requestedAccount}".`);
      }
      const authorizedAccountIds = requestedAccount ? [requestedAccount] : resolvedAccountIds;
      const resolvedRoleBindings = existingAccounts.rows.filter((account) => account.product_role !== null
        && roleScopes.includes(account.product_role) && authorizedAccountIds.includes(account.account_id));
      const controlEpoch = existingAccounts.rows[0]?.control_epoch;
      if (authorizedAccountIds.length === 0) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: row.account_scopes,
          grantVersion,
          disposition: 'SCOPE_DENIED',
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError('SCOPE_DENIED', 'No authorized LINE accounts remain active for this token.');
      }

      // Step 7: Scoped Read Query
      let data: T;
      let resultCount: number | undefined;
      try {
        ({ data, resultCount } = await input.execute({
          client,
          tokenId: row.token_id,
          principalId: row.principal_id,
          grantVersion,
          authorizedAccountIds,
          toolScopes: row.tool_scopes,
        }));
      } catch (stepError) {
        if (stepError instanceof McpDomainError && stepError.code === 'INVALID_INPUT') {
          await this.insertAudit(client, {
            tokenId: row.token_id,
            principalId: row.principal_id,
            initiator: 'external_agent',
            action: 'AUTH_REJECTED',
            toolName: input.toolName,
            accountScopes: authorizedAccountIds,
            grantVersion,
            disposition: 'INVALID_INPUT',
            resultCount: null,
          });
          await client.query('COMMIT');
        }
        throw stepError;
      }


      // Step 8: acquire the token mutation lock first. The UPDATE may wait, so its statement snapshot
      // cannot establish account authority. Recheck with fresh statements after the wait, then hold
      // control -> account locks only until COMMIT (never across the protected read).
      const fenced = await client.query<{ token_id: string; grant_version: string }>(
        `UPDATE mcp_agent_tokens
         SET last_used_at = clock_timestamp()
         WHERE token_id = $1
           AND grant_version = $2
           AND state = 'ACTIVE'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
         RETURNING token_id, grant_version`,
        [row.token_id, grantVersion],
      );
      let authorityCurrent = false;
      if (fenced.rowCount !== 0) {
        const currentControl = (await client.query<{ control_epoch: string }>(
          'SELECT control_epoch FROM account_control WHERE singleton=true FOR SHARE')).rows[0];
        const currentAccounts = (await client.query<{ account_id: string; product_role: ProductRole | null; mode: string }>(
          `SELECT account_id,product_role,mode FROM line_accounts WHERE account_id=ANY($1::text[])
           ORDER BY CASE product_role WHEN 'PRIMARY_ADMIN' THEN 0 WHEN 'AGENT' THEN 1 ELSE 2 END,account_id FOR SHARE`,
          [authorizedAccountIds])).rows;
        authorityCurrent = currentControl?.control_epoch === controlEpoch
          && currentAccounts.length === authorizedAccountIds.length && currentAccounts.every((account) => account.mode !== 'PAUSED')
          && resolvedRoleBindings.every((expected) => currentAccounts.some((account) => account.account_id === expected.account_id
            && account.product_role === expected.product_role));
      }
      if (fenced.rowCount === 0 || !authorityCurrent) {
        const postCheck = await client.query<{
          state: 'ACTIVE' | 'REVOKED';
          revoked_at: Date | null;
          grant_version: string;
          is_expired: boolean;
        }>(
          'SELECT state, revoked_at, grant_version, COALESCE(expires_at <= clock_timestamp(), false) AS is_expired FROM mcp_agent_tokens WHERE token_id = $1',
          [row.token_id],
        );
        const latest = postCheck.rows[0];
        const isRevoked = !latest || latest.state === 'REVOKED' || latest.revoked_at !== null;
        const isExpired = Boolean(latest?.is_expired);
        const disposition = isRevoked ? 'REVOKED' : isExpired ? 'EXPIRED' : 'CONTROL_CHANGED';
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'AUTH_REJECTED',
          toolName: input.toolName,
          accountScopes: authorizedAccountIds,
          grantVersion: latest ? Number(latest.grant_version) : grantVersion,
          disposition,
          resultCount: null,
        });
        await client.query('COMMIT');
        throw new McpDomainError(
          disposition,
          isRevoked ? 'MCP bearer token was revoked before the request completed.'
            : isExpired ? 'MCP bearer token expired before the request completed.'
              : 'Account control changed before the request completed.',
        );
      }

      if (input.toolName !== null) {
        await this.insertAudit(client, {
          tokenId: row.token_id,
          principalId: row.principal_id,
          initiator: 'external_agent',
          action: 'TOOL_CALLED',
          toolName: input.toolName,
          accountScopes: authorizedAccountIds,
          grantVersion,
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
    let context: { sourceType: 'ui' } | { sourceType: 'schedule' } | { sourceType: 'line'; jobId: string };
    if (initial.sourceType === 'job') {
      const row = (await client.query<{ account_id: string | null; generation: string | number; status: string; source_type: string }>(
        `SELECT account_id, generation, status, source_type FROM agent_jobs WHERE job_id = $1`,
        [initial.jobId],
      )).rows[0];
      // A UI job of the shared Agent room has no account (NULL === NULL); a LINE job must match its account exactly,
      // and the DB CHECK guarantees a LINE job is never account-less.
      if (!row || row.status !== 'running' || Number(row.generation) !== initial.generation || row.account_id !== initial.accountId
        || (row.source_type !== 'ui' && row.source_type !== 'line' && row.source_type !== 'schedule') || (row.source_type === 'line' && row.account_id === null)) {
        return this.rejectInternal(client, toolName, row?.account_id ? [row.account_id] : [], 'The Agent job is no longer authorized to use LINEJS MCP tools.');
      }
      context = row.source_type === 'ui' ? { sourceType: 'ui' } : row.source_type === 'schedule' ? { sourceType: 'schedule' } : { sourceType: 'line', jobId: initial.jobId };
    } else context = initial;
    if (context.sourceType === 'schedule') {
      // A scheduled run reads like the operator but has no Agent room history.
      return { principalId: SCHEDULE_PRINCIPAL_ID, scope: { kind: 'full' }, permissions: allPermissions('ALLOW'), history: { allowed: false, shared: null } };
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
            accountScopes: [], grantVersion: null, disposition: 'PERMISSION_DENIED', resultCount: null,
          });
          await client.query('COMMIT');
          throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
        }
        const { data, resultCount } = await input.execute({
          client, principalId, authorizedAccountIds: [], ownLineNamesOnly: false, sharedAdminChat: history.shared,
        });
        await this.insertAudit(client, {
          tokenId: null, principalId, initiator: 'internal_agent', action: 'TOOL_CALLED', toolName: input.toolName,
          accountScopes: [], grantVersion: null, disposition: 'ALLOWED', resultCount: resultCount ?? null,
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
            accountScopes: [], grantVersion: null, disposition: 'PERMISSION_DENIED', resultCount: null,
          });
          await client.query('COMMIT');
          throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
        }
        const { data, resultCount } = await input.execute({
          client, principalId, authorizedAccountIds: [], ownLineNamesOnly: false,
        });
        await this.insertAudit(client, {
          tokenId: null, principalId, initiator: 'internal_agent', action: 'TOOL_CALLED', toolName: input.toolName,
          accountScopes: [], grantVersion: null, disposition: 'ALLOWED', resultCount: resultCount ?? null,
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
          accountScopes: scope.kind === 'full' ? [] : [scope.accountId],
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
