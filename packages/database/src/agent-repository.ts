import { randomUUID } from 'node:crypto';
import { AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, AgentProviderSchema, isAgentScheduleQueueKey, type AgentEvent, type AgentStoredAttachment, type AgentProvider, type AgentRoomKey, type AgentScheduleQueueKey, type AgentRunRequest, type WritableConversationKey, type ResumeSessionValidationResult } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { ensureLineageSessionRow } from './agent-lineage.js';
import { routeKeyFor } from './pending-turn-repository.js';

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

/** One turn of a transcript: the user's prompt or the Agent's final text. */
export interface TranscriptEvent { role: 'user' | 'assistant'; text: string }
const TRANSCRIPT_JOB_LIMIT = 24;
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

/** The route of one session key: where new turns go now, and where the previous generation ran (migration 102). */
export interface SessionRoute {
  provider: AgentProvider;
  sourceId: string | null;
  generation: number;
  previousProvider: AgentProvider | null;
  previousGeneration: number | null;
}

/** The result of applyRoute. A scheduled run has no session: sessionKey is null and generation is 0. */
export interface AppliedRoute {
  switched: boolean;
  sessionKey: SessionKey | null;
  generation: number;
  /** Only on a switch: the provider and generation that ran before. */
  previous?: { provider: AgentProvider; generation: number };
}

