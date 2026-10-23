import { createHash } from 'node:crypto';
import { mkdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AGENT_ATTACHMENT_LIMITS, type AgentAttachmentUpload, type AgentProvider, type AgentStoredAttachment } from '@line-agent/contracts';

/**
 * Files attached in the local Agent room. Main owns the bytes: they are written under
 * `<workspace>\.agent-attachments\<jobId>\` (inside the existing Agent workspace, so no new tool grant is needed),
 * their type comes from magic bytes, and no renderer-supplied path is ever used.
 */
export const ATTACHMENT_DIRECTORY = '.agent-attachments';
export const DEFAULT_ATTACHMENT_PROMPT = '請查看附件。';
const MAX_STORED_NAME_BYTES = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const SAFE_TEXT_MIME: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
};

export class AgentAttachmentError extends Error {
  constructor(readonly code: 'ATTACHMENT_LIMIT' | 'ATTACHMENT_WRITE_FAILED' | 'ATTACHMENT_MISSING' | 'ATTACHMENT_INVALID', message: string) {
    super(message);
    this.name = 'AgentAttachmentError';
  }
}

export const ATTACHMENT_LIMIT_MESSAGE = '附件超過上限（最多 10 個檔案、單檔 20 MB、合計 50 MB）。';
export const ATTACHMENT_MISSING_MESSAGE = '附件檔案已遺失，無法執行這項工作。請重新傳送附件。';

/** Re-checks every limit in Main; the zod schema is not trusted as the only gate. */
export function validateUploads(uploads: readonly AgentAttachmentUpload[]): void {
  if (uploads.length > AGENT_ATTACHMENT_LIMITS.maxFiles) throw new AgentAttachmentError('ATTACHMENT_LIMIT', ATTACHMENT_LIMIT_MESSAGE);
  let total = 0;
  for (const upload of uploads) {
    if (typeof upload.name !== 'string' || upload.name.length < 1 || upload.name.length > AGENT_ATTACHMENT_LIMITS.maxNameLength
      || !(upload.bytes instanceof Uint8Array)) throw new AgentAttachmentError('ATTACHMENT_INVALID', '附件資料無效。');
    if (upload.bytes.byteLength > AGENT_ATTACHMENT_LIMITS.maxFileBytes) throw new AgentAttachmentError('ATTACHMENT_LIMIT', ATTACHMENT_LIMIT_MESSAGE);
    total += upload.bytes.byteLength;
  }
  if (total > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) throw new AgentAttachmentError('ATTACHMENT_LIMIT', ATTACHMENT_LIMIT_MESSAGE);
}

/** Same rules as line-worker's `sanitizeAttachmentFilename`, but lenient: a hostile name is repaired, not rejected. */
export function sanitizeAttachmentName(value: string, index = 0): string {
  const fallback = `file-${index + 1}`;
  const wellFormed = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_');
  let name = wellFormed.split(/[\\/]+/).filter((part: string) => part.length > 0).pop() ?? '';
  name = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[ ]+/, '').replace(/[. ]+$/, '');
  if (name.length === 0 || name === '.' || name === '..') return fallback;
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  if (Buffer.byteLength(name) > MAX_STORED_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : '';
    let stem = extension ? name.slice(0, dot) : name;
    while (stem.length > 1 && Buffer.byteLength(stem) + Buffer.byteLength(extension) > MAX_STORED_NAME_BYTES) stem = stem.slice(0, -1);
    name = `${stem}${extension}`.replace(/[. ]+$/, '');
    if (name.length === 0) return fallback;
  }
  return name;
}

