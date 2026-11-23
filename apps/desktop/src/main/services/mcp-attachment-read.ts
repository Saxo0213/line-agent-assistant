import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ATTACHMENT_LIMITS, type McpReadMessageAttachmentOutput } from '@line-agent/contracts';
import { ATTACHMENT_DIRECTORY, assertWithin, copyReadyFile, jobDirectory } from './agent-attachments.js';

/** The attachment fields that read_message_attachment needs. */
export interface ReadableAttachment {
  attachmentId: string;
  kind: McpReadMessageAttachmentOutput['kind'];
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  status: McpReadMessageAttachmentOutput['status'];
}

/** Narrow view of the attachment store. The caller already checked that the job may read the attachment. */
export interface MessageAttachmentAccess {
  getAttachment(attachmentId: string): Promise<ReadableAttachment | null>;
  /** Copies the same file from the local Downloads folder. It never uses the network. */
  recoverFromLocalDownloads(attachmentId: string): Promise<'recovered' | 'not_found' | 'not_eligible'>;
  /** The only source of a stored file path. This module never builds one. */
  resolveReadyPath(attachmentId: string): Promise<string | null>;
}

const MAX_SCAN_ENTRIES = 200;
const COPY_ATTEMPTS = 2;

const REASONS = {
  expired: 'The file is not on this computer. It expired before a download and no same file was found in the Downloads folder.',
  failed: 'The file is not on this computer. The download failed and no same file was found in the Downloads folder.',
  queued: 'The file is not on this computer yet. It has not been downloaded.',
  downloading: 'The file is still downloading. Try again later.',
  missing: 'The stored file is missing on this computer.',
  tooLarge: `The file is larger than the ${Math.floor(AGENT_ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MB limit for Agent files.`,
  workspace: 'The job workspace is not available.',
  noFileRead: 'This job cannot read files.',
  copy: 'The file could not be copied and verified.',
} as const;

/**
 * Gives one job a verified local copy of one attachment under `<workspace>/.agent-attachments/<jobId>/`.
 * An expired or failed attachment is first recovered from the local Downloads folder. Nothing is downloaded from LINE.
 * A copy that already exists in the job directory with the same bytes is reused. No other file is overwritten.
 */
export async function readMessageAttachmentForJob(
  access: MessageAttachmentAccess,
  input: { attachmentId: string; displayName: string | null; jobId: string; fileAccess: { workspacePath: string; fileRead: boolean } | null },
  signal?: AbortSignal,
): Promise<McpReadMessageAttachmentOutput> {
  let attachment = await access.getAttachment(input.attachmentId);
  if (!attachment) throw new Error('The attachment disappeared after the access check.');
  if (attachment.status === 'expired' || attachment.status === 'failed') {
    const recovered = await access.recoverFromLocalDownloads(input.attachmentId).catch(() => 'not_found' as const);
    if (recovered === 'recovered') attachment = await access.getAttachment(input.attachmentId) ?? attachment;
  }
  signal?.throwIfAborted();
  const known = attachment;
  const unavailable = (reason: string): McpReadMessageAttachmentOutput => ({
    attachmentId: known.attachmentId, name: input.displayName ?? known.name, kind: known.kind, mimeType: known.mimeType,
    sizeBytes: known.sizeBytes, status: known.status, available: false, relativePath: null, absolutePath: null, reason,
  });
  // Without a run directory or a file-read grant, the Agent could not open a copy, so no copy is made.
  if (!input.fileAccess) return unavailable(REASONS.workspace);
  if (!input.fileAccess.fileRead) return unavailable(REASONS.noFileRead);
  if (known.status !== 'ready') return unavailable(REASONS[known.status]);
  if (known.sizeBytes !== null && known.sizeBytes > AGENT_ATTACHMENT_LIMITS.maxFileBytes) return unavailable(REASONS.tooLarge);
  const source = await access.resolveReadyPath(input.attachmentId).catch(() => null);
  if (!source) return unavailable(REASONS.missing);

  let workspaceRoot: string;
  let directory: string;
  try {
    workspaceRoot = await realpath(input.fileAccess.workspacePath);
    directory = jobDirectory(workspaceRoot, input.jobId);
    await mkdir(directory, { recursive: true });
    assertWithin(workspaceRoot, await realpath(directory));
  } catch { return unavailable(REASONS.workspace); }

  const ready = (name: string, absolutePath: string): McpReadMessageAttachmentOutput => ({
    attachmentId: known.attachmentId, name: input.displayName ?? known.name, kind: known.kind, mimeType: known.mimeType, sizeBytes: known.sizeBytes,
    status: known.status, available: true, relativePath: `${ATTACHMENT_DIRECTORY}/${input.jobId}/${name}`, absolutePath, reason: null,
  });
  const expectedHash = known.sha256?.toLowerCase() ?? null;
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const entries = (await readdir(directory).catch(() => [])).slice(0, MAX_SCAN_ENTRIES);
    // An earlier copy of the same file in this job directory is reused when it still has the same bytes.
    if (expectedHash !== null && known.sizeBytes !== null) {
      for (const entry of entries) {
        const candidate = join(directory, entry);
        try {
          const info = await lstat(candidate);
          if (!info.isFile() || info.size !== known.sizeBytes) continue;
          if (createHash('sha256').update(await readFile(candidate)).digest('hex') === expectedHash) return ready(entry, candidate);
        } catch { /* Skip an entry that cannot be read. */ }
      }
    }
    const outcome = await copyReadyFile({
      row: { name: known.name, kind: known.kind, size_bytes: known.sizeBytes, sha256: known.sha256 },
      source, directory, jobId: input.jobId, index: 0, used: new Set(entries.map((entry) => entry.toLowerCase())), exclusive: true,
    });
    if ('file' in outcome) return ready(outcome.file.name, outcome.file.absolutePath);
  }
  return unavailable(REASONS.copy);
}
