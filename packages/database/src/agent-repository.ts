import { randomUUID } from 'node:crypto';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, AgentProviderSchema, isAgentScheduleQueueKey, type AgentEvent, type AgentStoredAttachment, type AgentProvider, type AgentRoomKey, type AgentScheduleQueueKey, type AgentRunRequest, type WritableConversationKey, type ResumeSessionValidationResult } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { ensureLineageSessionRow } from './agent-lineage.js';

/**
 * A queue key: one LINE chat, the shared Agent room, or the scheduled-run queue. The room is operator-owned and has no LINE
 * account, so UI jobs and UI sessions are stored with NULL account/chat columns (migration 040); schedule jobs are stored the
 * same way with source_type 'schedule' (migration 072) and are told apart by their source type, never by the NULL columns.
 */
export type AgentQueueKey = WritableConversationKey | AgentRoomKey | AgentScheduleQueueKey;

/** A provider session key. Scheduled runs never have one: every run starts a new provider session. */
export type SessionKey = (WritableConversationKey | AgentRoomKey) & {
  provider: AgentProvider;
  sourceType?: 'line' | 'ui';
};

export type AgentJobSourceType = 'line' | 'ui' | 'schedule';

/** The job source a queue key addresses; every key-scoped job query filters on it so the room and the schedule queue never mix. */
/** The stored chat_type column of a key: the schedule key's chatType 'schedule' is virtual (rows store NULL). */
const keyChatType = (key: { chatType: string | null }): string | null => key.chatType === 'schedule' ? null : key.chatType;

export const queueKeySourceType = (key: { accountId: string | null; chatType?: string | null }): AgentJobSourceType =>
  key.accountId !== null ? 'line' : isAgentScheduleQueueKey(key) ? 'schedule' : 'ui';

export type SessionBinding = SessionKey & {
  workspacePath: string;
  externalSessionId: string;
  generation: number;
};

interface AgentJobBase {
  jobId: string;
  provider: AgentProvider;
  prompt: string;
  workspacePath: string;
  generation: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  sourceMessageId: string | null;
  sourceRequestId: string | null;
  creationEpoch: number | null;
  /** Files attached in the Agent room (UI jobs only; LINE jobs are always empty by CHECK). Absent when none. */
  attachments?: AgentStoredAttachment[];
}
export type AgentJob = AgentJobBase & ({ sourceType: 'line' } & WritableConversationKey | { sourceType: 'ui' } & AgentRoomKey | { sourceType: 'schedule' } & AgentScheduleQueueKey);

export type AgentJobStatusProjection = {
  jobId: string;
  sourceMessageId: string | null;
  status: AgentJob['status'];
  revision: string;
} & ({ sourceType: 'line' } & WritableConversationKey | { sourceType: 'ui' } & AgentRoomKey | { sourceType: 'schedule' } & AgentScheduleQueueKey);

interface JobRow {
  job_id: string; account_id: string | null; chat_type: WritableConversationKey['chatType'] | null; chat_id: string | null;
  provider: AgentProvider; prompt: string; workspace_path: string; generation: number;
  status: AgentJob['status']; source_type: AgentJobSourceType; source_message_id: string | null;
  source_request_id: string | null; creation_epoch: string | null; attachments?: AgentStoredAttachment[] | null;
}

interface StatusProjectionRow {
  job_id: string; account_id: string | null; chat_type: WritableConversationKey['chatType'] | null; chat_id: string | null;
  source_type: AgentJobSourceType; source_message_id: string | null; status: AgentJob['status']; revision: string;
}

/** The job's owner key: the chat for LINE jobs, the shared room for UI jobs (migration 040 CHECK keeps these in step). */
function jobOwner(row: { source_type: AgentJobSourceType; account_id: string | null; chat_type: WritableConversationKey['chatType'] | null; chat_id: string | null }):
  { sourceType: 'line' } & WritableConversationKey | { sourceType: 'ui' } & AgentRoomKey | { sourceType: 'schedule' } & AgentScheduleQueueKey {
  if (row.source_type === 'schedule') return { sourceType: 'schedule', ...AGENT_SCHEDULE_QUEUE_KEY };
  if (row.source_type === 'ui' || row.account_id === null || row.chat_type === null || row.chat_id === null) {
    return { sourceType: 'ui', ...AGENT_ROOM_KEY };
  }
  return { sourceType: 'line', accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id };
}

function toStatusProjection(row: StatusProjectionRow): AgentJobStatusProjection {
  return { jobId: row.job_id, ...jobOwner(row), sourceMessageId: row.source_message_id, status: row.status, revision: row.revision };
}

const statusProjectionColumns = `job_id, account_id, chat_type, chat_id, source_type, source_message_id, status,
  ((extract(epoch FROM updated_at) * 1000000)::numeric(20,0))::text AS revision`;

export async function transitionAgentJobStatus(
  client: Pool | PoolClient,
  status: AgentJob['status'],
  where: string,
  parameters: readonly unknown[],
  workspacePath?: string,
): Promise<AgentJobStatusProjection[]> {
  const shiftedWhere = where.replace(/\$(\d+)/g, (_match, index: string) => `$${Number(index) + 2}`);
  const result = await client.query<StatusProjectionRow>(
    `UPDATE agent_jobs SET status = $1, workspace_path = COALESCE($2::text, workspace_path),
       started_at = CASE WHEN $1 = 'running' THEN clock_timestamp() WHEN $1 = 'queued' THEN NULL ELSE started_at END,
       completed_at = CASE WHEN $1 IN ('completed','failed','cancelled','interrupted') THEN clock_timestamp()
         WHEN $1 IN ('queued','running') THEN NULL ELSE completed_at END,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
     WHERE ${shiftedWhere} RETURNING ${statusProjectionColumns}`,
    [status, workspacePath ?? null, ...parameters],
  );
  return result.rows.map(toStatusProjection);
}

function toAgentJob(row: JobRow): AgentJob {
  return { jobId: row.job_id, ...jobOwner(row),
    provider: row.provider, prompt: row.prompt, workspacePath: row.workspace_path, generation: row.generation,
    status: row.status, sourceMessageId: row.source_message_id,
    sourceRequestId: row.source_request_id, creationEpoch: row.creation_epoch === null ? null : Number(row.creation_epoch),
    ...(row.attachments && row.attachments.length > 0 ? { attachments: row.attachments } : {}) };
}

/** One scheduled run; it has no LINE account or chat and no provider session (docs/architecture/agent-schedules.md). */
export interface ScheduleJobRequest {
  provider: AgentProvider;
  /** `schedule:<scheduleId>:<scheduledFor ISO>`: the idempotency key of the schedule slot. */
  requestId: string;
  prompt: string;
  workspacePath: string;
  /** Non-null only for externally created schedules; copied to the job so its MCP calls retain the same account scope. */
  mcpAccountScope?: readonly string[] | null;
}

/** A prompt typed in the shared Agent room; it has no LINE account or chat. */
export interface UiJobRequest {
  provider: AgentProvider;
  requestId: string;
  prompt: string;
  workspacePath: string;
  /** Chosen by the caller so attachment files can be written before the row exists. */
  jobId?: string;
  attachments?: AgentStoredAttachment[];
}

