import { randomUUID } from 'node:crypto';
import {
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_IDS,
  type AgentPermissionEffect,
  type AgentPermissionId,
  type AgentPermissionSubject,
  type AgentToolPolicy,
  type ConversationKey,
  type EffectivePermissions,
  type SetAgentFolderLinkInput,
  type SetAgentPermissionInput,
  type SetAgentPermissionDefaultInput,
  LINK_WRITE_UNSUPPORTED_MESSAGE,
  BASH_COMMAND_MAX_LENGTH,
  AgentExecutionLevelSchema,
  AgentApprovalTimeoutActionSchema,
  type AgentExecutionLevel,
  type AgentExecutionPolicy,
  type AgentToolAllowlistEntry,
  type SetAgentExecutionPolicyInput,
} from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { withBoundedTransaction } from './bounded-transaction.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export type AgentPermissionErrorCode = 'PERMISSION_VERSION_CONFLICT' | 'UNKNOWN_PERMISSION' | 'INVALID_CHAT' | 'INVALID_LINK' | 'LINK_WRITE_UNSUPPORTED' | 'INVALID_ALLOWLIST' | 'INVALID_POLICY';
export class AgentPermissionError extends Error {
  constructor(public readonly code: AgentPermissionErrorCode, message: string) {
    super(message);
    this.name = 'AgentPermissionError';
  }
}

/** Who a job acts as. Derived only from the durable job row, never from tool arguments or prompt text. */
export type JobPrincipal =
  | { kind: 'operator' }
  | { kind: 'admin'; userId: string }
  | { kind: 'user'; senderMid: string }
  | { kind: 'unresolved' };

export function allPermissions(effect: AgentPermissionEffect): EffectivePermissions {
  return Object.fromEntries(AGENT_PERMISSION_IDS.map((id) => [id, effect])) as EffectivePermissions;
}

/**
 * Effective permission resolution for a whitelisted user:
 * user override, then the 所有人 rule, then the catalog default. Rows with ids outside the registry are ignored.
 * Operator and admin never reach this function; callers short-circuit them to ALLOW.
 */
export async function resolveUserPermissions(queryable: Queryable, accountId: string, senderMid: string,
  chat?: { chatType: ConversationKey['chatType']; chatId: string }): Promise<EffectivePermissions> {
  const rows = await queryable.query<{ subject_kind: 'EVERYONE' | 'USER'; permission: string; effect: AgentPermissionEffect; chat_type: string | null }>(
    `SELECT subject_kind, permission, effect, chat_type FROM agent_permission_rules
     WHERE account_id = $1 AND (
       (subject_kind = 'EVERYONE' AND chat_type IS NULL)
       OR (subject_kind = 'USER' AND subject_mid = $2 AND chat_type IS NULL)
       OR (subject_kind = 'USER' AND subject_mid = $2 AND chat_type = $3 AND chat_id = $4))`,
    [accountId, senderMid, chat?.chatType ?? null, chat?.chatId ?? null],
  );
  const defaultRows = await queryable.query<{ permission: string; effect: AgentPermissionEffect }>(
    'SELECT permission, effect FROM agent_permission_global_defaults');
  const everyone = new Map<string, AgentPermissionEffect>();
  const user = new Map<string, AgentPermissionEffect>();
  const scoped = new Map<string, AgentPermissionEffect>();
  const globalDefaults = new Map(defaultRows.rows.map((row) => [row.permission, row.effect]));
  for (const row of rows.rows) {
    if (row.subject_kind === 'EVERYONE') everyone.set(row.permission, row.effect);
    else if (row.chat_type !== null) scoped.set(row.permission, row.effect);
    else user.set(row.permission, row.effect);
  }
  return Object.fromEntries(AGENT_PERMISSIONS.map((entry) => [entry.id,
    scoped.get(entry.id) ?? user.get(entry.id) ?? everyone.get(entry.id) ?? globalDefaults.get(entry.id) ?? entry.defaultEffect])) as EffectivePermissions;
}

export async function resolvePrincipalPermissions(queryable: Queryable, accountId: string, principal: JobPrincipal,
  chat?: { chatType: ConversationKey['chatType']; chatId: string }): Promise<EffectivePermissions> {
  if (principal.kind === 'operator' || principal.kind === 'admin') return allPermissions('ALLOW');
  if (principal.kind === 'unresolved') return allPermissions('DENY');
  return resolveUserPermissions(queryable, accountId, principal.senderMid, chat);
}

