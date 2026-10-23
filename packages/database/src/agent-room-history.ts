import {
  AGENT_ROOM_HISTORY_DEFAULT_LIMIT,
  AGENT_ROOM_HISTORY_PAGE_MAX_BYTES,
  AGENT_ROOM_HISTORY_PROMPT_MAX_CHARS,
  AGENT_ROOM_HISTORY_REPLY_MAX_CHARS,
  McpAgentRoomHistoryInputSchema,
  decodeAgentRoomHistoryCursor,
  encodeAgentRoomHistoryCursor,
  type McpAgentRoomHistoryItem,
  type McpAgentRoomHistoryPage,
} from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { McpDomainError } from './mcp-token-repository.js';
import type { SharedAdminChat } from './agent-repository.js';

interface HistoryRow {
  job_id: string;
  origin: McpAgentRoomHistoryItem['origin'];
  provider: McpAgentRoomHistoryItem['provider'];
  status: McpAgentRoomHistoryItem['status'];
  created_at: Date;
  created_at_cursor: string;
  prompt: string;
  prompt_chars: string | number;
  reply: string | null;
  reply_chars: string | number | null;
}

/** Escapes LIKE wildcards so the keyword always matches literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Reads the shared Agent room conversation history newest first: account-less `ui` jobs, plus the LINE jobs of the
 * admin-direct chat while `shared` (a fresh `findSharedAdminChat` result from the caller's transaction) is non-null.
 * Authorization is the caller's job; this only reads `agent_jobs` and `agent_outputs`.
 * Text is cut in SQL so oversized rows are never fully transferred.
 */
export async function queryAgentRoomHistory(
  queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  rawInput: unknown,
  shared: SharedAdminChat | null,
): Promise<McpAgentRoomHistoryPage> {
  const parsed = McpAgentRoomHistoryInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new McpDomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Agent room history query.');
  }
  const input = parsed.data;
  const limit = input.limit ?? AGENT_ROOM_HISTORY_DEFAULT_LIMIT;
  const cursor = input.cursor === undefined ? null : decodeAgentRoomHistoryCursor(input.cursor);

  const params: unknown[] = [];
  const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  const conditions = [shared
    ? `((j.source_type = 'ui' AND j.account_id IS NULL) OR (j.source_type = 'line' AND j.account_id = ${bind(shared.accountId)} AND j.chat_type = 'direct' AND j.chat_id = ${bind(shared.adminMid)}))`
    : "(j.source_type = 'ui' AND j.account_id IS NULL)"];
  if (input.provider) conditions.push(`j.provider = ${bind(input.provider)}`);
  if (input.from) conditions.push(`j.created_at >= ${bind(new Date(input.from).toISOString())}::timestamptz`);
  // `to` is inclusive at millisecond precision; created_at keeps microseconds.
  if (input.to) conditions.push(`j.created_at < ${bind(new Date(input.to).toISOString())}::timestamptz + interval '1 millisecond'`);
  if (input.query) {
    const pattern = bind(`%${escapeLikePattern(input.query)}%`);
    conditions.push(`(j.prompt ILIKE ${pattern} ESCAPE '\\' OR o.final_text ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (cursor) {
    conditions.push(`(j.created_at, j.job_id) < (${bind(cursor.createdAt)}::timestamptz, ${bind(cursor.jobId)}::uuid)`);
  }
  const result = await queryable.query<HistoryRow>(
    `SELECT j.job_id::text AS job_id, CASE WHEN j.source_type = 'ui' THEN 'agent_room' ELSE 'line_admin_direct' END AS origin, j.provider, j.status, j.created_at,
            to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
            left(j.prompt, ${AGENT_ROOM_HISTORY_PROMPT_MAX_CHARS}) AS prompt, char_length(j.prompt) AS prompt_chars,
            left(o.final_text, ${AGENT_ROOM_HISTORY_REPLY_MAX_CHARS}) AS reply, char_length(o.final_text) AS reply_chars
     FROM agent_jobs j
     LEFT JOIN agent_outputs o ON o.job_id = j.job_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY j.created_at DESC, j.job_id DESC
     LIMIT ${bind(limit + 1)}`,
    params,
  );

  const items: McpAgentRoomHistoryItem[] = [];
  const cursors: string[] = [];
  let bytes = JSON.stringify({ items: [], nextCursor: null }).length + 64;
  let capped = false;
  for (const row of result.rows.slice(0, limit)) {
    const item: McpAgentRoomHistoryItem = {
      origin: row.origin,
      jobId: row.job_id,
      provider: row.provider,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      prompt: row.prompt,
      reply: row.reply,
      promptTruncated: Number(row.prompt_chars) > AGENT_ROOM_HISTORY_PROMPT_MAX_CHARS,
      replyTruncated: row.reply_chars !== null && Number(row.reply_chars) > AGENT_ROOM_HISTORY_REPLY_MAX_CHARS,
    };
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (items.length > 0 && bytes + size > AGENT_ROOM_HISTORY_PAGE_MAX_BYTES) { capped = true; break; }
    bytes += size;
    items.push(item);
    cursors.push(encodeAgentRoomHistoryCursor({ createdAt: row.created_at_cursor, jobId: row.job_id }));
  }
  const hasMore = capped || result.rows.length > limit;
  return { items, nextCursor: hasMore && cursors.length > 0 ? cursors[cursors.length - 1]! : null };
}