/** Whole-output marker a free-mode job returns when nothing needs a reply. */
export const FREE_MODE_NO_REPLY = '[[NO_REPLY]]';

const jobColumns = `job_id, account_id, chat_type, chat_id, provider, prompt, workspace_path, generation, status,
  source_type, source_message_id, source_request_id, creation_epoch, attachments`;

/** Serializes claim/reset work per queue: one lock per LINE chat, one for the whole shared room. */
const queueLockKey = (key: AgentQueueKey): string => JSON.stringify(key.accountId === null ? [isAgentScheduleQueueKey(key) ? 'agent-schedule' : 'agent-room'] : [key.accountId, key.chatType, key.chatId]);

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * The admin's direct chat with the Agent account: the one LINE conversation whose provider memory the local Agent room
 * shares (docs/architecture/agent-room-shared-admin-memory.md). Derived from the existing binding on every
 * call; there is no stored copy. The conversation row must exist because LINE session rows reference it.
 */
export const sharedAdminChatSql = `SELECT ag.account_id, adm.chat_id AS admin_mid
  FROM line_accounts ag
  JOIN account_administrators adm ON adm.account_id = ag.account_id AND adm.role = 'PRIMARY_ADMIN' AND adm.chat_type = 'direct'
  JOIN conversations conv ON conv.account_id = ag.account_id AND conv.chat_type = 'direct' AND conv.chat_id = adm.chat_id
  WHERE ag.product_role = 'AGENT' AND ag.own_mid IS NOT NULL AND ag.mode <> 'PAUSED'`;

/** Member display name in the free-mode history and in mentions: contact nickname, contact name, then the member row name. Aliases: cm, lc. */
const MEMBER_DISPLAY_NAME_SQL = "COALESCE(NULLIF(lc.nickname, ''), NULLIF(lc.display_name, ''), NULLIF(cm.display_name, ''))";

export interface JobIdentity {
  agent: { accountId: string; name: string | null } | null;
  admin: { accountId: string; chatId: string; name: string | null } | null;
  current: { accountId: string; chatType: string; chatId: string; title: string | null; isAdmin: boolean;
    /** Display name of the member who asked, as the chat history shows it; null or absent when unknown. */
    askerName?: string | null } | null;
}

/** Members of one conversation the Agent may mention, and the Agent account's own MID (never mentioned). */
export interface ChatMentionCandidates { members: Array<{ mid: string; name: string }>; selfMid: string | null }

export interface SharedAdminChat { accountId: string; adminMid: string }

/** Plain read (no row locks), so it can run inside any claim/reset transaction without touching the lock order. */
export async function findSharedAdminChat(queryable: Queryable): Promise<SharedAdminChat | null> {
  const row = (await queryable.query<{ account_id: string; admin_mid: string }>(`${sharedAdminChatSql} LIMIT 1`)).rows[0];
  return row ? { accountId: row.account_id, adminMid: row.admin_mid } : null;
}

const adminChatQueueKey = (chat: SharedAdminChat): WritableConversationKey => ({ accountId: chat.accountId, chatType: 'direct', chatId: chat.adminMid });

/** The provider session a room job reads and writes: the shared admin-direct LINE session, or the room's own UI session. */
export interface RoomSessionTarget {
  shared: boolean;
  key: SessionKey & { sourceType: 'line' | 'ui' };
}

function roomSessionTarget(shared: SharedAdminChat | null, provider: AgentProvider): RoomSessionTarget {
  return shared
    ? { shared: true, key: { ...adminChatQueueKey(shared), provider, sourceType: 'line' } }
    : { shared: false, key: { ...AGENT_ROOM_KEY, provider, sourceType: 'ui' } };
}

/** The single place that decides which session a room job uses. */
export async function resolveRoomSessionTarget(queryable: Queryable, provider: AgentProvider): Promise<RoomSessionTarget> {
  return roomSessionTarget(await findSharedAdminChat(queryable), provider);
}

async function ensureSessionRow(client: Queryable, key: SessionKey): Promise<void> {
  if (key.accountId === null) {
    await client.query("INSERT INTO agent_sessions (provider, source_type) VALUES ($1, 'ui') ON CONFLICT (provider) WHERE source_type = 'ui' DO NOTHING", [key.provider]);
    return;
  }
  await ensureLineageSessionRow(client, { ...key, accountId: key.accountId });
}