/** The trigger sender is the account's Primary Administrator (the one existing admin rule). */
export async function findPrimaryAdminUser(queryable: Queryable, accountId: string, messageId: string): Promise<string | null> {
  const result = await queryable.query<{ user_id: string }>(
    `SELECT aa.user_id
     FROM messages m
     JOIN account_administrators aa
       ON aa.account_id = m.account_id AND aa.user_id = m.sender_id AND aa.role = 'PRIMARY_ADMIN'
     WHERE m.account_id = $1 AND m.message_id = $2`,
    [accountId, messageId],
  );
  return result.rows[0]?.user_id ?? null;
}

export const MAX_FOLDER_LINKS = 32;
export interface LinkedChat { folderId: string; chatType: 'group' | 'room'; chatId: string }

/**
 * Group/room folders linked to a whitelisted user. Read inside the caller's transaction without row locks, so a
 * removed link takes effect on the next call.
 */
export async function resolveLinkedChats(queryable: Queryable, accountId: string, subjectMid: string): Promise<LinkedChat[]> {
  const rows = await queryable.query<{ folder_id: string; chat_type: 'group' | 'room'; chat_id: string }>(
    `SELECT l.folder_id, f.chat_type, f.chat_id FROM agent_folder_links l
     JOIN chat_folders f ON f.folder_id = l.folder_id
     WHERE l.account_id = $1 AND l.subject_mid = $2 AND f.account_id = $1 AND f.chat_type IN ('group', 'room')
     ORDER BY f.created_at, f.folder_id LIMIT ${MAX_FOLDER_LINKS}`, [accountId, subjectMid]);
  return rows.rows.map((row) => ({ folderId: row.folder_id, chatType: row.chat_type, chatId: row.chat_id }));
}

export interface JobPolicy {
  principal: JobPrincipal;
  /** null (with chatType/chatId) only for the shared Agent room's UI jobs, which belong to no LINE account. */
  accountId: string | null;
  chatType: ConversationKey['chatType'] | null;
  chatId: string | null;
  permissions: EffectivePermissions;
  /** Group/room folders linked to the trigger user; only populated for whitelisted users with current-chat records ALLOW. */
  linkedChats: LinkedChat[];
}