/** The WHERE of one agent_sessions row; the placeholders start at $first. */
function sessionRowWhere(key: SessionKey, first: number): { sql: string; params: unknown[] } {
  if (key.accountId === null) return { sql: `provider = $${first} AND source_type = 'ui'`, params: [key.provider] };
  return { sql: `account_id = $${first} AND chat_type = $${first + 1} AND chat_id = $${first + 2} AND provider = $${first + 3} AND source_type = $${first + 4}`,
    params: [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line'] };
}

/** Writes the route row. Only a switch changes the previous provider and generation. */
async function upsertRoute(client: Queryable, routeKey: string, provider: AgentProvider, sourceId: string, generation: number,
  previous: { provider: AgentProvider; generation: number } | null): Promise<void> {
  await client.query(
    `INSERT INTO agent_session_routes (route_key, provider, source_id, generation, previous_provider, previous_generation)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (route_key) DO UPDATE SET provider = EXCLUDED.provider, source_id = EXCLUDED.source_id, generation = EXCLUDED.generation,
       previous_provider = CASE WHEN $7::boolean THEN EXCLUDED.previous_provider ELSE agent_session_routes.previous_provider END,
       previous_generation = CASE WHEN $7::boolean THEN EXCLUDED.previous_generation ELSE agent_session_routes.previous_generation END,
       updated_at = now()`,
    [routeKey, provider, sourceId, generation, previous?.provider ?? null, previous?.generation ?? null, previous !== null]);
}

/** A claimed job. Room jobs also carry the session they must use, fixed inside the claim transaction. */
/** A queued LINE job folded into a claimed lead job (migration 099). It keeps the queued status until the lead ends. */
export interface FoldedAgentJob { jobId: string; prompt: string; sourceMessageId: string | null; queuePosition: string }

export type ClaimedAgentJob = AgentJob & { revision: string; sessionKey?: SessionKey; sessionGeneration?: number;
  /** Followers folded into this job, in creation order. Absent when none. */
  foldedJobs?: FoldedAgentJob[] };

const FOLD_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

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
      WHERE j.account_id = a.account_id AND j.status = 'queued' AND j.source_type = 'line' AND j.folded_into IS NULL
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

  /** Read only: every provider session ID that exists now (all providers, all source types). */
  async listExternalSessionIds(): Promise<string[]> {
    const result = await this.pool.query<{ external_session_id: string }>(
      'SELECT DISTINCT external_session_id FROM agent_sessions WHERE external_session_id IS NOT NULL');
    return result.rows.map((row) => row.external_session_id);
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

  /**
   * The account source that one chat session uses (D13). The session row is locked. A NULL binding gets the effective default
   * source of the session provider, written once; a bound session keeps its source when the default changes later.
   * The row is created by the claim, not here: a missing row or a different generation (the chat was reset) writes nothing
   * and returns the effective default source for that run.
   */
  async bindSessionAccountSource(key: SessionKey, generation: number): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = key.accountId === null
        ? await client.query<{ account_source_id: string | null }>(
          "SELECT account_source_id FROM agent_sessions WHERE provider = $1 AND source_type = 'ui' AND generation = $2 FOR UPDATE",
          [key.provider, generation])
        : await client.query<{ account_source_id: string | null }>(
          `SELECT account_source_id FROM agent_sessions WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4
             AND source_type = $5 AND generation = $6 FOR UPDATE`,
          [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line', generation]);
      const stored = locked.rows[0]?.account_source_id ?? null;
      if (stored !== null) { await client.query('COMMIT'); return stored; }
      const effective = (await client.query<{ source_id: string }>(
        'SELECT COALESCE((SELECT source_id FROM agent_account_sources WHERE provider = $1 AND is_default), $1::text) AS source_id', [key.provider])).rows[0]!.source_id;
      if (locked.rows[0]) {
        await (key.accountId === null
          ? client.query("UPDATE agent_sessions SET account_source_id = $2, updated_at = now() WHERE provider = $1 AND source_type = 'ui' AND generation = $3",
            [key.provider, effective, generation])
          : client.query(
            `UPDATE agent_sessions SET account_source_id = $5, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3
               AND provider = $4 AND source_type = $6 AND generation = $7`,
            [key.accountId, key.chatType, key.chatId, key.provider, effective, key.sourceType ?? 'line', generation]));
      }
      await client.query('COMMIT');
      return effective;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The account source recorded for a job. Null when none was recorded (the job failed before the claim bound one) or the source was removed. */
  async jobAccountSource(jobId: string): Promise<string | null> {
    return (await this.pool.query<{ account_source_id: string | null }>('SELECT account_source_id FROM agent_jobs WHERE job_id = $1', [jobId])).rows[0]?.account_source_id ?? null;
  }

  /** Records the account source that a claimed job runs with. A removed source leaves NULL (ON DELETE SET NULL). */
  async setJobAccountSource(jobId: string, sourceId: string): Promise<void> {
    await this.pool.query('UPDATE agent_jobs SET account_source_id = $2 WHERE job_id = $1', [jobId, sourceId]);
  }

  /** The route of one session key (migration 102): the provider, source and generation that new turns use, and the previous ones. */
  async getRoute(routeKey: string): Promise<SessionRoute | null> {
    const row = (await this.pool.query<{ provider: AgentProvider; source_id: string | null; generation: number;
      previous_provider: AgentProvider | null; previous_generation: number | null }>(
      'SELECT provider, source_id, generation, previous_provider, previous_generation FROM agent_session_routes WHERE route_key = $1', [routeKey])).rows[0];
    return row ? { provider: row.provider, sourceId: row.source_id, generation: row.generation,
      previousProvider: row.previous_provider, previousGeneration: row.previous_generation } : null;
  }

  /**
   * Applies the chosen provider and account source to a claimed job (CTA registry.rs 1847-1882, plan D21). One transaction.
   * Lock order is session rows (in provider order, like the resets), then the job row.
   * "Current" is the route row of the session key when it exists, else the claimed session (a LINE job is enqueued with the chat
   * preference, so its claimed provider can differ from the route). A run that keeps the current provider and source is not a
   * switch: the job moves to the current session generation and the route row is refreshed. Any other run is a switch:
   * the target session starts a new generation with no provider session id, the job and its folded followers move to it, and the
   * route row remembers the previous provider and generation. A scheduled run has no session: it only takes the provider and
   * source, and it never writes a route row (D25).
   */
  async applyRoute(input: { jobId: string; sessionKey?: SessionKey; sessionGeneration: number; provider: AgentProvider; sourceId: string }): Promise<AppliedRoute> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const peek = (await client.query<{ source_type: AgentJobSourceType }>('SELECT source_type FROM agent_jobs WHERE job_id = $1', [input.jobId])).rows[0];
      if (!peek) throw new Error('Agent job missing');
      if (peek.source_type === 'schedule') {
        const job = (await client.query<{ provider: AgentProvider; status: AgentJob['status']; account_source_id: string | null }>(
          'SELECT provider, status, account_source_id FROM agent_jobs WHERE job_id = $1 FOR UPDATE', [input.jobId])).rows[0];
        if (!job || (job.status !== 'running' && job.status !== 'queued')) throw new Error('Agent job is not running or queued');
        await client.query('UPDATE agent_jobs SET provider = $2, account_source_id = $3 WHERE job_id = $1', [input.jobId, input.provider, input.sourceId]);
        await client.query('COMMIT');
        return { switched: job.provider !== input.provider || (job.account_source_id !== null && job.account_source_id !== input.sourceId),
          sessionKey: null, generation: 0 };
      }
      const origin = input.sessionKey;
      if (!origin) throw new Error('A session key is required for a LINE or room job');
      const routeKey = routeKeyFor(origin);
      // The route row is locked first. Only applyRoute locks it, and a chat has one running job, so no session-first order can cross it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agent-route:${routeKey}`]);
      const route = (await client.query<{ provider: AgentProvider; source_id: string | null; generation: number }>(
        'SELECT provider, source_id, generation FROM agent_session_routes WHERE route_key = $1 FOR UPDATE', [routeKey])).rows[0];
      const currentProvider = route?.provider ?? origin.provider;
      const target: SessionKey = { ...origin, provider: input.provider };
      const wanted = new Map<AgentProvider, SessionKey>();
      for (const provider of new Set<AgentProvider>([origin.provider, currentProvider, input.provider])) {
        const key: SessionKey = { ...origin, provider };
        await ensureSessionRow(client, key);
        wanted.set(provider, key);
      }
      const locked = new Map<AgentProvider, { generation: number; accountSourceId: string | null }>();
      for (const key of [...wanted.values()].sort((a, b) => AgentProviderSchema.options.indexOf(a.provider) - AgentProviderSchema.options.indexOf(b.provider))) {
        const where = sessionRowWhere(key, 1);
        const row = (await client.query<{ generation: number; account_source_id: string | null }>(
          `SELECT generation, account_source_id FROM agent_sessions WHERE ${where.sql} FOR UPDATE`, where.params)).rows[0];
        if (!row) throw new Error('Agent session row missing');
        locked.set(key.provider, { generation: row.generation, accountSourceId: row.account_source_id });
      }
      const job = (await client.query<{ status: AgentJob['status'] }>('SELECT status FROM agent_jobs WHERE job_id = $1 FOR UPDATE', [input.jobId])).rows[0];
      if (!job || (job.status !== 'running' && job.status !== 'queued')) throw new Error('Agent job is not running or queued');
      // The claimed generation is only meaningful for the claimed provider's session.
      if (currentProvider === origin.provider && locked.get(origin.provider)!.generation !== input.sessionGeneration) {
        throw new Error('Agent session generation changed');
      }
      // "Current" is the route row when it exists. Without a row it is the claimed session.
      const currentSession = locked.get(currentProvider)!;
      const currentSource = route ? route.source_id : currentSession.accountSourceId;
      const current = { provider: currentProvider, generation: route ? route.generation : currentSession.generation };
      const moveJob = (generation: number) => client.query(
        `UPDATE agent_jobs SET provider = $2, account_source_id = $3, generation = $4
         WHERE job_id = $1 OR (folded_into = $1 AND status = 'queued')`, [input.jobId, input.provider, input.sourceId, generation]);
      if (input.provider === currentProvider && (currentSource === null || currentSource === input.sourceId)) {
        const sessionKey = wanted.get(currentProvider)!;
        if (currentSession.accountSourceId === null) {
          const where = sessionRowWhere(sessionKey, 2);
          await client.query(`UPDATE agent_sessions SET account_source_id = $1, updated_at = now() WHERE ${where.sql}`, [input.sourceId, ...where.params]);
        }
        // A reset may have raised the session generation: the session row wins over the route row.
        await moveJob(currentSession.generation);
        await upsertRoute(client, routeKey, input.provider, input.sourceId, currentSession.generation, null);
        await client.query('COMMIT');
        return { switched: false, sessionKey, generation: currentSession.generation };
      }
      const where = sessionRowWhere(target, 2);
      const bumped = await client.query<{ generation: number }>(
        `UPDATE agent_sessions SET generation = generation + 1, external_session_id = NULL, account_source_id = $1, updated_at = now()
         WHERE ${where.sql} RETURNING generation`, [input.sourceId, ...where.params]);
      const generation = bumped.rows[0]?.generation;
      if (generation === undefined) throw new Error('Agent session switch failed');
      await moveJob(generation);
      const previous = current;
      await upsertRoute(client, routeKey, input.provider, input.sourceId, generation, previous);
      await client.query('COMMIT');
      return { switched: true, sessionKey: target, generation, previous };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Queues one continuation of a failed job (CTA replay of a pending turn, plan D22). The new job copies the origin job and
   * points to it with retry_of_job_id (one continuation per origin). A LINE job re-checks its authority in the same transaction
   * (the checks of the removed acceptQuotaRetry): the control epoch, ACTIVE_CONTROL, SYSTEM_LOGIN, the worker binding when given,
   * and the stored friend and room grants. It returns null when a check fails, the origin is not failed or interrupted, it has an
   * output, or it already has a continuation.
   */
  async enqueueContinuation(input: { originJobId: string; prompt: string; workerInstanceId?: string; controlEpoch?: number }): Promise<AgentJobStatusProjection | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const peek = (await client.query<{ source_type: AgentJobSourceType; account_id: string | null; chat_type: WritableConversationKey['chatType'] | null; chat_id: string | null }>(
        'SELECT source_type, account_id, chat_type, chat_id FROM agent_jobs WHERE job_id = $1', [input.originJobId])).rows[0];
      if (!peek) { await client.query('ROLLBACK'); return null; }
      const owner = jobOwner(peek);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [queueLockKey(owner)]);
      let authority: { control_epoch: string; mode: string; connection_mode: string; worker_instance_id: string | null; worker_binding_epoch: string | null } | undefined;
      if (peek.source_type === 'line') {
        authority = (await client.query<NonNullable<typeof authority>>(
          `SELECT c.control_epoch, a.mode, a.connection_mode, a.worker_instance_id, a.worker_binding_epoch
           FROM account_control c CROSS JOIN line_accounts a WHERE a.account_id = $1 AND c.singleton = true FOR SHARE OF c, a`, [peek.account_id])).rows[0];
        if (!authority) { await client.query('ROLLBACK'); return null; }
      }
      const origin = (await client.query<{ job_id: string; provider: AgentProvider; status: AgentJob['status']; source_message_id: string | null;
        source_request_id: string | null; source_sender_id: string | null; creation_epoch: string | null; workspace_path: string; attachments: AgentStoredAttachment[] | null;
        free_mode: boolean; mcp_account_scope: string[] | null; account_source_id: string | null; direct_friend_grant_id: string | null;
        direct_friend_grant_version: string | null; room_agent_grant_id: string | null; room_agent_grant_version: string | null }>(
        `SELECT job_id, provider, status, source_message_id, source_request_id, source_sender_id, creation_epoch, workspace_path, attachments,
           free_mode, mcp_account_scope, account_source_id, direct_friend_grant_id, direct_friend_grant_version, room_agent_grant_id, room_agent_grant_version
         FROM agent_jobs WHERE job_id = $1 FOR UPDATE`, [input.originJobId])).rows[0];
      if (!origin || (origin.status !== 'failed' && origin.status !== 'interrupted')) { await client.query('ROLLBACK'); return null; }
      if (authority && peek.account_id !== null) {
        const controlEpoch = Number(authority.control_epoch);
        if (origin.creation_epoch === null || Number(origin.creation_epoch) !== controlEpoch
          || (input.controlEpoch !== undefined && input.controlEpoch !== controlEpoch)
          || authority.mode !== 'ACTIVE_CONTROL' || authority.connection_mode !== 'SYSTEM_LOGIN'
          || (input.workerInstanceId !== undefined && (authority.worker_instance_id !== input.workerInstanceId
            || authority.worker_binding_epoch === null || Number(authority.worker_binding_epoch) !== controlEpoch))) {
          await client.query('ROLLBACK'); return null;
        }
        if (origin.direct_friend_grant_id) {
          const grant = await client.query(
            `SELECT 1 FROM line_friend_whitelist_grants WHERE grant_id = $1 AND account_id = $2 AND target_mid = $3
               AND version = $4 AND state = 'ACTIVE' AND (scope_kind = 'ACCOUNT' OR (scope_kind = 'CHAT' AND chat_type = $5 AND chat_id = $6)) FOR SHARE`,
            [origin.direct_friend_grant_id, peek.account_id, origin.source_sender_id, origin.direct_friend_grant_version, peek.chat_type, peek.chat_id]);
          if (!grant.rowCount) { await client.query('ROLLBACK'); return null; }
        }
      }
      const taken = await client.query(
        'SELECT 1 FROM agent_jobs WHERE retry_of_job_id = $1 UNION ALL SELECT 1 FROM agent_outputs WHERE job_id = $1', [input.originJobId]);
      if (taken.rowCount) { await client.query('ROLLBACK'); return null; }
      let generation = 0;
      if (peek.source_type === 'line') {
        const sessionKey: SessionKey = { ...(owner as WritableConversationKey), provider: origin.provider, sourceType: 'line' };
        await ensureSessionRow(client, sessionKey);
        generation = await readSessionGeneration(client, sessionKey, true);
      } else if (peek.source_type === 'ui') {
        const sessionKey = (await resolveRoomSessionTarget(client, origin.provider)).key;
        await ensureSessionRow(client, sessionKey);
        generation = await readSessionGeneration(client, sessionKey, true);
      }
      const newJobId = randomUUID();
      // A UI or schedule job names its request id, and the index of that id is unique. The new id keeps the schedule prefix.
      const requestId = origin.source_request_id === null ? null : `${origin.source_request_id}:continue:${newJobId}`;
      const inserted = await client.query<StatusProjectionRow>(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_request_id, prompt,
           workspace_path, generation, status, creation_epoch, attachments, source_sender_id, direct_friend_grant_id, direct_friend_grant_version,
           room_agent_grant_id, room_agent_grant_version, free_mode, retry_of_job_id, mcp_account_scope, account_source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         RETURNING ${statusProjectionColumns}`,
        [newJobId, peek.account_id, peek.chat_type, peek.chat_id, origin.provider, peek.source_type, origin.source_message_id, requestId, input.prompt,
          origin.workspace_path, generation, origin.creation_epoch, JSON.stringify(origin.attachments ?? []), origin.source_sender_id,
          origin.direct_friend_grant_id, origin.direct_friend_grant_version, origin.room_agent_grant_id, origin.room_agent_grant_version,
          origin.free_mode, input.originJobId, origin.mcp_account_scope, origin.account_source_id]);
      await client.query('COMMIT');
      return inserted.rows[0] ? toStatusProjection(inserted.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clears the stored provider session id of one session row. One UPDATE; it matches only when the key, the generation and the
   * expected id are all current, so a newer bound session is never cleared. Returns true when a row changed.
   */
  async clearExternalSession(key: SessionKey, generation: number, expectedExternalSessionId: string): Promise<boolean> {
    const result = key.accountId === null
      ? await this.pool.query(
        `UPDATE agent_sessions SET external_session_id = NULL, updated_at = now()
         WHERE provider = $1 AND generation = $2 AND source_type = 'ui' AND external_session_id = $3`,
        [key.provider, generation, expectedExternalSessionId],
      )
      : await this.pool.query(
        `UPDATE agent_sessions SET external_session_id = NULL, updated_at = now()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND provider = $4 AND generation = $5 AND source_type = $6
           AND external_session_id = $7`,
        [key.accountId, key.chatType, key.chatId, key.provider, generation, key.sourceType ?? 'line', expectedExternalSessionId],
      );
    return (result.rowCount ?? 0) > 0;
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
           FROM agent_jobs j WHERE j.source_type = 'schedule' AND j.status = 'queued' AND j.folded_into IS NULL
             AND NOT EXISTS (SELECT 1 FROM agent_jobs running WHERE running.source_type = 'schedule' AND running.status = 'running')
           ORDER BY j.queue_position FOR UPDATE SKIP LOCKED LIMIT 1`);
      } else if (key.accountId === null) {
        shared = await findSharedAdminChat(client);
        if (shared) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [queueLockKey(adminChatQueueKey(shared))]);
        // The shared Agent room: account-less UI jobs bypass ACTIVE_CONTROL and the control epoch; one runs at a time,
        // and none while the admin-direct chat it shares a session with has a running LINE job.
        candidate = await client.query<JobRow>(
          `SELECT ${jobColumns}
           FROM agent_jobs j WHERE j.source_type = 'ui' AND j.status = 'queued' AND j.folded_into IS NULL
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
             AND j.folded_into IS NULL AND j.source_type = 'line' AND EXISTS (
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
      const foldedJobs = row.source_type === 'line' ? await this.foldDeferredFollowers(client, row.job_id) : [];
      await client.query('COMMIT');
      const committed = claimed[0];
      if (!committed) throw new Error('Claimed job projection missing');
      return { ...toAgentJob({ ...row, status: committed.status }), status: committed.status, revision: committed.revision, ...session,
        ...(foldedJobs.length > 0 ? { foldedJobs } : {}) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * CliTalkAgent R2 drain: messages that arrive while a turn runs are joined into ONE follow-up turn. A claimed LINE job is
   * "deferred" when it was created before the latest end of another job of its chat (it waited while a turn ran); the owner,
   * a job that did not wait, folds nothing. A deferred lead folds the later queued jobs of the same chat, sender, provider,
   * generation and creation epoch (not free mode). Runs in the claim transaction, under the chat queue lock.
   */
  private async foldDeferredFollowers(client: PoolClient, leadJobId: string): Promise<FoldedAgentJob[]> {
    const folded = await client.query<{ job_id: string; prompt: string; source_message_id: string | null; queue_position: string }>(
      `UPDATE agent_jobs f SET folded_into = lead.job_id
       FROM agent_jobs lead
       WHERE lead.job_id = $1 AND lead.source_type = 'line' AND lead.free_mode = false AND lead.source_sender_id IS NOT NULL
         AND lead.created_at < (SELECT max(d.completed_at) FROM agent_jobs d
           WHERE d.account_id = lead.account_id AND d.chat_type = lead.chat_type AND d.chat_id = lead.chat_id
             AND d.source_type = 'line' AND d.job_id <> lead.job_id AND d.completed_at IS NOT NULL)
         AND f.status = 'queued' AND f.folded_into IS NULL AND f.job_id <> lead.job_id
         AND f.source_type = 'line' AND f.free_mode = false
         AND f.account_id = lead.account_id AND f.chat_type = lead.chat_type AND f.chat_id = lead.chat_id
         AND f.provider = lead.provider AND f.generation = lead.generation
         AND f.creation_epoch IS NOT DISTINCT FROM lead.creation_epoch
         AND f.source_sender_id = lead.source_sender_id
         AND f.created_at > lead.created_at AND f.queue_position > lead.queue_position
       RETURNING f.job_id, f.prompt, f.source_message_id, f.queue_position::text AS queue_position`, [leadJobId]);
    return folded.rows.sort((a, b) => (BigInt(a.queue_position) < BigInt(b.queue_position) ? -1 : 1))
      .map((item) => ({ jobId: item.job_id, prompt: item.prompt, sourceMessageId: item.source_message_id, queuePosition: item.queue_position }));
  }

  /**
   * The lead of folded jobs reached a terminal status: each still-queued follower takes the same status in one transaction.
   * A completed lead gives each follower an output with the lead's final text and NO delivery (the lead delivers the one reply).
   * Returns the follower projections; empty while the lead is not terminal.
   */
  async settleFolded(leadJobId: string): Promise<AgentJobStatusProjection[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const settled = await this.settleFoldedIn(client, leadJobId);
      await client.query('COMMIT');
      return settled;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async settleFoldedIn(client: PoolClient, leadJobId: string): Promise<AgentJobStatusProjection[]> {
    const lead = await client.query<{ status: AgentJob['status'] }>('SELECT status FROM agent_jobs WHERE job_id = $1 FOR UPDATE', [leadJobId]);
    const status = lead.rows[0]?.status;
    if (!status || !(FOLD_TERMINAL_STATUSES as readonly string[]).includes(status)) return [];
    const followers = await client.query<{ job_id: string }>(
      "SELECT job_id FROM agent_jobs WHERE folded_into = $1 AND status = 'queued' ORDER BY queue_position FOR UPDATE", [leadJobId]);
    if (followers.rows.length === 0) return [];
    if (status === 'completed') {
      await client.query(
        `INSERT INTO agent_outputs (job_id, final_text)
         SELECT f.job_id, o.final_text FROM agent_jobs f JOIN agent_outputs o ON o.job_id = $1
         WHERE f.folded_into = $1 AND f.status = 'queued' ON CONFLICT (job_id) DO NOTHING`, [leadJobId]);
    }
    return transitionAgentJobStatus(client, status, "folded_into = $1 AND status = 'queued'", [leadJobId]);
  }

  /** A job leaves its fold: it is its own lead again (retry) and its own queued followers run as normal jobs. */
  private async releaseFold(jobId: string): Promise<void> {
    await this.pool.query("UPDATE agent_jobs SET folded_into = NULL WHERE job_id = $1 OR (folded_into = $1 AND status = 'queued')", [jobId]);
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

  /**
   * Earlier turns of the queue key of a job, for the transcript preamble of a new resident process. One SELECT: jobs with the same
   * queue key (account/chat or the room), provider and session generation, created before the job and not the job itself, newest
   * 24 jobs, returned oldest first. Each job gives its prompt as a user event and, when it completed, its final text as an assistant event.
   * With `from`, the earlier jobs of that provider and generation are used instead of the job's own provider and `generation`:
   * this is the previous-generation context of a provider or source switch (see applyRoute).
   */
  async listTranscriptEvents(input: { jobId: string; generation: number; from?: { provider: AgentProvider; generation: number } }): Promise<TranscriptEvent[]> {
    const result = await this.pool.query<{ job_id: string; folded_into: string | null; prompt: string; final_text: string | null }>(
      `SELECT j.job_id, j.folded_into, j.prompt, o.final_text
       FROM agent_jobs c
       JOIN agent_jobs j ON j.source_type = c.source_type AND j.account_id IS NOT DISTINCT FROM c.account_id
         AND j.chat_type IS NOT DISTINCT FROM c.chat_type AND j.chat_id IS NOT DISTINCT FROM c.chat_id
         AND j.provider = COALESCE($3::text, c.provider) AND j.generation = $2 AND j.job_id <> c.job_id
         AND (j.created_at, j.queue_position) < (c.created_at, c.queue_position)
       LEFT JOIN agent_jobs lead ON lead.job_id = j.folded_into
       LEFT JOIN agent_outputs o ON o.job_id = j.job_id AND j.status = 'completed' AND j.folded_into IS NULL
       WHERE c.job_id = $1
       ORDER BY COALESCE(lead.created_at, j.created_at) DESC, COALESCE(lead.queue_position, j.queue_position) DESC, j.queue_position DESC
       LIMIT ${TRANSCRIPT_JOB_LIMIT}`,
      [input.jobId, input.from ? input.from.generation : input.generation, input.from?.provider ?? null]);
    const events: TranscriptEvent[] = [];
    // A folded follower has a user event only. The reply of a lead follows the user events of its followers (one turn).
    let pending: { leadId: string; text: string } | null = null;
    for (const row of result.rows.reverse()) {
      if (pending && row.folded_into !== pending.leadId) { events.push({ role: 'assistant', text: pending.text }); pending = null; }
      events.push({ role: 'user', text: row.prompt });
      if (row.final_text !== null) pending = { leadId: row.job_id, text: row.final_text };
    }
    if (pending) events.push({ role: 'assistant', text: pending.text });
    return events;
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
    // A cancelled follower leaves its fold and does not stop the lead. A cancelled lead is settled with its followers by the service.
    if (result[0]) await this.pool.query('UPDATE agent_jobs SET folded_into = NULL WHERE job_id = $1', [jobId]);
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
    if (result[0]) await this.releaseFold(jobId);
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

  /**
   * Add delivery rows to a completed LINE job for an autonomous reply (a result that no job started).
   * One transaction. The job row is locked, so part indexes continue without a gap. The job must be completed, source 'line',
   * in the current control epoch, with an ACTIVE_CONTROL account (the checks of completeJob). A free-mode job skips a lone [[NO_REPLY]] text.
   * Returns true when rows were added.
   */
  async appendRelayDelivery(anchorJobId: string, parts: readonly string[], relayId: string): Promise<boolean> {
    const texts = parts.filter((text) => text.trim() !== '');
    if (texts.length === 0) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query<{ account_id: string; chat_type: WritableConversationKey['chatType']; chat_id: string; creation_epoch: string; free_mode: boolean; source_type: string; status: string }>(
        `SELECT account_id, chat_type, chat_id, creation_epoch, free_mode, source_type, status FROM agent_jobs WHERE job_id = $1 FOR UPDATE`,
        [anchorJobId],
      );
      const row = job.rows[0];
      if (!row || row.source_type !== 'line' || row.status !== 'completed') { await client.query('COMMIT'); return false; }
      const control = await client.query<{ mode: string; control_epoch: string }>(
        `SELECT a.mode, c.control_epoch FROM line_accounts a CROSS JOIN account_control c
         WHERE a.account_id = $1 AND c.singleton = true FOR SHARE OF c, a`, [row.account_id],
      );
      if (row.creation_epoch !== control.rows[0]?.control_epoch || control.rows[0]?.mode !== 'ACTIVE_CONTROL') { await client.query('COMMIT'); return false; }
      if (row.free_mode && texts.length === 1 && texts[0]!.trim() === FREE_MODE_NO_REPLY) {
        await client.query('COMMIT');
        return false;
      }
      const last = await client.query<{ next: number }>('SELECT COALESCE(MAX(part_index), -1) + 1 AS next FROM agent_deliveries WHERE job_id = $1', [anchorJobId]);
      const first = Number(last.rows[0]?.next ?? 0);
      for (const [index, text] of texts.entries()) {
        await client.query(
          `INSERT INTO agent_deliveries (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), anchorJobId, first + index, text, `${anchorJobId}:relay:${relayId}:${index}`, row.account_id, row.chat_type, row.chat_id, row.creation_epoch],
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
      // A follower whose lead did not finish runs again as a normal job. A follower whose lead already ended is settled with it.
      await client.query(
        `UPDATE agent_jobs f SET folded_into = NULL FROM agent_jobs lead
         WHERE f.folded_into = lead.job_id AND f.status = 'queued' AND lead.status NOT IN ('completed', 'failed', 'cancelled')`);
      const endedLeads = await client.query<{ folded_into: string }>(
        "SELECT DISTINCT folded_into FROM agent_jobs WHERE folded_into IS NOT NULL AND status = 'queued'");
      for (const item of endedLeads.rows) await this.settleFoldedIn(client, item.folded_into);
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