async function readSessionGeneration(client: Queryable, key: SessionKey, lock: boolean): Promise<number> {
  const suffix = lock ? ' FOR UPDATE' : '';
  const result = key.accountId === null
    ? await client.query<{ generation: number }>(`SELECT generation FROM agent_sessions WHERE provider = $1 AND source_type = 'ui'${suffix}`, [key.provider])
    : await client.query<{ generation: number }>(
      `SELECT generation FROM agent_sessions WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = $5${suffix}`,
      [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line']);
  const generation = result.rows[0]?.generation;
  if (generation === undefined) throw new Error('Agent session row missing');
  return generation;
}

/** A claimed job. Room jobs also carry the session they must use, fixed inside the claim transaction. */
export type ClaimedAgentJob = AgentJob & { revision: string; sessionKey?: SessionKey; sessionGeneration?: number };

export interface DeliverySegment {
  deliveryId: string;
  jobId: string;
  partIndex: number;
  text: string;
  idempotencyKey: string;
  status: 'pending' | 'sending' | 'sent' | 'unknown' | 'cancelled';
  lineMessageId: string | null;
}

export interface ClaimedLineDelivery extends DeliverySegment, WritableConversationKey {
  controlEpoch: number;
}

interface DeliveryRow {
  delivery_id: string;
  job_id: string;
  part_index: number;
  text_content: string;
  idempotency_key: string;
  status: DeliverySegment['status'];
  line_message_id: string | null;
}

function toDeliverySegment(row: DeliveryRow): DeliverySegment {
  return { deliveryId: row.delivery_id, jobId: row.job_id, partIndex: row.part_index, text: row.text_content, idempotencyKey: row.idempotency_key, status: row.status, lineMessageId: row.line_message_id };
}

/**
 * One FIFO head per eligible LINE account plus the shared Agent room's head (account-less UI jobs, which need no
 * LINE account row, ACTIVE_CONTROL or control epoch). The room's head has NULL account/chat columns.
 */
export const queuedConversationDiscoverySql = `SELECT head.account_id, head.chat_type, head.chat_id
  FROM (
    SELECT line.account_id, line.chat_type, line.chat_id, line.queue_position
    FROM line_accounts a
    CROSS JOIN LATERAL (
      SELECT j.account_id, j.chat_type, j.chat_id, j.queue_position
      FROM agent_jobs j
      CROSS JOIN account_control c
      WHERE j.account_id = a.account_id AND j.status = 'queued' AND j.source_type = 'line'
        AND a.mode = 'ACTIVE_CONTROL' AND c.singleton = true AND c.control_epoch = j.creation_epoch
        AND NOT EXISTS (
          SELECT 1 FROM agent_jobs running
          WHERE running.account_id = j.account_id AND running.chat_type = j.chat_type
            AND running.chat_id = j.chat_id AND running.status = 'running'
        )
        -- The admin's direct chat shares its provider session with the room: wait while a room job runs.
        AND NOT (j.chat_type = 'direct'
          AND EXISTS (SELECT 1 FROM agent_jobs ui_running WHERE ui_running.source_type = 'ui' AND ui_running.status = 'running')
          AND EXISTS (SELECT 1 FROM (${sharedAdminChatSql}) shared WHERE shared.account_id = j.account_id AND shared.admin_mid = j.chat_id))
      ORDER BY j.queue_position, j.chat_type, j.chat_id
      LIMIT 1
    ) line
    UNION ALL
    SELECT NULL::text, NULL::text, NULL::text, room.queue_position
    FROM (
      SELECT j.queue_position FROM agent_jobs j
      WHERE j.source_type = 'ui' AND j.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.source_type = 'ui' AND running.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM (${sharedAdminChatSql}) shared
          JOIN agent_jobs line_running ON line_running.source_type = 'line' AND line_running.status = 'running'
            AND line_running.account_id = shared.account_id AND line_running.chat_type = 'direct' AND line_running.chat_id = shared.admin_mid)
      ORDER BY j.queue_position
      LIMIT 1
    ) room
    UNION ALL
    -- Scheduled runs have their own queue head: they neither wait for the room or a LINE chat nor block them.
    SELECT NULL::text, 'schedule'::text, NULL::text, scheduled.queue_position
    FROM (
      SELECT j.queue_position FROM agent_jobs j
      WHERE j.source_type = 'schedule' AND j.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.source_type = 'schedule' AND running.status = 'running')
      ORDER BY j.queue_position
      LIMIT 1
    ) scheduled
  ) head
  ORDER BY head.queue_position, head.account_id NULLS FIRST, head.chat_type, head.chat_id
  LIMIT $1`;

export class AgentRepository {
  constructor(private readonly pool: Pool) {}

  /** True for an Agent room job, or an admin-direct LINE job while the room shares that chat; evaluated per call. */
  async sharesAgentRoomHistory(job: { sourceType: AgentJobSourceType; accountId: string | null; chatType: string | null; chatId: string | null }): Promise<boolean> {
    if (job.sourceType === 'ui') return true;
    if (job.sourceType === 'schedule' || job.chatType !== 'direct') return false;
    const shared = await findSharedAdminChat(this.pool);
    return shared !== null && shared.accountId === job.accountId && shared.adminMid === job.chatId;
  }

  /**
   * Who is who for one job's prompt: the Agent account, the Primary Admin's direct chat with it, and (LINE jobs) the current
   * conversation. Read-only; the caller omits the block when this throws.
   */
  async describeJobIdentity(job: { sourceType: AgentJobSourceType; accountId: string | null; chatType: string | null; chatId: string | null; jobId?: string }): Promise<JobIdentity> {
    const agentRow = (await this.pool.query<{ account_id: string; display_name: string | null }>(
      "SELECT account_id, display_name FROM line_accounts WHERE product_role = 'AGENT' AND mode <> 'PAUSED' ORDER BY account_id LIMIT 1")).rows[0];
    const shared = await findSharedAdminChat(this.pool);
    let admin: JobIdentity['admin'] = null;
    if (shared) {
      const row = (await this.pool.query<{ name: string | null }>(
        `SELECT COALESCE(NULLIF(lc.display_name, ''), NULLIF(c.title, '')) AS name
         FROM conversations c LEFT JOIN line_contacts lc ON lc.account_id = c.account_id AND lc.mid = c.chat_id
         WHERE c.account_id = $1 AND c.chat_type = 'direct' AND c.chat_id = $2`, [shared.accountId, shared.adminMid])).rows[0];
      admin = { accountId: shared.accountId, chatId: shared.adminMid, name: row?.name ?? null };
    }
    let current: JobIdentity['current'] = null;
    if (job.sourceType === 'line' && job.accountId && job.chatType && job.chatId) {
      const row = (await this.pool.query<{ title: string | null }>(
        'SELECT title FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3', [job.accountId, job.chatType, job.chatId])).rows[0];
      // The asker's name is for group and room jobs only, where the Agent may need it to @-mention the person.
      const askerName = job.jobId && (job.chatType === 'group' || job.chatType === 'room')
        ? (await this.pool.query<{ name: string | null }>(
          `SELECT ${MEMBER_DISPLAY_NAME_SQL} AS name
           FROM agent_jobs j JOIN conversation_members cm ON cm.account_id = j.account_id AND cm.chat_type = j.chat_type
             AND cm.chat_id = j.chat_id AND cm.member_id = j.source_sender_id
           LEFT JOIN line_contacts lc ON lc.account_id = cm.account_id AND lc.mid = cm.member_id
           WHERE j.job_id = $1`, [job.jobId])).rows[0]?.name ?? null : null;
      current = { accountId: job.accountId, chatType: job.chatType, chatId: job.chatId, title: row?.title ?? null,
        isAdmin: admin !== null && admin.accountId === job.accountId && job.chatType === 'direct' && admin.chatId === job.chatId,
        ...(askerName ? { askerName } : {}) };
    }
    return { agent: agentRow ? { accountId: agentRow.account_id, name: agentRow.display_name } : null, admin, current };
  }

  /**
   * Group or room members the Agent may mention, named exactly as the free-mode history shows them (contact nickname, contact
   * name, then the member row name), and the Agent account's own MID. Members without any name are left out.
   */
  async listMentionCandidates(accountId: string, chatType: string, chatId: string): Promise<ChatMentionCandidates> {
    const result = await this.pool.query<{ mid: string; name: string | null; own_mid: string | null }>(
      `SELECT cm.member_id AS mid, ${MEMBER_DISPLAY_NAME_SQL} AS name, la.own_mid
       FROM line_accounts la
       LEFT JOIN conversation_members cm ON cm.account_id = la.account_id AND cm.chat_type = $2 AND cm.chat_id = $3
       LEFT JOIN line_contacts lc ON lc.account_id = cm.account_id AND lc.mid = cm.member_id
       WHERE la.account_id = $1`, [accountId, chatType, chatId]);
    return {
      members: result.rows.flatMap((row) => row.mid && row.name ? [{ mid: row.mid, name: row.name }] : []),
      selfMid: result.rows[0]?.own_mid ?? null,
    };
  }

  async enqueueUiJob(request: UiJobRequest): Promise<{ disposition: 'inserted' | 'duplicate'; jobId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The job's generation comes from the session it will use: the admin-direct session when shared, else the room's own.
      const target = await resolveRoomSessionTarget(client, request.provider);
      await ensureSessionRow(client, target.key);
      const generation = await readSessionGeneration(client, target.key, true);
      const proposedId = request.jobId ?? randomUUID();
      const inserted = await client.query<{ job_id: string }>(
        `INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, attachments)
         VALUES ($1, $2, 'ui', $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT DO NOTHING RETURNING job_id`,
        [proposedId, request.provider, request.requestId, request.prompt, request.workspacePath, generation,
          JSON.stringify(request.attachments ?? [])],
      );
      const existing = inserted.rows[0] ?? (await client.query<{ job_id: string }>(
        "SELECT job_id FROM agent_jobs WHERE source_type = 'ui' AND source_request_id = $1",
        [request.requestId],
      )).rows[0];
      if (!existing) throw new Error('UI job insertion failed');
      await client.query('COMMIT');
      return { disposition: inserted.rowCount ? 'inserted' : 'duplicate', jobId: existing.job_id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Queues one scheduled run (idempotent on the deterministic request id). It never resolves, creates or reads a session row:
   * the run starts a brand-new provider session and writes nothing to any room or chat session.
   */
  async enqueueScheduleJob(request: ScheduleJobRequest, jobId: string = randomUUID()): Promise<{ disposition: 'inserted' | 'duplicate'; jobId: string }> {
    const inserted = await this.pool.query<{ job_id: string }>(
      `INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, mcp_account_scope)
       VALUES ($1, $2, 'schedule', $3, $4, $5, 0, $6)
       ON CONFLICT DO NOTHING RETURNING job_id`,
      [jobId, request.provider, request.requestId, request.prompt, request.workspacePath,
        request.mcpAccountScope === undefined || request.mcpAccountScope === null ? null : [...new Set(request.mcpAccountScope)]]);
    const existing = inserted.rows[0] ?? (await this.pool.query<{ job_id: string }>(
      "SELECT job_id FROM agent_jobs WHERE source_type = 'schedule' AND source_request_id = $1", [request.requestId])).rows[0];
    if (!existing) throw new Error('Schedule job insertion failed');
    return { disposition: inserted.rowCount ? 'inserted' : 'duplicate', jobId: existing.job_id };
  }

  async lookupSession(key: (WritableConversationKey | AgentRoomKey) & { provider: AgentProvider; sourceType?: 'line' | 'ui'; workspacePath: string }): Promise<{ externalSessionId: string; generation: number } | null> {
    const result = key.accountId === null
      ? await this.pool.query<{ external_session_id: string; generation: number }>(
        "SELECT external_session_id, generation FROM agent_sessions WHERE provider = $1 AND source_type = 'ui' AND external_session_id IS NOT NULL AND workspace_path = $2",
        [key.provider, key.workspacePath],
      )
      : await this.pool.query<{ external_session_id: string; generation: number }>(
        'SELECT external_session_id, generation FROM agent_sessions WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = $5 AND external_session_id IS NOT NULL AND workspace_path = $6',
        [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line', key.workspacePath],
      );
    const row = result.rows[0];
    return row ? { externalSessionId: row.external_session_id, generation: row.generation } : null;
  }

  async validateResumeSession(request: AgentRunRequest): Promise<ResumeSessionValidationResult> {
    // A scheduled run never resumes: it always starts a brand-new provider session.
    if (!request.resumeSessionId || request.source.type === 'schedule') return { status: 'invalid' };
    let result: { rows: Array<{ workspace_path: string | null }> };
    if (request.source.type === 'ui') {
      // The shared Agent room: its own session is keyed by provider alone (no account, no chat). While the admin binding
      // exists the room instead uses the admin-direct LINE session; either row is a legitimate room session.
      result = await this.pool.query<{ workspace_path: string | null }>(
        `SELECT s.workspace_path FROM agent_jobs j JOIN agent_sessions s
           ON s.provider = j.provider AND s.source_type = 'ui' AND s.generation = j.generation
         WHERE j.job_id = $1 AND j.status = 'running' AND j.provider = $2 AND j.source_type = 'ui'
           AND s.external_session_id = $3 AND j.source_request_id = $4
         LIMIT 1`,
        [request.jobId, request.provider, request.resumeSessionId, request.source.requestId],
      );
      const shared = result.rows[0] ? null : await findSharedAdminChat(this.pool);
      if (shared) {
        result = await this.pool.query<{ workspace_path: string | null }>(
          `SELECT s.workspace_path FROM agent_jobs j JOIN agent_sessions s
             ON s.account_id = $5 AND s.chat_type = 'direct' AND s.chat_id = $6
             AND s.provider = j.provider AND s.source_type = 'line' AND s.generation = j.generation
           WHERE j.job_id = $1 AND j.status = 'running' AND j.provider = $2 AND j.source_type = 'ui'
             AND s.external_session_id = $3 AND j.source_request_id = $4
           LIMIT 1`,
          [request.jobId, request.provider, request.resumeSessionId, request.source.requestId, shared.accountId, shared.adminMid],
        );
      }
    } else {
      result = await this.pool.query<{ workspace_path: string | null }>(
        `SELECT s.workspace_path FROM agent_jobs j JOIN agent_sessions s
           ON s.account_id = j.account_id AND s.chat_type = j.chat_type AND s.chat_id = j.chat_id
           AND s.provider = j.provider AND s.source_type = j.source_type AND s.generation = j.generation
         WHERE j.job_id = $1 AND j.status = 'running' AND j.provider = $2
           AND j.account_id = $3 AND j.chat_type = $4 AND j.chat_id = $5 AND j.source_type = 'line'
           AND s.external_session_id = $6 AND j.source_message_id = $7
         LIMIT 1`,
        [request.jobId, request.provider, request.source.accountId, request.source.chatType, request.source.chatId,
          request.resumeSessionId, request.source.messageId],
      );
    }
    const session = result.rows[0];
    if (!session?.workspace_path) return { status: 'invalid' };
    return session.workspace_path === request.workspacePath
      ? { status: 'valid' }
      : { status: 'workspace_mismatch' };
  }

  async bindSession(binding: SessionBinding): Promise<boolean> {
    if (binding.accountId === null) {
      await this.pool.query(
        "INSERT INTO agent_sessions (provider, source_type) VALUES ($1, 'ui') ON CONFLICT (provider) WHERE source_type = 'ui' DO NOTHING",
        [binding.provider],
      );
      const bound = await this.pool.query(
        `UPDATE agent_sessions SET external_session_id = $2, workspace_path = $4, updated_at = now()
         WHERE provider = $1 AND generation = $3 AND source_type = 'ui' RETURNING generation`,
        [binding.provider, binding.externalSessionId, binding.generation, binding.workspacePath],
      );
      return bound.rowCount === 1;
    }
    await ensureLineageSessionRow(this.pool, binding as typeof binding & { accountId: string });
    const result = await this.pool.query(
      `UPDATE agent_sessions SET external_session_id = $5, workspace_path = $8, updated_at = now()
       WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND generation = $6 AND source_type = $7
       RETURNING generation`,
      [binding.accountId, binding.chatType, binding.chatId, binding.provider, binding.externalSessionId, binding.generation, binding.sourceType ?? 'line', binding.workspacePath],
    );
    return result.rowCount === 1;
  }

  async resetGeneration(key: SessionKey): Promise<{ generation: number; cancelledJobIds: string[]; cancelledJobs: AgentJobStatusProjection[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (key.accountId === null) {
        // The shared Agent room: one UI session per provider, no account or chat.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['agent-room', key.provider])]);
        await client.query("INSERT INTO agent_sessions (provider, source_type) VALUES ($1, 'ui') ON CONFLICT (provider) WHERE source_type = 'ui' DO NOTHING", [key.provider]);
        const roomSession = await client.query<{ generation: number }>(
          `UPDATE agent_sessions SET generation = generation + 1, external_session_id = NULL, updated_at = now()
           WHERE provider = $1 AND source_type = 'ui' RETURNING generation`, [key.provider]);
        const roomGeneration = roomSession.rows[0]?.generation;
        if (roomGeneration === undefined) throw new Error('Session reset failed');
        // Lock order matches the LINE-side resets: every session row first, then job rows.
        // While shared, "new conversation" in the room also starts a new admin-direct conversation (one memory).
        const shared = await findSharedAdminChat(client);
        const sharedKey = shared ? { ...adminChatQueueKey(shared), provider: key.provider, sourceType: 'line' as const } : null;
        if (sharedKey) {
          await ensureSessionRow(client, sharedKey);
          await client.query(
            `UPDATE agent_sessions SET generation = generation + 1, external_session_id = NULL, updated_at = now()
             WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = 'line'`,
            [sharedKey.accountId, sharedKey.chatType, sharedKey.chatId, sharedKey.provider]);
        }
        // Room jobs of this provider are all superseded: they were stamped with the generation of whichever session was
        // their target, so comparing generations across the two sessions would be meaningless.
        const roomCancelled = await transitionAgentJobStatus(client, 'cancelled',
          "source_type = 'ui' AND provider = $1 AND status IN ('queued', 'running')", [key.provider]);
        if (sharedKey) {
          roomCancelled.push(...await transitionAgentJobStatus(client, 'cancelled',
            "account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = 'line' AND status IN ('queued', 'running')",
            [sharedKey.accountId, sharedKey.chatType, sharedKey.chatId, sharedKey.provider]));
        }
        await client.query('COMMIT');
        return { generation: roomGeneration, cancelledJobIds: roomCancelled.map((row) => row.jobId), cancelledJobs: roomCancelled };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line'])]);
      await client.query(
        `INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, chat_type, chat_id, provider, source_type) DO NOTHING`,
        [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line'],
      );
      const session = await client.query<{ generation: number }>(
        `UPDATE agent_sessions SET generation = generation + 1, external_session_id = NULL, updated_at = now()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = $5 RETURNING generation`,
        [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line'],
      );
      const generation = session.rows[0]?.generation;
      if (generation === undefined) throw new Error('Session reset failed');
      const cancelled = await transitionAgentJobStatus(client, 'cancelled',
        "account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = $6 AND generation < $5 AND status IN ('queued', 'running')",
        [key.accountId, key.chatType, key.chatId, key.provider, generation, key.sourceType ?? 'line']);
      if ((key.sourceType ?? 'line') === 'line') cancelled.push(...await this.cancelRoomJobsIfShared(client, key, [key.provider]));
      await client.query('COMMIT');
      return { generation, cancelledJobIds: cancelled.map((row) => row.jobId), cancelledJobs: cancelled };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A reset of the admin's direct chat also ends the room's context (they share one provider session). Room jobs were
   * stamped with the generation of whichever session was their target, so every queued or running room job of the
   * affected providers is cancelled, exactly as a room reset cancels them. Any other chat is untouched.
   */
  private async cancelRoomJobsIfShared(client: PoolClient, chat: { accountId: string | null; chatType: string | null; chatId: string | null },
    providers: readonly AgentProvider[]): Promise<AgentJobStatusProjection[]> {
    if (chat.accountId === null || chat.chatType !== 'direct') return [];
    const shared = await findSharedAdminChat(client);
    if (!shared || shared.accountId !== chat.accountId || shared.adminMid !== chat.chatId) return [];
    return transitionAgentJobStatus(client, 'cancelled',
      "source_type = 'ui' AND provider = ANY($1::text[]) AND status IN ('queued', 'running')", [[...providers]]);
  }

  async resetConversationForMessage(key: WritableConversationKey, messageId: string): Promise<{ result: 'applied' | 'already_applied' | 'stale'; cancelledJobIds: string[]; cancelledJobs: AgentJobStatusProjection[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([key.accountId, key.chatType, key.chatId])]);
      const authority = await client.query<{ control_epoch: string; mode: string }>(
        `SELECT c.control_epoch, a.mode FROM account_control c JOIN line_accounts a ON a.account_id = $1
         WHERE c.singleton = true FOR SHARE OF c, a`, [key.accountId],
      );
      const route = await client.query<{ action: string; generation_applied_at: Date | null; creation_epoch: string | null }>(
        `SELECT r.action, r.generation_applied_at, r.creation_epoch FROM message_routes r
         JOIN messages m ON m.account_id = r.account_id AND m.message_id = r.message_id
         WHERE r.account_id = $1 AND m.chat_type = $2 AND m.chat_id = $3 AND r.message_id = $4 FOR UPDATE OF r`,
        [key.accountId, key.chatType, key.chatId, messageId],
      );
      const row = route.rows[0];
      if (!row || row.action !== 'new' || authority.rows[0]?.mode !== 'ACTIVE_CONTROL'
        || row.creation_epoch !== authority.rows[0]?.control_epoch) {
        await client.query('COMMIT');
        return { result: 'stale', cancelledJobIds: [], cancelledJobs: [] };
      }
      if (row.generation_applied_at) { await client.query('COMMIT'); return { result: 'already_applied', cancelledJobIds: [], cancelledJobs: [] }; }
      // A LINE chat only owns LINE sessions; the shared Agent room's UI sessions are not tied to any chat.
      for (const provider of AgentProviderSchema.options) {
        await client.query(
          `INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type)
           VALUES ($1,$2,$3,$4,'line') ON CONFLICT DO NOTHING`,
          [key.accountId, key.chatType, key.chatId, provider],
        );
        await client.query(
          `UPDATE agent_sessions SET generation = generation + 1, external_session_id = NULL, updated_at = now()
           WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND source_type = 'line'`,
          [key.accountId, key.chatType, key.chatId, provider],
        );
      }
      const cancelled = await transitionAgentJobStatus(client, 'cancelled',
        "account_id = $1 AND chat_type = $2 AND chat_id = $3 AND status IN ('queued', 'running')",
        [key.accountId, key.chatType, key.chatId]);
      cancelled.push(...await this.cancelRoomJobsIfShared(client, key, [...AgentProviderSchema.options]));
      await client.query(
        'UPDATE message_routes SET generation_applied_at = now() WHERE account_id = $1 AND message_id = $2',
        [key.accountId, messageId],
      );
      await client.query('COMMIT');
      return { result: 'applied', cancelledJobIds: cancelled.map((item) => item.jobId), cancelledJobs: cancelled };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * Room jobs and admin-direct LINE jobs share one provider session, so they must never run together. Both claims
   * check the other side's `running` row while holding the advisory lock of the admin-direct chat's queue key: the room
   * claim takes it after the room lock (room -> chat), the LINE claim already holds it as its own queue lock. Whoever
   * holds the lock checks and marks `running` in one transaction, so a check can never miss a concurrent claim. Lock
   * order stays account_control -> line_accounts rows: these are advisory locks plus plain reads, no row locks on accounts.
   */
  async claimNext(key: AgentQueueKey): Promise<ClaimedAgentJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [queueLockKey(key)]);
      let shared: SharedAdminChat | null = null;
      let candidate;
      if (isAgentScheduleQueueKey(key)) {
        // Scheduled runs: their own queue, one running at a time, independent of the room, every LINE chat and every session.
        candidate = await client.query<JobRow>(
          `SELECT ${jobColumns}
           FROM agent_jobs j WHERE j.source_type = 'schedule' AND j.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.source_type = 'schedule' AND running.status = 'running')
           ORDER BY j.queue_position FOR UPDATE SKIP LOCKED LIMIT 1`);
      } else if (key.accountId === null) {
        shared = await findSharedAdminChat(client);
        if (shared) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [queueLockKey(adminChatQueueKey(shared))]);
        // The shared Agent room: account-less UI jobs bypass ACTIVE_CONTROL and the control epoch; one runs at a time,
        // and none while the admin-direct chat it shares a session with has a running LINE job.
        candidate = await client.query<JobRow>(
          `SELECT ${jobColumns}
           FROM agent_jobs j WHERE j.source_type = 'ui' AND j.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.source_type = 'ui' AND running.status = 'running')
             AND ($1::text IS NULL OR NOT EXISTS (SELECT 1 FROM agent_jobs line_running WHERE line_running.source_type = 'line'
               AND line_running.status = 'running' AND line_running.account_id = $1 AND line_running.chat_type = 'direct' AND line_running.chat_id = $2))
           ORDER BY j.queue_position FOR UPDATE SKIP LOCKED LIMIT 1`,
          [shared?.accountId ?? null, shared?.adminMid ?? null],
        );
      } else {
        const sharedChat = key.chatType === 'direct' ? await findSharedAdminChat(client) : null;
        const sharesWithRoom = sharedChat !== null && sharedChat.accountId === key.accountId && sharedChat.adminMid === key.chatId;
        candidate = await client.query<JobRow>(
          `SELECT ${jobColumns}
           FROM agent_jobs j WHERE j.account_id = $1 AND j.chat_type = $2 AND j.chat_id = $3 AND j.status = 'queued'
             AND j.source_type = 'line' AND EXISTS (
               SELECT 1 FROM line_accounts a, account_control c
               WHERE a.account_id = j.account_id AND a.mode = 'ACTIVE_CONTROL'
                 AND c.singleton = true AND c.control_epoch = j.creation_epoch
             )
             AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.account_id = j.account_id AND running.chat_type = j.chat_type AND running.chat_id = j.chat_id AND running.status = 'running')
             AND (NOT $4::boolean OR NOT EXISTS (SELECT 1 FROM agent_jobs ui_running WHERE ui_running.source_type = 'ui' AND ui_running.status = 'running'))
           ORDER BY j.queue_position FOR UPDATE SKIP LOCKED LIMIT 1`,
          [key.accountId, key.chatType, key.chatId, sharesWithRoom],
        );
      }
      const row = candidate.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = await transitionAgentJobStatus(client, 'running', 'job_id = $1 AND status = \'queued\'', [row.job_id]);
      // A room job learns its session here, under the same locks, so the target cannot differ between claim and bind.
      let session: { sessionKey: SessionKey; sessionGeneration: number } | undefined;
      if (row.source_type === 'ui') {
        const sessionKey = roomSessionTarget(shared, row.provider).key;
        await ensureSessionRow(client, sessionKey);
        session = { sessionKey, sessionGeneration: await readSessionGeneration(client, sessionKey, false) };
      }
      await client.query('COMMIT');
      const committed = claimed[0];
      if (!committed) throw new Error('Claimed job projection missing');
      return { ...toAgentJob({ ...row, status: committed.status }), status: committed.status, revision: committed.revision, ...session };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listQueuedConversations(limit = 256): Promise<AgentQueueKey[]> {
    const result = await this.pool.query<{ account_id: string | null; chat_type: WritableConversationKey['chatType'] | 'schedule' | null; chat_id: string | null }>(
      queuedConversationDiscoverySql, [Math.max(1, Math.min(256, Math.floor(limit)))],
    );
    return result.rows.map((row): AgentQueueKey => {
      if (row.account_id === null || row.chat_type === null || row.chat_id === null) {
        return row.chat_type === 'schedule' ? AGENT_SCHEDULE_QUEUE_KEY : AGENT_ROOM_KEY;
      }
      return { accountId: row.account_id, chatType: row.chat_type === 'schedule' ? 'direct' : row.chat_type, chatId: row.chat_id };
    });
  }

  async appendEvent(jobId: string, event: AgentEvent): Promise<void> {
    await this.pool.query('INSERT INTO agent_events (job_id, event) VALUES ($1, $2::jsonb)', [jobId, JSON.stringify(event)]);
  }

  async getJob(jobId: string): Promise<AgentJob | null> {
    const result = await this.pool.query<JobRow>(`SELECT ${jobColumns} FROM agent_jobs WHERE job_id = $1`, [jobId]);
    return result.rows[0] ? toAgentJob(result.rows[0]) : null;
  }

  async getJobForKey(key: AgentQueueKey, jobId: string): Promise<AgentJob | null> {
    const job = await this.getJob(jobId);
    return job?.sourceType === queueKeySourceType(key) && job.accountId === key.accountId && (job.sourceType === 'schedule' || job.chatType === key.chatType) && job.chatId === key.chatId ? job : null;
  }

  async listLineJobStatus(key: WritableConversationKey, messageIds: readonly string[]): Promise<AgentJobStatusProjection[]> {
    if (messageIds.length > 225) throw new Error('Agent status lookup exceeds 225 message IDs');
    if (messageIds.length === 0) return [];
    const acquire = this.pool.connect();
    let acquisition: PoolClient | undefined;
    let released = false;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      requestTimer = setTimeout(() => {
        if (acquisition && !released) { released = true; acquisition.release(true); }
        reject(new Error('Agent status lookup timed out'));
      }, 5000);
    });
    try {
      acquisition = await Promise.race([acquire, deadline]);
      const query = (async () => {
        await acquisition.query('BEGIN');
        try {
          await acquisition.query('SET LOCAL statement_timeout = 2000');
          const result = await acquisition.query<StatusProjectionRow>(
            `SELECT ${statusProjectionColumns} FROM agent_jobs
             WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND source_type = 'line'
               AND source_message_id = ANY($4::text[])`,
            [key.accountId, key.chatType, key.chatId, [...new Set(messageIds)]],
          );
          await acquisition.query('COMMIT');
          return result.rows.map(toStatusProjection);
        } catch (error) {
          await acquisition.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      })();
      return await Promise.race([query, deadline]);
    } catch (error) {
      if (!acquisition) void acquire.then((client) => client.release(true), () => undefined);
      throw error;
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      if (acquisition && !released) { released = true; acquisition.release(); }
    }
  }

  // Key comparisons use IS NOT DISTINCT FROM so the shared Agent room (NULL account/chat) and LINE chats share one path; the
  // source type (room vs schedule queue both store NULL columns) is always part of the match.
  async listJobEvents(key: AgentQueueKey, jobId: string): Promise<AgentEvent[]> {
    const result = await this.pool.query<{ event: AgentEvent }>(
      `SELECT e.event FROM agent_events e JOIN agent_jobs j ON j.job_id = e.job_id
       WHERE e.job_id = $1 AND j.account_id IS NOT DISTINCT FROM $2::text AND j.chat_type IS NOT DISTINCT FROM $3::text
         AND j.chat_id IS NOT DISTINCT FROM $4::text AND j.source_type = $5 ORDER BY e.event_id`,
      [jobId, key.accountId, keyChatType(key), key.chatId, queueKeySourceType(key)],
    );
    return result.rows.map((row) => row.event);
  }

  /**
   * Events a room job may show: the room's own jobs, or - only while the shared admin-direct chat exists - that chat's
   * LINE jobs. Any other job id yields nothing.
   */
  async listRoomJobEvents(jobId: string): Promise<AgentEvent[]> {
    const own = await this.listJobEvents(AGENT_ROOM_KEY, jobId);
    if (own.length > 0) return own;
    const shared = await findSharedAdminChat(this.pool);
    return shared ? this.listJobEvents(adminChatQueueKey(shared), jobId) : [];
  }

  async cancelJobForKey(key: AgentQueueKey, jobId: string): Promise<AgentJobStatusProjection | null> {
    const result = await transitionAgentJobStatus(this.pool, 'cancelled',
      "job_id = $1 AND account_id IS NOT DISTINCT FROM $2::text AND chat_type IS NOT DISTINCT FROM $3::text AND chat_id IS NOT DISTINCT FROM $4::text AND source_type = $5 AND status IN ('queued', 'running')",
      [jobId, key.accountId, keyChatType(key), key.chatId, queueKeySourceType(key)]);
    return result[0] ?? null;
  }

  async retryJobForKey(key: AgentQueueKey, jobId: string, workspacePath: string): Promise<AgentJobStatusProjection | null> {
    const result = await transitionAgentJobStatus(this.pool, 'queued',
      `job_id = $1 AND account_id IS NOT DISTINCT FROM $2::text AND chat_type IS NOT DISTINCT FROM $3::text
       AND chat_id IS NOT DISTINCT FROM $4::text AND source_type = $5 AND status IN ('failed', 'interrupted')
       AND (source_type IN ('ui', 'schedule') OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.account_id IS NOT DISTINCT FROM agent_jobs.account_id
         AND s.chat_type IS NOT DISTINCT FROM agent_jobs.chat_type
         AND s.chat_id IS NOT DISTINCT FROM agent_jobs.chat_id AND s.provider=agent_jobs.provider AND s.source_type=agent_jobs.source_type AND s.generation=agent_jobs.generation))
       AND NOT EXISTS (SELECT 1 FROM agent_outputs o WHERE o.job_id=agent_jobs.job_id)
       AND (source_type IN ('ui', 'schedule') OR EXISTS (SELECT 1 FROM line_accounts a CROSS JOIN account_control c
         WHERE a.account_id=agent_jobs.account_id AND a.mode='ACTIVE_CONTROL' AND c.singleton=true AND c.control_epoch=agent_jobs.creation_epoch))`,
      [jobId, key.accountId, keyChatType(key), key.chatId, queueKeySourceType(key)], workspacePath);
    return result[0] ?? null;
  }

  async cancelJob(jobId: string): Promise<AgentJobStatusProjection | null> {
    const result = await transitionAgentJobStatus(this.pool, 'cancelled', "job_id = $1 AND status IN ('queued', 'running')", [jobId]);
    return result[0] ?? null;
  }

  async cancelConversationJobs(key: AgentQueueKey): Promise<AgentJobStatusProjection[]> {
    return transitionAgentJobStatus(this.pool, 'cancelled',
      "account_id IS NOT DISTINCT FROM $1::text AND chat_type IS NOT DISTINCT FROM $2::text AND chat_id IS NOT DISTINCT FROM $3::text AND source_type = $4 AND status IN ('queued', 'running')",
      [key.accountId, keyChatType(key), key.chatId, queueKeySourceType(key)]);
  }

  async failJob(jobId: string): Promise<AgentJobStatusProjection | null> {
    const result = await transitionAgentJobStatus(this.pool, 'failed', "job_id = $1 AND status = 'running'", [jobId]);
    return result[0] ?? null;
  }

  async completeJob(jobId: string, output: string, parts: readonly string[], expectedEpoch: number): Promise<AgentJobStatusProjection | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<JobRow & { free_mode: boolean }>(
        `SELECT job_id, account_id, chat_type, chat_id, provider, prompt, workspace_path, generation, status,
         source_type, source_message_id, source_request_id, creation_epoch, free_mode FROM agent_jobs WHERE job_id = $1 FOR UPDATE`, [jobId],
      );
      const row = result.rows[0];
      if (!row || row.status !== 'running') { await client.query('COMMIT'); return null; }
      // A free-mode job whose whole output is [[NO_REPLY]] completes and is recorded, but nothing is delivered to LINE.
      const silent = row.free_mode && output.trim() === FREE_MODE_NO_REPLY;
      if (row.source_type === 'line') {
        const control = await client.query<{ mode: string; control_epoch: string }>(
          `SELECT a.mode, c.control_epoch FROM line_accounts a CROSS JOIN account_control c
           WHERE a.account_id = $1 AND c.singleton = true FOR SHARE OF c, a`, [row.account_id],
        );
        if (row.creation_epoch !== String(expectedEpoch) || control.rows[0]?.control_epoch !== String(expectedEpoch)
          || control.rows[0]?.mode !== 'ACTIVE_CONTROL') { await client.query('COMMIT'); return null; }
      }
      await client.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1,$2)', [jobId, output]);
      const completed = await transitionAgentJobStatus(client, 'completed', 'job_id = $1 AND status = \'running\'', [jobId]);
      if (row.source_type === 'line' && !silent) {
        for (const [index, text] of parts.entries()) {
          await client.query(
            `INSERT INTO agent_deliveries (delivery_id, job_id, part_index, text_content, idempotency_key,
              account_id, chat_type, chat_id, creation_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), jobId, index, text, `${jobId}:${index}`, row.account_id, row.chat_type, row.chat_id, expectedEpoch],
          );
        }
      }
      await client.query('COMMIT');
      return completed[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async saveFinal(jobId: string, output: string): Promise<AgentJobStatusProjection | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query<{ status: AgentJob['status'] }>('SELECT status FROM agent_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
      if (!job.rows[0]) throw new Error(`Job not found: ${jobId}`);
      if (job.rows[0].status !== 'running' && job.rows[0].status !== 'completed') throw new Error(`Job cannot complete from ${job.rows[0].status}`);
      if (job.rows[0].status === 'completed') {
        const prior = await client.query<{ final_text: string }>('SELECT final_text FROM agent_outputs WHERE job_id = $1', [jobId]);
        if (prior.rows[0]?.final_text !== output) throw new Error('Completed job output differs from existing final');
        await client.query('COMMIT');
        return null;
      }
      await client.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [jobId, output]);
      const completed = await transitionAgentJobStatus(client, 'completed', 'job_id = $1 AND status = \'running\'', [jobId]);
      await client.query('COMMIT');
      return completed[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createLineDelivery(jobId: string, expectedEpoch: number, parts: readonly string[]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query('SELECT control_epoch FROM account_control WHERE singleton = true AND control_epoch = $1 FOR SHARE', [expectedEpoch]);
      if (!control.rows[0]) {
        await client.query('COMMIT');
        return false;
      }
      const identity = await client.query<{ account_id: string }>('SELECT account_id FROM agent_jobs WHERE job_id = $1', [jobId]);
      if (!identity.rows[0]) throw new Error(`Job not found: ${jobId}`);
      const account = await client.query("SELECT account_id FROM line_accounts WHERE account_id = $1 AND mode = 'ACTIVE_CONTROL' FOR SHARE", [identity.rows[0].account_id]);
      if (!account.rows[0]) {
        await client.query('COMMIT');
        return false;
      }
      const job = await client.query<{
        account_id: string; chat_type: WritableConversationKey['chatType']; chat_id: string; creation_epoch: string; source_type: 'line' | 'ui'; status: AgentJob['status'];
      }>(
        `SELECT j.account_id, j.chat_type, j.chat_id, j.creation_epoch, j.source_type, j.status
         FROM agent_jobs j JOIN line_accounts a ON a.account_id = j.account_id JOIN account_control c ON c.singleton = true
         WHERE j.job_id = $1 AND j.source_type = 'line' AND j.status = 'completed'
           AND j.creation_epoch = $2 AND c.control_epoch = $2 AND a.mode = 'ACTIVE_CONTROL'
         FOR UPDATE OF j`,
        [jobId, expectedEpoch],
      );
      const row = job.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      const prior = await client.query<{ part_index: number; text_content: string }>('SELECT part_index, text_content FROM agent_deliveries WHERE job_id = $1 ORDER BY part_index', [jobId]);
      if (prior.rows.length > 0) {
        const same = prior.rows.length === parts.length && prior.rows.every((part, index) => part.part_index === index && part.text_content === parts[index]);
        await client.query('COMMIT');
        return same;
      }
      for (const [index, text] of parts.entries()) {
        await client.query(
          `INSERT INTO agent_deliveries (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), jobId, index, text, `${jobId}:${index}`, row.account_id, row.chat_type, row.chat_id, row.creation_epoch],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDeliveries(jobId: string): Promise<DeliverySegment[]> {
    const result = await this.pool.query<DeliveryRow>('SELECT delivery_id, job_id, part_index, text_content, idempotency_key, status, line_message_id FROM agent_deliveries WHERE job_id = $1 ORDER BY part_index', [jobId]);
    return result.rows.map(toDeliverySegment);
  }

  async listPendingLineDeliveryJobs(accountId?: string, afterJobId?: string, limit = 32): Promise<string[]> {
    const result = await this.pool.query<{ job_id: string }>(
      `SELECT DISTINCT j.job_id
       FROM agent_jobs j JOIN agent_deliveries d ON d.job_id = j.job_id
       WHERE j.source_type = 'line' AND j.status = 'completed' AND d.status = 'pending'
         AND ($1::text IS NULL OR j.account_id = $1)
         AND ($2::uuid IS NULL OR j.job_id > $2::uuid)
       ORDER BY j.job_id LIMIT $3`, [accountId ?? null, afterJobId ?? null, Math.max(1, Math.min(limit, 128))],
    );
    return result.rows.map((row) => row.job_id);
  }

  async claimLineDelivery(jobId: string, partIndex: number, expectedEpoch: number): Promise<ClaimedLineDelivery | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const control = await client.query('SELECT control_epoch FROM account_control WHERE singleton = true AND control_epoch = $1 FOR SHARE', [expectedEpoch]);
      if (!control.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const identity = await client.query<{ account_id: string }>(
        `SELECT account_id FROM agent_jobs WHERE job_id = $1 AND source_type = 'line'
         AND status = 'completed' AND creation_epoch = $2`,
        [jobId, expectedEpoch],
      );
      if (!identity.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const account = await client.query("SELECT account_id FROM line_accounts WHERE account_id = $1 AND mode = 'ACTIVE_CONTROL' FOR SHARE", [identity.rows[0].account_id]);
      if (!account.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query<DeliveryRow & { account_id: string; chat_type: WritableConversationKey['chatType']; chat_id: string; creation_epoch: string }>(
        `UPDATE agent_deliveries d SET status = 'sending', updated_at = now()
         FROM agent_jobs j, line_accounts a, account_control c
         WHERE d.job_id = $1 AND d.part_index = $2 AND d.status = 'pending'
           AND j.job_id = d.job_id AND j.source_type = 'line' AND j.status = 'completed'
           AND a.account_id = j.account_id AND a.mode = 'ACTIVE_CONTROL'
           AND c.singleton = true AND c.control_epoch = $3 AND j.creation_epoch = $3
           AND d.account_id = j.account_id AND d.chat_type = j.chat_type AND d.chat_id = j.chat_id
           AND d.creation_epoch = j.creation_epoch
         RETURNING d.delivery_id, d.job_id, d.part_index, d.text_content, d.idempotency_key, d.status, d.line_message_id,
           j.account_id, j.chat_type, j.chat_id, j.creation_epoch`,
        [jobId, partIndex, expectedEpoch],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      return row ? { ...toDeliverySegment(row), accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id, controlEpoch: Number(row.creation_epoch) } : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeliverySent(jobId: string, partIndex: number, lineMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_deliveries SET status = 'sent', line_message_id = $3, updated_at = now()
       WHERE job_id = $1 AND part_index = $2 AND status = 'sending' RETURNING delivery_id`,
      [jobId, partIndex, lineMessageId],
    );
    return result.rowCount === 1;
  }

  async markDeliveryUnknown(jobId: string, partIndex: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_deliveries SET status = 'unknown', updated_at = now()
       WHERE job_id = $1 AND part_index = $2 AND status = 'sending' RETURNING delivery_id`,
      [jobId, partIndex],
    );
    return result.rowCount === 1;
  }

  async recoverInterruptedState(): Promise<{ interruptedJobs: number; unknownDeliveries: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobs = await transitionAgentJobStatus(client, 'interrupted', "status = 'running'", []);
      const deliveries = await client.query("UPDATE agent_deliveries SET status = 'unknown', updated_at = now() WHERE status = 'sending'");
      await client.query('COMMIT');
      return { interruptedJobs: jobs.length, unknownDeliveries: deliveries.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