function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let counter = 2; used.has(candidate.toLowerCase()); counter += 1) candidate = `${stem} (${counter})${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Type from magic bytes only; the client's mime is never consulted. */
export function sniffAttachment(bytes: Uint8Array, name: string): { kind: 'image' | 'file'; mime: string } {
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' };
  if (bytes.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' };
  if (bytes.length >= 6 && (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return { kind: 'image', mime: 'image/gif' };
  if (bytes.length >= 12 && startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { kind: 'image', mime: 'image/webp' };
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return { kind: 'file', mime: SAFE_TEXT_MIME[extension] ?? 'application/octet-stream' };
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new AgentAttachmentError('ATTACHMENT_INVALID', '附件路徑無效。');
}

function jobDirectory(workspace: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new AgentAttachmentError('ATTACHMENT_INVALID', '附件資料無效。');
  return join(workspace, ATTACHMENT_DIRECTORY, jobId);
}

/** Removes one job's attachment directory. Best effort and idempotent. */
export async function removeJobAttachments(workspace: string, jobId: string): Promise<void> {
  try { await rm(jobDirectory(workspace, jobId), { recursive: true, force: true }); } catch { /* nothing left to clean up */ }
}

/**
 * Writes every file under `<workspace>\.agent-attachments\<jobId>\` and returns the metadata to persist.
 * Any failure removes the job directory before throwing, so nothing is left behind.
 */
export async function storeAttachments(input: { workspace: string; jobId: string; uploads: readonly AgentAttachmentUpload[] }): Promise<AgentStoredAttachment[]> {
  validateUploads(input.uploads);
  if (input.uploads.length === 0) return [];
  let workspaceRoot: string;
  try { workspaceRoot = await realpath(input.workspace); }
  catch { throw new AgentAttachmentError('ATTACHMENT_WRITE_FAILED', '無法寫入附件：Agent 工作目錄不可用。'); }
  const directory = jobDirectory(workspaceRoot, input.jobId);
  try {
    await mkdir(directory, { recursive: true });
    const realDirectory = await realpath(directory);
    assertWithin(workspaceRoot, realDirectory);
    const used = new Set<string>();
    const stored: AgentStoredAttachment[] = [];
    for (const [index, upload] of input.uploads.entries()) {
      const name = uniqueName(sanitizeAttachmentName(upload.name, index), used);
      const target = join(realDirectory, name);
      assertWithin(realDirectory, target);
      await writeFile(target, upload.bytes, { flag: 'wx' });
      const { kind, mime } = sniffAttachment(upload.bytes, name);
      stored.push({ name, size: upload.bytes.byteLength, kind, mime, sha256: createHash('sha256').update(upload.bytes).digest('hex'),
        relativePath: `${ATTACHMENT_DIRECTORY}/${input.jobId}/${name}` });
    }
    return stored;
  } catch (error) {
    await removeJobAttachments(workspaceRoot, input.jobId);
    if (error instanceof AgentAttachmentError) throw error;
    throw new AgentAttachmentError('ATTACHMENT_WRITE_FAILED', '附件寫入失敗，未建立工作。請確認磁碟空間後再試。');
  }
}

export type ResolvedAttachment = AgentStoredAttachment & { absolutePath: string };

/** Run-time lookup: every stored file must still be an existing regular file inside the job directory. */
export async function resolveStoredAttachments(workspace: string, jobId: string, attachments: readonly AgentStoredAttachment[]): Promise<ResolvedAttachment[]> {
  const missing = () => new AgentAttachmentError('ATTACHMENT_MISSING', ATTACHMENT_MISSING_MESSAGE);
  try {
    const workspaceRoot = await realpath(workspace);
    const directory = await realpath(jobDirectory(workspaceRoot, jobId));
    assertWithin(workspaceRoot, directory);
    const resolved: ResolvedAttachment[] = [];
    for (const attachment of attachments) {
      if (!attachment.relativePath.startsWith(`${ATTACHMENT_DIRECTORY}/${jobId}/`)) throw missing();
      const absolutePath = resolve(workspaceRoot, ...attachment.relativePath.split('/'));
      assertWithin(directory, absolutePath);
      if ((await lstat(absolutePath)).isSymbolicLink()) throw missing();
      const real = await realpath(absolutePath);
      assertWithin(directory, real);
      const info = await stat(real);
      if (!info.isFile() || info.size !== attachment.size) throw missing();
      resolved.push({ ...attachment, absolutePath: real });
    }
    return resolved;
  } catch { throw missing(); }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The section appended to the run request only; the stored job prompt never contains it. */
export function attachmentPromptSection(provider: AgentProvider, attachments: readonly AgentStoredAttachment[]): string {
  const lines = attachments.map((item, index) => {
    const imageNote = item.kind === 'image'
      ? provider === 'claude' ? ' 這是圖片，請用 Read 讀取後再回答。' : ' 這是圖片，已隨訊息附上。'
      : '';
    return `[${index + 1}] ${item.name}（${item.mime}，${humanSize(item.size)}）路徑：${item.relativePath}${imageNote}`;
  });
  return `\n\n---\n附件（位於工作目錄內，請直接讀取）：\n${lines.join('\n')}`;
}