/** Job-start resolution used by agent-service; unresolvable state is all-DENY, never ALLOW. */
export async function resolveJobPolicy(queryable: Queryable, jobId: string): Promise<JobPolicy | null> {
  const job = (await queryable.query<{ account_id: string | null; chat_type: ConversationKey['chatType'] | null; chat_id: string | null; source_type: string;
    source_message_id: string | null }>(
    'SELECT account_id, chat_type, chat_id, source_type, source_message_id FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0];
  if (!job) return null;
  // The shared Agent room is the operator's own: account-less, full permissions, no chat folders.
  if (job.source_type === 'ui') {
    return { principal: { kind: 'operator' }, accountId: null, chatType: null, chatId: null, permissions: allPermissions('ALLOW'), linkedChats: [] };
  }
  if (job.account_id === null || job.chat_type === null || job.chat_id === null) return null;
  let principal: JobPrincipal = { kind: 'unresolved' };
  if (job.source_type === 'line' && job.source_message_id) {
    const admin = await findPrimaryAdminUser(queryable, job.account_id, job.source_message_id);
    if (admin) principal = { kind: 'admin', userId: admin };
    else {
      const sender = (await queryable.query<{ sender_id: string }>(
        'SELECT sender_id FROM messages WHERE account_id = $1 AND message_id = $2', [job.account_id, job.source_message_id])).rows[0];
      if (sender) principal = { kind: 'user', senderMid: sender.sender_id };
    }
  }
  const permissions = await resolvePrincipalPermissions(queryable, job.account_id, principal, { chatType: job.chat_type, chatId: job.chat_id });
  const linkedChats = principal.kind === 'user' ? await resolveLinkedChats(queryable, job.account_id, principal.senderMid) : [];
  return { principal, accountId: job.account_id, chatType: job.chat_type, chatId: job.chat_id, permissions, linkedChats };
}

/**
 * Provider built-in tool flags. Operator/admin use the global execution level; a whitelisted user retains the
 * per-user permissions, capped by that level. Unresolved principals receive no local tools.
 */
export function deriveToolPolicy(policy: Pick<JobPolicy, 'principal' | 'permissions'>, level: AgentExecutionLevel = 'workspace_write'): AgentToolPolicy {
  const { principal, permissions } = policy;
  if (principal.kind === 'operator' || principal.kind === 'admin') return { localTools: true, fileRead: true, fileWrite: level !== 'read_only', linkedReadDirs: [], workspaceRootDir: null, level, interactiveApproval: principal.kind === 'operator' };
  if (principal.kind === 'unresolved') return { localTools: false, fileRead: false, fileWrite: false, linkedReadDirs: [], workspaceRootDir: null, level: 'read_only', interactiveApproval: false };
  return {
    localTools: permissions['agent.local_tools'] === 'ALLOW',
    fileRead: permissions['chat_folder.read'] === 'ALLOW',
    fileWrite: permissions['chat_folder.write'] === 'ALLOW' && level !== 'read_only',
    linkedReadDirs: [],
    workspaceRootDir: null,
    level,
    interactiveApproval: false,
  };
}

const policyDefaults: AgentExecutionPolicy = { level: 'full', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', version: 1, updatedAt: new Date(0).toISOString() };
const dangerousTool = (value: string) => value.toLowerCase() === 'bash';

export function normalizeAllowlistValue(kind: 'tool' | 'bash_command', raw: string): string {
  if (kind === 'bash_command') {
    if (!raw || !raw.trim() || raw.includes('\0') || raw.length > BASH_COMMAND_MAX_LENGTH) throw new AgentPermissionError('INVALID_ALLOWLIST', 'Invalid Bash command.');
    return raw;
  }
  const value = raw.trim().replace(/\s+/g, ' ');
  if (kind !== 'tool' || value.length > 96 || (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !/^mcp__[a-z0-9_]+__[a-z0-9_]+$/.test(value)) || dangerousTool(value)) {
    throw new AgentPermissionError('INVALID_ALLOWLIST', 'Invalid tool name.');
  }
  return value;
}

export type ChatFolderChatType = 'direct' | 'group' | 'room';
export interface ChatFolderRow {
  folderId: string;
  accountId: string;
  chatType: ChatFolderChatType;
  chatId: string;
  /** Group title, or the friend's LINE display name for a 1:1 chat. */
  title: string;
}

const CHAT_TITLE_SQL = "COALESCE(NULLIF(c.title, ''), NULLIF(lc.display_name, ''), c.chat_id)";
const CHAT_CONTACT_JOIN = "LEFT JOIN line_contacts lc ON lc.account_id = c.account_id AND c.chat_type = 'direct' AND lc.mid = c.chat_id";

export interface PermissionState {
  subjects: Array<{ kind: 'USER'; mid: string; displayName: string; grantScope: 'ACCOUNT' | 'CHAT'; chatScopes: Array<{ chatType: 'group' | 'room'; chatId: string }> }>;
  rules: Array<{ subject: AgentPermissionSubject; chatType: ChatFolderChatType | null; chatId: string | null; permission: AgentPermissionId; effect: AgentPermissionEffect; version: number }>;
  defaults: Array<{ permission: AgentPermissionId; effect: AgentPermissionEffect; version: number }>;
  links: Array<{ subjectMid: string; folderId: string; access: 'READ' | 'WRITE'; version: number }>;
  folders: ChatFolderRow[];
  eligibleChats: Array<{ chatType: ChatFolderChatType; chatId: string; title: string }>;
}

export class AgentPermissionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The execution-policy and allowlist methods run in withBoundedTransaction: a 2 s server statement timeout plus one
   * application deadline over acquisition, BEGIN, the body, COMMIT and ROLLBACK, so every caller observes a definite settle.
   */
  async getExecutionPolicy(): Promise<AgentExecutionPolicy> {
    const row = await withBoundedTransaction(this.pool, async (client) => (await client.query<{ level: string; approval_timeout_seconds: number;
      timeout_action: 'ALLOW' | 'DENY'; version: number; updated_at: Date }>('SELECT level, approval_timeout_seconds, timeout_action, version, updated_at FROM agent_execution_policy WHERE singleton = true')).rows[0]);
    return row ? { level: AgentExecutionLevelSchema.parse(row.level), approvalTimeoutSeconds: row.approval_timeout_seconds,
      timeoutAction: AgentApprovalTimeoutActionSchema.parse(row.timeout_action), version: row.version, updatedAt: row.updated_at.toISOString() } : policyDefaults;
  }

  async setExecutionPolicy(input: SetAgentExecutionPolicyInput, actor = 'operator'): Promise<number> {
    const parsed = AgentExecutionLevelSchema.safeParse(input.level);
    if (!parsed.success || !AgentApprovalTimeoutActionSchema.safeParse(input.timeoutAction).success || !Number.isInteger(input.approvalTimeoutSeconds) || input.approvalTimeoutSeconds < 10 || input.approvalTimeoutSeconds > 900
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AgentPermissionError('INVALID_POLICY', 'Invalid execution policy.');
    }
    // A stalled write is cancelled by PostgreSQL or the application deadline and rolled back or destroyed, so it never
    // commits after the caller has seen the failure (except an uncertain COMMIT, which the version check makes safe).
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query("INSERT INTO agent_execution_policy (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING");
      const result = await client.query<{ version: number }>(
        `UPDATE agent_execution_policy SET level=$1, approval_timeout_seconds=$2, timeout_action=$3, version=version+1, updated_at=clock_timestamp()
         WHERE singleton=true AND version=$4 RETURNING version`, [input.level, input.approvalTimeoutSeconds, input.timeoutAction, input.expectedVersion]);
      if (!result.rowCount) throw new AgentPermissionError('PERMISSION_VERSION_CONFLICT', 'Agent execution policy changed.');
      const version = result.rows[0]!.version;
      await client.query(`INSERT INTO agent_permission_audit (account_id,subject_kind,permission,old_effect,new_effect,new_version,actor,audit_kind,detail)
        VALUES ('*','EVERYONE','execution_policy',NULL,NULL,$1,$2,'EXECUTION_POLICY',$3::jsonb)`,
      [version, actor, JSON.stringify({ level: input.level, approvalTimeoutSeconds: input.approvalTimeoutSeconds, timeoutAction: input.timeoutAction })]);
      return version;
    });
  }

  async listToolAllowlist(): Promise<AgentToolAllowlistEntry[]> {
    const rows = await withBoundedTransaction(this.pool, async (client) => (await client.query<{ id: string; kind: 'tool' | 'bash_command'; value: string;
      created_at: Date }>('SELECT id,kind,value,created_at FROM agent_tool_allowlist ORDER BY created_at,id')).rows);
    return rows.map((row) => ({ id: row.id, kind: row.kind, value: row.value, createdAt: row.created_at.toISOString() }));
  }

  async recordExecutionApproval(detail: Record<string, unknown>, actor: string): Promise<void> {
    await withBoundedTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_permission_audit (account_id, subject_kind, permission, new_version, actor, audit_kind, detail)
         VALUES ('*', 'EVERYONE', 'execution_approval', 1, $1, 'EXECUTION_APPROVAL', $2::jsonb)`,
        [actor, JSON.stringify(detail)]);
    });
  }

  async addToolAllowlistEntry(kind: 'tool' | 'bash_command', rawValue: string, actor = 'operator'): Promise<AgentToolAllowlistEntry> {
    const value = normalizeAllowlistValue(kind, rawValue);
    const row = await withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; kind: 'tool' | 'bash_command'; value: string; created_at: Date }>(
        'INSERT INTO agent_tool_allowlist (kind,value) VALUES ($1,$2) RETURNING id,kind,value,created_at', [kind, value]);
      await client.query(`INSERT INTO agent_permission_audit (account_id,subject_kind,permission,new_version,actor,audit_kind,detail)
        VALUES ('*','EVERYONE','execution_allowlist',1,$1,'ALLOWLIST',$2::jsonb)`, [actor, JSON.stringify({ action: 'add', kind, value })]);
      return result.rows[0]!;
    });
    return { id: row.id, kind: row.kind, value: row.value, createdAt: row.created_at.toISOString() };
  }

  async removeToolAllowlistEntry(id: string, actor = 'operator'): Promise<void> {
    await withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ kind: 'tool' | 'bash_command'; value: string }>('DELETE FROM agent_tool_allowlist WHERE id=$1 RETURNING kind,value', [id]);
      const row = result.rows[0];
      if (row) await client.query(`INSERT INTO agent_permission_audit (account_id,subject_kind,permission,new_version,actor,audit_kind,detail)
        VALUES ('*','EVERYONE','execution_allowlist',1,$1,'ALLOWLIST',$2::jsonb)`, [actor, JSON.stringify({ action: 'remove', ...row })]);
    });
  }

  async clearToolAllowlist(actor = 'operator'): Promise<void> {
    await withBoundedTransaction(this.pool, async (client) => {
      const result = await client.query<{ count: string }>('WITH deleted AS (DELETE FROM agent_tool_allowlist RETURNING 1) SELECT count(*)::text count FROM deleted');
      await client.query(`INSERT INTO agent_permission_audit (account_id,subject_kind,permission,new_version,actor,audit_kind,detail)
        VALUES ('*','EVERYONE','execution_allowlist',1,$1,'ALLOWLIST',$2::jsonb)`, [actor, JSON.stringify({ action: 'clear', count: Number(result.rows[0]?.count ?? 0) })]);
    });
  }

  async getState(accountId: string): Promise<PermissionState> {
    const agent = await this.pool.query('SELECT 1 FROM line_accounts WHERE account_id = $1 AND product_role = \'AGENT\'', [accountId]);
    if (!agent.rowCount) throw new AgentPermissionError('INVALID_CHAT', 'Permissions are available only for the connected Agent account.');
    const subjects = await this.pool.query<{ target_mid: string; display_name: string | null; scope_kind: 'ACCOUNT' | 'CHAT'; chat_scopes: Array<{ chat_type: 'group' | 'room'; chat_id: string }> }>(
      `SELECT g.target_mid,
              COALESCE(NULLIF(lc.display_name, ''),
                (SELECT NULLIF(cm.display_name, '') FROM conversation_members cm
                  WHERE cm.account_id = g.account_id AND cm.member_id = g.target_mid AND NULLIF(cm.display_name, '') IS NOT NULL LIMIT 1)) AS display_name,
              CASE WHEN bool_or(g.scope_kind = 'ACCOUNT') THEN 'ACCOUNT' ELSE 'CHAT' END AS scope_kind,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object('chat_type', g.chat_type, 'chat_id', g.chat_id))
                FILTER (WHERE g.scope_kind = 'CHAT'), '[]'::jsonb) AS chat_scopes
       FROM line_friend_whitelist_grants g
       LEFT JOIN line_contacts lc ON lc.account_id = g.account_id AND lc.mid = g.target_mid
       WHERE g.account_id = $1 AND g.capability = 'AGENT_USE' AND g.state = 'ACTIVE'
       GROUP BY g.account_id, g.target_mid, lc.display_name
       ORDER BY 2 NULLS LAST, g.target_mid`,
      [accountId],
    );
    const rules = await this.pool.query<{ subject_kind: 'EVERYONE' | 'USER'; subject_mid: string | null; chat_type: ChatFolderChatType | null; chat_id: string | null; permission: string; effect: AgentPermissionEffect; version: string }>(
      `SELECT subject_kind, subject_mid, chat_type, chat_id, permission, effect, version FROM agent_permission_rules
       WHERE account_id = $1 ORDER BY rule_id`, [accountId]);
    const defaults = await this.getGlobalDefaults();
    const folders = await this.pool.query<{ folder_id: string; chat_type: ChatFolderChatType; chat_id: string; title: string }>(
      `SELECT f.folder_id, f.chat_type, f.chat_id, ${CHAT_TITLE_SQL} AS title FROM chat_folders f
       JOIN conversations c ON c.account_id = f.account_id AND c.chat_type = f.chat_type AND c.chat_id = f.chat_id
       ${CHAT_CONTACT_JOIN}
       WHERE f.account_id = $1 ORDER BY f.created_at, f.folder_id`, [accountId]);
    // Agent-enabled groups/rooms, plus the 1:1 chats of friends whose whitelist grant covers the whole account.
    const chats = await this.pool.query<{ chat_type: ChatFolderChatType; chat_id: string; title: string }>(
      `SELECT c.chat_type, c.chat_id, ${CHAT_TITLE_SQL} AS title FROM conversations c
       ${CHAT_CONTACT_JOIN}
       WHERE c.account_id = $1 AND (
         (c.chat_type IN ('group', 'room') AND EXISTS (
            SELECT 1 FROM room_agent_policies p
            WHERE p.account_id = c.account_id AND p.chat_type = c.chat_type AND p.chat_id = c.chat_id AND p.state = 'ENABLED'))
         OR (c.chat_type = 'direct' AND EXISTS (
            SELECT 1 FROM line_friend_whitelist_grants g
            WHERE g.account_id = c.account_id AND g.target_mid = c.chat_id AND g.capability = 'AGENT_USE'
              AND g.state = 'ACTIVE' AND g.scope_kind = 'ACCOUNT')))
       ORDER BY c.chat_type, 3, c.chat_id`, [accountId]);
    const links = await this.pool.query<{ subject_mid: string; folder_id: string; access: 'READ' | 'WRITE'; version: string }>(
      'SELECT subject_mid, folder_id, access, version FROM agent_folder_links WHERE account_id = $1 ORDER BY subject_mid, folder_id', [accountId]);
    const known = new Set<string>(AGENT_PERMISSION_IDS);
    return {
      links: links.rows.map((row) => ({ subjectMid: row.subject_mid, folderId: row.folder_id, access: row.access, version: Number(row.version) })),
      subjects: subjects.rows.map((row) => ({ kind: 'USER' as const, mid: row.target_mid, displayName: row.display_name ?? row.target_mid, grantScope: row.scope_kind,
        chatScopes: row.chat_scopes.map((scope) => ({ chatType: scope.chat_type, chatId: scope.chat_id })) })),
      rules: rules.rows.filter((row) => known.has(row.permission)).map((row) => ({
        subject: row.subject_kind === 'EVERYONE' ? { kind: 'EVERYONE' as const } : { kind: 'USER' as const, mid: row.subject_mid! },
        chatType: row.chat_type, chatId: row.chat_id, permission: row.permission as AgentPermissionId, effect: row.effect, version: Number(row.version) })),
      defaults: defaults.rules,
      folders: folders.rows.map((row) => ({ folderId: row.folder_id, accountId, chatType: row.chat_type, chatId: row.chat_id, title: row.title })),
      eligibleChats: chats.rows.map((row) => ({ chatType: row.chat_type, chatId: row.chat_id, title: row.title })),
    };
  }

  async getGlobalDefaults(): Promise<{ rules: Array<{ permission: AgentPermissionId; effect: AgentPermissionEffect; version: number }> }> {
    const rows = await this.pool.query<{ permission: string; effect: AgentPermissionEffect; version: string }>(
      'SELECT permission, effect, version FROM agent_permission_global_defaults ORDER BY permission');
    const known = new Set<string>(AGENT_PERMISSION_IDS);
    return { rules: rows.rows.filter((row) => known.has(row.permission)).map((row) => ({ permission: row.permission as AgentPermissionId,
      effect: row.effect, version: Number(row.version) })) };
  }

  async setGlobalDefault(input: SetAgentPermissionDefaultInput, actor: string): Promise<number> {
    if (!(AGENT_PERMISSION_IDS as readonly string[]).includes(input.permission)) {
      throw new AgentPermissionError('UNKNOWN_PERMISSION', `Unknown Agent permission "${String(input.permission)}".`);
    }
    return withBoundedTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['agent-global-permission-default', input.permission])]);
      const current = (await client.query<{ effect: AgentPermissionEffect; version: string }>(
        'SELECT effect, version FROM agent_permission_global_defaults WHERE permission=$1 FOR UPDATE', [input.permission])).rows[0];
      if ((current ? Number(current.version) : 0) !== input.expectedVersion) {
        throw new AgentPermissionError('PERMISSION_VERSION_CONFLICT', 'The global permission default changed elsewhere; reload and retry.');
      }
      if (input.effect === 'INHERIT' && !current) return 0;
      const prior = Number((await client.query<{ version: string | null }>(
        `SELECT max(new_version)::text AS version FROM agent_permission_audit
         WHERE account_id='*' AND subject_kind='EVERYONE' AND permission=$1 AND audit_kind='GLOBAL_PERMISSION_DEFAULT'`,
        [input.permission])).rows[0]?.version ?? 0);
      const version = prior + 1;
      if (input.effect === 'INHERIT') {
        await client.query('DELETE FROM agent_permission_global_defaults WHERE permission=$1', [input.permission]);
      } else {
        await client.query(
          `INSERT INTO agent_permission_global_defaults (permission, effect, version, updated_by)
           VALUES ($1,$2,$3,$4) ON CONFLICT (permission) DO UPDATE
           SET effect=EXCLUDED.effect, version=EXCLUDED.version, updated_at=clock_timestamp(), updated_by=EXCLUDED.updated_by`,
          [input.permission, input.effect, version, actor]);
      }
      await client.query(
        `INSERT INTO agent_permission_audit (account_id, subject_kind, permission, old_effect, new_effect, new_version, actor, audit_kind)
         VALUES ('*','EVERYONE',$1,$2,$3,$4,$5,'GLOBAL_PERMISSION_DEFAULT')`,
        [input.permission, current?.effect ?? null, input.effect === 'INHERIT' ? null : input.effect, version, actor]);
      return version;
    });
  }

  /** Returns the new rule version (the monotonic audit version, also for INHERIT). Throws PERMISSION_VERSION_CONFLICT on a stale expectedVersion. */
  async setPermission(input: SetAgentPermissionInput, actor: string): Promise<number> {
    if (!(AGENT_PERMISSION_IDS as readonly string[]).includes(input.permission)) {
      throw new AgentPermissionError('UNKNOWN_PERMISSION', `Unknown Agent permission "${String(input.permission)}".`);
    }
    const subjectMid = input.subject.mid;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const account = await client.query('SELECT 1 FROM line_accounts WHERE account_id=$1 AND product_role=\'AGENT\' FOR SHARE', [input.accountId]);
      if (!account.rowCount) throw new AgentPermissionError('INVALID_CHAT', 'Permission rules can only be changed for the Agent account.');
      const chat = await client.query(
        `SELECT 1 FROM conversations c
         WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3 AND (
           ($2 IN ('group','room') AND EXISTS (SELECT 1 FROM room_agent_policies p WHERE p.account_id=c.account_id AND p.chat_type=c.chat_type AND p.chat_id=c.chat_id AND p.state='ENABLED'))
           OR ($2='direct' AND c.chat_id=$4))`, [input.accountId, input.chatType, input.chatId, subjectMid]);
      if (!chat.rowCount) throw new AgentPermissionError('INVALID_CHAT', 'The selected chat is not eligible for Agent permissions.');
      const grant = await client.query(
        `SELECT 1 FROM line_friend_whitelist_grants g WHERE g.account_id=$1 AND g.target_mid=$2 AND g.capability='AGENT_USE' AND g.state='ACTIVE'
         AND (g.scope_kind='ACCOUNT' OR (g.scope_kind='CHAT' AND g.chat_type=$3 AND g.chat_id=$4)) LIMIT 1`,
        [input.accountId, subjectMid, input.chatType, input.chatId]);
      if (!grant.rowCount) throw new AgentPermissionError('INVALID_CHAT', 'The selected user is no longer eligible for this chat.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['agent-permission', input.accountId, subjectMid, input.chatType, input.chatId, input.permission])]);
      const current = (await client.query<{ rule_id: string; effect: AgentPermissionEffect; version: string }>(
        `SELECT rule_id, effect, version FROM agent_permission_rules
         WHERE account_id=$1 AND subject_kind='USER' AND subject_mid=$2 AND chat_type=$3 AND chat_id=$4 AND permission=$5`,
        [input.accountId, subjectMid, input.chatType, input.chatId, input.permission])).rows[0];
      const actual = current ? Number(current.version) : 0;
      if (actual !== input.expectedVersion) {
        throw new AgentPermissionError('PERMISSION_VERSION_CONFLICT', 'The permission was changed elsewhere; reload and retry.');
      }
      if (input.effect === 'INHERIT' && !current) {
        await client.query('COMMIT');
        return 0;
      }
      const priorVersion = Number((await client.query<{ v: string | null }>(
        `SELECT max(new_version) AS v FROM agent_permission_audit
         WHERE account_id=$1 AND subject_kind='USER' AND subject_mid=$2 AND chat_type=$3 AND chat_id=$4 AND permission=$5`,
        [input.accountId, subjectMid, input.chatType, input.chatId, input.permission])).rows[0]?.v ?? 0);
      const nextVersion = priorVersion + 1;
      if (input.effect === 'INHERIT') {
        await client.query('DELETE FROM agent_permission_rules WHERE rule_id = $1', [current!.rule_id]);
      } else if (current) {
        await client.query('UPDATE agent_permission_rules SET effect = $2, version = $3, updated_at = clock_timestamp(), updated_by = $4 WHERE rule_id = $1',
          [current.rule_id, input.effect, nextVersion, actor]);
      } else {
        await client.query(
          `INSERT INTO agent_permission_rules (account_id, subject_kind, subject_mid, chat_type, chat_id, permission, effect, version, updated_by)
           VALUES ($1, 'USER', $2, $3, $4, $5, $6, $7, $8)`,
          [input.accountId, subjectMid, input.chatType, input.chatId, input.permission, input.effect, nextVersion, actor]);
      }
      await client.query(
        `INSERT INTO agent_permission_audit (account_id, subject_kind, subject_mid, chat_type, chat_id, permission, old_effect, new_effect, new_version, actor)
         VALUES ($1, 'USER', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [input.accountId, subjectMid, input.chatType, input.chatId, input.permission, current?.effect ?? null,
          input.effect === 'INHERIT' ? null : input.effect, nextVersion, actor]);
      await client.query('COMMIT');
      return nextVersion;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Operator-only link of a group/room folder into one whitelisted user's jobs. Returns the new monotonic version.
   * Rejects direct (friend 1:1) folders, unknown folders, non-whitelisted subjects, and WRITE (fails closed).
   */
  async setFolderLink(input: SetAgentFolderLinkInput, actor: string): Promise<number> {
    if (input.access === 'WRITE') throw new AgentPermissionError('LINK_WRITE_UNSUPPORTED', LINK_WRITE_UNSUPPORTED_MESSAGE);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['agent-folder-link', input.accountId, input.subjectMid, input.folderId])]);
      const folder = (await client.query<{ chat_type: ChatFolderChatType }>(
        'SELECT chat_type FROM chat_folders WHERE folder_id = $1 AND account_id = $2', [input.folderId, input.accountId])).rows[0];
      if (!folder || folder.chat_type === 'direct') {
        throw new AgentPermissionError('INVALID_LINK', 'Only existing group or room folders can be linked.');
      }
      const whitelisted = await client.query(
        `SELECT 1 FROM line_friend_whitelist_grants WHERE account_id = $1 AND target_mid = $2 AND capability = 'AGENT_USE' AND state = 'ACTIVE' LIMIT 1`,
        [input.accountId, input.subjectMid]);
      if (whitelisted.rowCount === 0) throw new AgentPermissionError('INVALID_LINK', 'The subject is not a whitelisted user.');
      const current = (await client.query<{ access: 'READ' | 'WRITE'; version: string }>(
        'SELECT access, version FROM agent_folder_links WHERE account_id = $1 AND subject_mid = $2 AND folder_id = $3',
        [input.accountId, input.subjectMid, input.folderId])).rows[0];
      if ((current ? Number(current.version) : 0) !== input.expectedVersion) {
        throw new AgentPermissionError('PERMISSION_VERSION_CONFLICT', 'The link was changed elsewhere; reload and retry.');
      }
      if (input.access === 'NONE' && !current) {
        await client.query('COMMIT');
        return 0;
      }
      if (input.access === 'READ' && !current) {
        const count = Number((await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM agent_folder_links WHERE account_id = $1 AND subject_mid = $2', [input.accountId, input.subjectMid])).rows[0]!.n);
        if (count >= MAX_FOLDER_LINKS) throw new AgentPermissionError('INVALID_LINK', 'Too many linked folders for this user.');
      }
      const priorVersion = Number((await client.query<{ v: string | null }>(
        `SELECT max(new_version) AS v FROM agent_permission_audit
         WHERE account_id = $1 AND subject_kind = 'USER' AND subject_mid = $2 AND permission = 'folder_link' AND folder_id = $3`,
        [input.accountId, input.subjectMid, input.folderId])).rows[0]?.v ?? 0);
      const nextVersion = priorVersion + 1;
      if (input.access === 'NONE') {
        await client.query('DELETE FROM agent_folder_links WHERE account_id = $1 AND subject_mid = $2 AND folder_id = $3',
          [input.accountId, input.subjectMid, input.folderId]);
      } else {
        await client.query(
          `INSERT INTO agent_folder_links (account_id, subject_mid, folder_id, access, version, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (account_id, subject_mid, folder_id)
           DO UPDATE SET access = EXCLUDED.access, version = EXCLUDED.version, updated_at = clock_timestamp(), updated_by = EXCLUDED.updated_by`,
          [input.accountId, input.subjectMid, input.folderId, input.access, nextVersion, actor]);
      }
      await client.query(
        `INSERT INTO agent_permission_audit (account_id, subject_kind, subject_mid, permission, folder_id, old_effect, new_effect, new_version, actor)
         VALUES ($1, 'USER', $2, 'folder_link', $3, NULL, NULL, $4, $5)`,
        [input.accountId, input.subjectMid, input.folderId, nextVersion, actor]);
      await client.query('COMMIT');
      return nextVersion;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Idempotent: returns the existing row or creates one for an existing conversation. */
  async ensureChatFolder(accountId: string, chatType: string, chatId: string, createdBy: string): Promise<ChatFolderRow> {
    if (chatType !== 'direct' && chatType !== 'group' && chatType !== 'room') {
      throw new AgentPermissionError('INVALID_CHAT', 'Only direct, group and room chats have folders.');
    }
    await this.pool.query(
      `INSERT INTO chat_folders (folder_id, account_id, chat_type, chat_id, created_by)
       SELECT $1, c.account_id, c.chat_type, c.chat_id, $5 FROM conversations c
       WHERE c.account_id = $2 AND c.chat_type = $3 AND c.chat_id = $4
       ON CONFLICT (account_id, chat_type, chat_id) DO NOTHING`,
      [randomUUID(), accountId, chatType, chatId, createdBy]);
    const row = (await this.pool.query<{ folder_id: string; title: string }>(
      `SELECT f.folder_id, ${CHAT_TITLE_SQL} AS title FROM chat_folders f
       JOIN conversations c ON c.account_id = f.account_id AND c.chat_type = f.chat_type AND c.chat_id = f.chat_id
       ${CHAT_CONTACT_JOIN}
       WHERE f.account_id = $1 AND f.chat_type = $2 AND f.chat_id = $3`, [accountId, chatType, chatId])).rows[0];
    if (!row) throw new AgentPermissionError('INVALID_CHAT', 'The chat does not exist.');
    return { folderId: row.folder_id, accountId, chatType, chatId, title: row.title };
  }

  async getChatFolder(folderId: string): Promise<ChatFolderRow | null> {
    const row = (await this.pool.query<{ account_id: string; chat_type: ChatFolderChatType; chat_id: string; title: string }>(
      `SELECT f.account_id, f.chat_type, f.chat_id, ${CHAT_TITLE_SQL} AS title FROM chat_folders f
       JOIN conversations c ON c.account_id = f.account_id AND c.chat_type = f.chat_type AND c.chat_id = f.chat_id
       ${CHAT_CONTACT_JOIN}
       WHERE f.folder_id = $1`, [folderId])).rows[0];
    return row ? { folderId, accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, title: row.title } : null;
  }
}
