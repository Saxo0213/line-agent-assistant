import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ATTACHMENT_LIMITS, type AgentProvider } from '@line-agent/contracts';
import { PEER_CONTACT_JOIN, SENDER_CONTACT_JOIN, SENDER_NAME_SQL, parseLineStickerDescriptor } from '@line-agent/database';
import { ATTACHMENT_DIRECTORY, assertWithin, humanSize, jobDirectory, removeJobAttachments, sanitizeAttachmentName, sniffAttachment, uniqueName, type ResolvedAttachment } from './agent-attachments.js';

/**
 * Reply context of a LINE job. When the trigger message replies to an earlier message, the run request names the
 * quoted message and carries its ready files. Run request only: the stored job prompt does not change.
 */
export interface ReplyContextInput {
  jobId: string;
  accountId: string;
  chatType: string;
  chatId: string;
  messageId: string;
  workspacePath: string;
  provider: AgentProvider;
}
export interface ReplyContext { section: string; files: ResolvedAttachment[] }
export type ReplyContextResolver = (input: ReplyContextInput) => Promise<ReplyContext | null>;

export interface ReplyContextDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
export interface ReplyContextDependencies {
  database: ReplyContextDatabase;
  /** The only way to get a stored file path. This module never builds one. */
  /** Longest wait for a quoted file that is still downloading. */
  downloadWaitMs?: number;
  attachments: {
    resolveReadyPath(attachmentId: string): Promise<string | null>;
    /** The automatic download path (never the manual one). Resolves true when the file is stored. */
    downloadById?(attachmentId: string, signal?: AbortSignal): Promise<boolean>;
  };
}

export const REPLY_TEXT_LIMIT = 2000;
export const REPLY_NESTED_TEXT_LIMIT = 300;
export const REPLY_DETAIL_LIMIT = 500;
export const REPLY_DOWNLOAD_WAIT_MS = 30_000;
const MISSING_LINE = '（被回覆的訊息不在系統紀錄中）';
const HEADER = '\n\n---\n這則訊息是在回覆以下訊息：\n';
const KIND_LABELS: Record<string, string> = { image: '圖片', video: '影片', audio: '語音', file: '檔案', sticker: '貼圖' };
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

interface QuotedRow {
  sender_name: string | null; kind: string; text_content: string | null; occurred_at: Date | string; withdrawn: boolean | null;
  reply_to_message_id: string | null; content: Record<string, unknown> | null; raw: unknown;
}
interface AttachmentRow {
  attachment_id: string; kind: string; name: string | null; status: string; size_bytes: string | number | null; sha256: string | null; error: string | null; system_login: boolean;
}

const kindLabel = (kind: string): string => `[${KIND_LABELS[kind] ?? kind}]`;

/** "M/D HH:mm" in Asia/Taipei. */
export function formatReplyTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '時間不明';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

function quotedBody(row: QuotedRow, limit = REPLY_TEXT_LIMIT): string {
  const text = row.text_content ?? '';
  const body = text.length === 0 ? kindLabel(row.kind) : text.length > limit ? `${text.slice(0, limit)}…` : text;
  return row.withdrawn ? `${body}（已收回）` : body;
}

const oneLine = (value: string): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > REPLY_DETAIL_LIMIT ? `${text.slice(0, REPLY_DETAIL_LIMIT)}…` : text;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? oneLine(value) : null);
function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One detail line from the stored content and sticker data of the quoted message, or null. Nothing is downloaded. */
export function contentDetail(row: Pick<QuotedRow, 'kind' | 'content' | 'raw'>): string | null {
  if (row.kind === 'sticker') {
    const sticker = parseLineStickerDescriptor(row.raw);
    return sticker ? `貼圖：${sticker.altText ? oneLine(sticker.altText) : '無文字'}（STKID ${sticker.stickerId}）` : null;
  }
  const content = row.content;
  if (!content || typeof content.type !== 'string') return null;
  switch (content.type) {
    case 'location': {
      const place = [str(content.title), str(content.address)].filter((part): part is string => part !== null).join(' / ');
      const lat = content.latitude; const lng = content.longitude;
      const point = typeof lat === 'number' && typeof lng === 'number' ? `（${lat}, ${lng}）` : '';
      return place || point ? `位置：${place}${point}` : null;
    }
    case 'contact': { const name = str(content.displayName); return name ? `聯絡人名片：${name}` : null; }
    case 'rich': { const alt = str(content.altText); return alt ? `替代文字：${alt}` : null; }
    case 'media': return typeof content.durationMs === 'number' ? `長度：${duration(content.durationMs)}` : null;
    case 'event': { const text = str(content.text); return text ? `事件：${text}` : null; }
    case 'unsupported': { const text = str(content.fallbackText); return text ? `不支援的內容：${text}` : null; }
    default: return null;
  }
}

