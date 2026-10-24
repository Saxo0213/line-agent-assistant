import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ATTACHMENT_LIMITS, type AgentAttachmentUpload } from '@line-agent/contracts';
import { sanitizeAttachmentName, sniffAttachment } from './agent-attachments.js';

export const MANUAL_MEDIA_ROOT = join(tmpdir(), 'linejs-manual-media');

export class ManualMediaError extends Error {
  constructor(readonly code: 'MANUAL_MEDIA_INVALID' | 'MANUAL_MEDIA_LIMIT' | 'MANUAL_MEDIA_STAGE_FAILED', message: string) {
    super(message);
    this.name = 'ManualMediaError';
  }
}

export function validateManualMedia(files: readonly AgentAttachmentUpload[]): void {
  if (files.length > AGENT_ATTACHMENT_LIMITS.maxFiles) throw new ManualMediaError('MANUAL_MEDIA_LIMIT', 'Choose up to 10 files.');
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || file.name.length < 1 || file.name.length > AGENT_ATTACHMENT_LIMITS.maxNameLength
      || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1) {
      throw new ManualMediaError('MANUAL_MEDIA_INVALID', 'A file name or file is invalid.');
    }
    if (file.bytes.byteLength > AGENT_ATTACHMENT_LIMITS.maxFileBytes) throw new ManualMediaError('MANUAL_MEDIA_LIMIT', 'Each file must be 20 MB or smaller.');
    if (sanitizeAttachmentName(file.name) !== file.name || Buffer.byteLength(file.name) > 180) {
      throw new ManualMediaError('MANUAL_MEDIA_INVALID', 'A file name is not supported.');
    }
    total += file.bytes.byteLength;
  }
  if (total > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) throw new ManualMediaError('MANUAL_MEDIA_LIMIT', 'Attachments must total 50 MB or less.');
}

export async function stageManualMedia(files: readonly AgentAttachmentUpload[], root = MANUAL_MEDIA_ROOT, signal?: AbortSignal) {
  validateManualMedia(files);
  if (signal?.aborted) throw new ManualMediaError('MANUAL_MEDIA_STAGE_FAILED', 'Attachment staging was cancelled.');
  if (files.length === 0) return { items: [] as Array<{ filePath: string; fileName: string; kind: 'image' | 'file'; sizeBytes: number; sha256: string }>, cleanup: async () => undefined };
  let directory: string | undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Manual media staging root is invalid');
    directory = await mkdtemp(join(root, 'send-'));
    const items = [] as Array<{ filePath: string; fileName: string; kind: 'image' | 'file'; sizeBytes: number; sha256: string }>;
    for (const file of files) {
      if (signal?.aborted) throw new ManualMediaError('MANUAL_MEDIA_STAGE_FAILED', 'Attachment staging was cancelled.');
      const { kind } = sniffAttachment(file.bytes, file.name);
      if (kind === 'image' && file.bytes.byteLength > 20 * 1024 * 1024) throw new ManualMediaError('MANUAL_MEDIA_LIMIT', 'Images must be 20 MB or smaller.');
      const filePath = join(directory, randomUUID());
      await writeFile(filePath, file.bytes, { flag: 'wx' });
      if (signal?.aborted) throw new ManualMediaError('MANUAL_MEDIA_STAGE_FAILED', 'Attachment staging was cancelled.');
      items.push({ filePath, fileName: file.name, kind, sizeBytes: file.bytes.byteLength,
        sha256: createHash('sha256').update(file.bytes).digest('hex') });
    }
    const stagedDirectory = directory;
    return { items, cleanup: () => rm(stagedDirectory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory ?? '', { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ManualMediaError) throw error;
    throw new ManualMediaError('MANUAL_MEDIA_STAGE_FAILED', 'Could not stage the selected files.');
  }
}

/** Startup recovery examines a bounded number of entries and removes only old directories in this dedicated temp root. */
export async function cleanupStaleManualMedia(root = MANUAL_MEDIA_ROOT, now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
    entries = (await readdir(root)).slice(0, 100);
  } catch { return; }
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith('send-')) return;
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink() && now - info.mtimeMs > 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
    } catch { /* best effort startup cleanup */ }
  }));
}
