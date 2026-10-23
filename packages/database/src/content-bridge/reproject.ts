import { NativeSourceEnvelopeSchema, type MessageContent } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';
import { loadChatEventNames } from './chat-event-names.js';
import { CONTENT_BRIDGE_RULES, bridgeLiveMessage, bridgeNativeEnvelope, contentTypeAliases, nativeChatEventMids, type BridgeResult, type BridgeRule } from './index.js';

/** Hard limits of the re-projection job (AGENTS.md Runtime resource discipline). */
export const REPROJECTION_BATCH_SIZE = 500;
export const REPROJECTION_SLICE_CPU_MS = 50;

export type ReprojectionOptions = Readonly<{
  /** Cancels between batches; the batch in flight always commits or rolls back as one transaction. */
  signal?: AbortSignal;
  /** Test hook: an alternative rule table (a version bump); defaults to the shipped CONTENT_BRIDGE_RULES. */
  rules?: readonly BridgeRule[];
  /** Test hook only: a smaller batch than the 500-row hard limit. */
  batchSize?: number;
  /** Called after each committed batch. */
  onBatchCommitted?: (batch: { source: BridgeRule['source']; contentType: number | '*'; rows: number }) => void;
}>;
export type ReprojectionResult = Readonly<{ rows: number; batches: number; cancelled: boolean }>;

type CandidateRow = { account_id: string; message_id: string; chat_type: string; chat_id: string; raw: Record<string, unknown>; content: MessageContent | null };


// A source is told apart by what Layer 1 holds: a plain `raw.native` envelope is a native import row; a live worker
// operation (`raw.message`, no decryption failure marker) is a live row. `dpapi` envelopes and contact-only `{}` raws
// cannot be converted and are never selected.
const SOURCE_SQL: Readonly<Record<BridgeRule['source'], string>> = {
  native: `raw ? 'native' AND raw->'native'->>'encoding' = 'plain' AND raw->'native'->>'table' = '_message'`,
  live: `NOT raw ? 'native' AND raw ? 'message' AND NOT raw ? 'contentState'`,
};

function yieldToEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

async function convert(source: BridgeRule['source'], row: CandidateRow, rules: readonly BridgeRule[], client: PoolClient): Promise<BridgeResult | null> {
  if (source === 'native') {
    const parsed = NativeSourceEnvelopeSchema.safeParse(row.raw.native);
    if (!parsed.success) return null;
    const mids = nativeChatEventMids(parsed.data);
    const names = mids.length > 0 ? await loadChatEventNames(client, row.account_id, row.chat_type, row.chat_id, mids) : undefined;
    return bridgeNativeEnvelope(parsed.data, rules, names);
  }
  return bridgeLiveMessage({ raw: row.raw }, rules);
}

/**
 * Re-converts messages one (source, content type) rule at a time. Selection rule:
 * - an exact-type rule selects rows whose `content_rule_version` is below the rule version, AND rows currently projected as
 *   `unsupported` (by the `*` fallback, which stamps its own version): adding an exact rule for a type the fallback already
 *   covered must reach those rows even though their version is not lower;
 * - the `*` fallback rule selects by version only.
 * Written: `content`, `content_rule_version`, a missing `reply_to_message_id`, and for native rows the bridge `kind`
 * (kind is a bridge projection; live rows keep the normalizer's envelope kind). Layer 1 (`raw`) is never touched.
 * Each batch is its own transaction, so a cancel keeps the committed batches. Progress inside a run is a keyset cursor over
 * (account_id, message_id), because an exact rule that still yields `unsupported` is re-selected by the second branch;
 * a restart resumes by predicate. Cost note: a type whose rows are not covered by the partial index falls back to a scan.
 */
export async function reprojectContent(pool: Pool, options: ReprojectionOptions = {}): Promise<ReprojectionResult> {
  const batchSize = Math.min(REPROJECTION_BATCH_SIZE, Math.max(1, options.batchSize ?? REPROJECTION_BATCH_SIZE));
  const rules = options.rules ?? CONTENT_BRIDGE_RULES;
  const allAliases = [...new Set(rules.flatMap((rule) => typeof rule.contentType === 'number' ? [rule.contentType] : []))].flatMap(contentTypeAliases);
  let rows = 0;
  let batches = 0;
  for (const rule of rules) {
    if (rule.version < 1) continue;
    // Live rule 15 also covers legacy rows that carry a location struct under contentType 0 / NONE (the bridge types them 15).
    const legacyLocation = rule.source === 'live' && rule.contentType === 15
      ? ` OR (raw->'message'->>'contentType' IN ('0','NONE') AND raw->'message' ? 'location')` : '';
    const typeSql = rule.contentType === '*'
      ? `(raw->'message'->>'contentType' IS NULL OR NOT (raw->'message'->>'contentType' = ANY($3::text[])))`
      : `(raw->'message'->>'contentType' = ANY($3::text[])${legacyLocation})`;
    const versionSql = rule.contentType === '*' ? 'content_rule_version < $1'
      : "(content_rule_version < $1 OR content->>'type' = 'unsupported')";
    let lastAccount = '';
    let lastMessage = '';
    const aliases = rule.contentType === '*' ? allAliases : contentTypeAliases(rule.contentType);
    for (;;) {
      if (options.signal?.aborted) return { rows, batches, cancelled: true };
      const client = await pool.connect();
      let committed = 0;
      try {
        await client.query('BEGIN');
        const candidates = await client.query<CandidateRow>(
          `SELECT account_id,message_id,chat_type,chat_id,raw,content FROM messages
            WHERE ${SOURCE_SQL[rule.source]} AND ${versionSql} AND ${typeSql} AND (account_id,message_id) > ($4,$5)
            ORDER BY account_id,message_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [rule.version, batchSize, aliases, lastAccount, lastMessage]);
        const updates: Array<{ account_id: string; message_id: string; content: MessageContent | null; version: number; reply: string | null; kind: string | null }> = [];
        let sliceStart = performance.now();
        for (const row of candidates.rows) {
          const bridged = await convert(rule.source, row, rules, client);
          // An unreadable row only gets its version stamped (existing content kept) so the predicate always makes progress.
          updates.push({ account_id: row.account_id, message_id: row.message_id, content: bridged ? bridged.content : row.content,
            version: rule.version, reply: bridged?.replyToMessageId ?? null, kind: rule.source === 'native' && bridged ? bridged.kind : null });
          if (performance.now() - sliceStart > REPROJECTION_SLICE_CPU_MS) { await yieldToEventLoop(); sliceStart = performance.now(); }
        }
        if (updates.length > 0) {
          await client.query(
            `UPDATE messages m SET content=u.content,content_rule_version=u.version,
               reply_to_message_id=COALESCE(m.reply_to_message_id,u.reply),kind=COALESCE(u.kind,m.kind)
             FROM jsonb_to_recordset($1::jsonb) AS u(account_id text,message_id text,content jsonb,version integer,reply text,kind text)
             WHERE m.account_id=u.account_id AND m.message_id=u.message_id`,
            [JSON.stringify(updates)]);
        }
        await client.query('COMMIT');
        committed = updates.length;
        const last = updates.at(-1);
        if (last) { lastAccount = last.account_id; lastMessage = last.message_id; }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (committed === 0) break;
      rows += committed;
      batches++;
      options.onBatchCommitted?.({ source: rule.source, contentType: rule.contentType, rows: committed });
      await yieldToEventLoop();
    }
  }
  return { rows, batches, cancelled: false };
}