/** "[圖片] name（size）" with the parts that are known. */
const fileLabel = (row: AttachmentRow, name: string | null, size: number | null): string =>
  `${kindLabel(row.kind)}${name ? ` ${oneLine(name)}` : ''}${size !== null && Number.isFinite(size) ? `（${humanSize(size)}）` : ''}`;

const notReadyReason = (row: AttachmentRow): string =>
  row.status === 'queued' && row.error === 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' ? '外部監控來源無法下載' : '尚未下載';

const VERIFY_FAILED = '檔案驗證失敗';

/** Copies one ready file into the job directory and checks the copy against the stored size and SHA-256. */
async function copyReadyFile(input: { row: AttachmentRow; source: string; directory: string; jobId: string; index: number; used: Set<string> }):
  Promise<{ file: ResolvedAttachment } | { reason: string }> {
  const { row, source, directory, jobId, index, used } = input;
  const expectedSize = Number(row.size_bytes);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || !row.sha256) return { reason: VERIFY_FAILED };
  const expectedHash = row.sha256.toLowerCase();
  let name = uniqueName(sanitizeAttachmentName(row.name ?? `${row.kind}-${index + 1}`, index), used);
  const target = join(directory, name);
  // A copy that fails a check is deleted, so no unverified bytes stay in the job directory.
  const fail = async () => { await rm(join(directory, name), { force: true }).catch(() => undefined); return { reason: VERIFY_FAILED }; };
  try {
    assertWithin(directory, target);
    await copyFile(source, target);
    const copied = await readFile(target);
    if (copied.byteLength !== expectedSize || createHash('sha256').update(copied).digest('hex') !== expectedHash) return await fail();
    const sniffed = sniffAttachment(copied, name);
    if (sniffed.kind === 'image' && !/\.[A-Za-z0-9]{1,8}$/.test(name)) {
      // An image without an extension gets one from its magic bytes, so the Agent tools open it as an image.
      const renamed = uniqueName(`${name}${IMAGE_EXTENSIONS[sniffed.mime] ?? ''}`, used);
      if (renamed !== name) { await rename(target, join(directory, renamed)); name = renamed; }
    }
    return { file: { name, size: expectedSize, kind: sniffed.kind, mime: sniffed.mime, sha256: expectedHash,
      relativePath: `${ATTACHMENT_DIRECTORY}/${jobId}/${name}`, absolutePath: join(directory, name) } };
  } catch { return await fail(); }
}

const QUOTED_SQL = `SELECT ${SENDER_NAME_SQL} AS sender_name, m.kind, m.text_content, m.occurred_at, m.reply_to_message_id, m.content, m.raw,
     (COALESCE(m.content->>'type', '') = 'unsent' OR m.raw ? 'sourceDeleted') AS withdrawn
   FROM messages m
   LEFT JOIN line_accounts la ON la.account_id = m.account_id
   LEFT JOIN conversations c ON c.account_id = m.account_id AND c.chat_type = m.chat_type AND c.chat_id = m.chat_id
   LEFT JOIN conversation_members cm ON cm.account_id = m.account_id AND cm.chat_type = m.chat_type
     AND cm.chat_id = m.chat_id AND cm.member_id = m.sender_id
   ${SENDER_CONTACT_JOIN}
   ${PEER_CONTACT_JOIN}
   WHERE m.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND m.message_id=$4`;

const ATTACHMENTS_SQL = `SELECT a.attachment_id, a.kind, a.name, a.status, a.size_bytes, a.sha256, a.error,
     (COALESCE(la.connection_mode, 'SYSTEM_LOGIN') = 'SYSTEM_LOGIN') AS system_login
   FROM attachments a LEFT JOIN line_accounts la ON la.account_id = a.account_id
   WHERE a.account_id=$1 AND a.chat_type=$2 AND a.chat_id=$3 AND a.message_id=$4 ORDER BY a.created_at, a.attachment_id`;

/** True for a row the automatic download path may still fetch. External Monitor rows, failed rows and expired rows never qualify. */
const waitingForDownload = (row: AttachmentRow): boolean =>
  row.system_login && (row.status === 'queued' || row.status === 'downloading') && row.error !== 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE';

export function createReplyContextResolver(dependencies: ReplyContextDependencies): ReplyContextResolver {
  const { database, attachments } = dependencies;
  return async (input) => {
    const source = (await database.query(
      'SELECT reply_to_message_id FROM messages WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=$4',
      [input.accountId, input.chatType, input.chatId, input.messageId])).rows[0] as { reply_to_message_id: string | null } | undefined;
    const quotedId = source?.reply_to_message_id;
    if (!quotedId) return null;

    // Every lookup is scoped to the account and chat of the trigger message.
    const fetchMessage = async (messageId: string): Promise<QuotedRow | undefined> =>
      (await database.query(QUOTED_SQL, [input.accountId, input.chatType, input.chatId, messageId])).rows[0] as QuotedRow | undefined;
    const senderOf = (row: QuotedRow) => row.sender_name?.trim() || '未知成員';
    const quoted = await fetchMessage(quotedId);
    if (!quoted) return { section: `${HEADER}${MISSING_LINE}`, files: [] };

    const lines = [`[${senderOf(quoted)}] ${formatReplyTime(quoted.occurred_at)}：${quotedBody(quoted)}`];
    const detail = contentDetail(quoted);
    if (detail) lines.push(detail);
    // One level only: the message that the quoted message replied to. No files and no further levels.
    if (quoted.reply_to_message_id) {
      const parent = await fetchMessage(quoted.reply_to_message_id).catch(() => undefined);
      if (parent) lines.push(`（該訊息回覆了：[${senderOf(parent)}] ${formatReplyTime(parent.occurred_at)}：${quotedBody(parent, REPLY_NESTED_TEXT_LIMIT)}）`);
    }

    const readRows = async () => (await database.query(ATTACHMENTS_SQL, [input.accountId, input.chatType, input.chatId, quotedId])).rows as AttachmentRow[];
    let rows = await readRows();
    const pending = rows.filter(waitingForDownload);
    if (pending.length > 0 && attachments.downloadById) {
      // Wait at most 30 seconds in total for the automatic download path, then read the rows again.
      const signal = AbortSignal.timeout(dependencies.downloadWaitMs ?? REPLY_DOWNLOAD_WAIT_MS);
      await Promise.allSettled(pending.map((row) => attachments.downloadById!(row.attachment_id, signal)));
      rows = await readRows();
    }

    const files: ResolvedAttachment[] = [];
    if (rows.length > 0) {
      const workspaceRoot = await realpath(input.workspacePath);
      const directory = jobDirectory(workspaceRoot, input.jobId);
      // A retried job starts from an empty directory, so a copy never collides with an older one.
      await removeJobAttachments(workspaceRoot, input.jobId);
      let total = 0;
      let prepared = false;
      const used = new Set<string>();
      try {
        for (const [index, row] of rows.entries()) {
          const knownSize = row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes);
          const skip = (reason: string) => { const label = fileLabel(row, row.name, knownSize); lines.push(`${label}${label === kindLabel(row.kind) ? ' ' : ''}未附上：${reason}`); };
          if (row.status !== 'ready') { skip(notReadyReason(row)); continue; }
          const size = Number(row.size_bytes);
          if (!Number.isFinite(size) || size < 0) { skip(VERIFY_FAILED); continue; }
          if (files.length >= AGENT_ATTACHMENT_LIMITS.maxFiles || size > AGENT_ATTACHMENT_LIMITS.maxFileBytes
            || total + size > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) { skip('檔案過大'); continue; }
          const path = await attachments.resolveReadyPath(row.attachment_id).catch(() => null);
          if (!path) { skip(VERIFY_FAILED); continue; }
          if (!prepared) {
            await mkdir(directory, { recursive: true });
            assertWithin(workspaceRoot, await realpath(directory));
            prepared = true;
          }
          const outcome = await copyReadyFile({ row, source: path, directory, jobId: input.jobId, index, used });
          if ('reason' in outcome) { skip(outcome.reason); continue; }
          files.push(outcome.file);
          total += outcome.file.size;
          lines.push(`${fileLabel(row, outcome.file.name, outcome.file.size)}已附上`);
        }
      } finally {
        // With no accepted file, nothing stays on disk. Accepted files stay until the job ends.
        if (files.length === 0) await removeJobAttachments(workspaceRoot, input.jobId);
      }
    }
    return { section: `${HEADER}${lines.join('\n')}`, files };
  };
}
