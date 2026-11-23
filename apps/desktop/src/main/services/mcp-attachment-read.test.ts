import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMessageAttachmentForJob, type MessageAttachmentAccess, type ReadableAttachment } from './mcp-attachment-read.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('hello attachment');
const sha = createHash('sha256').update(bytes).digest('hex');

describe('readMessageAttachmentForJob', () => {
  let root: string;
  let workspace: string;
  let stored: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-attachment-read-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    stored = join(root, 'stored.bin');
    await writeFile(stored, bytes);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const row = (status: ReadableAttachment['status']): ReadableAttachment =>
    ({ attachmentId: 'att-1', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: sha, status });
  const fake = (initial: ReadableAttachment['status'], recovery: 'recovered' | 'not_found' | 'not_eligible' = 'not_eligible') => {
    let status = initial;
    const calls = { recover: 0, resolve: 0 };
    const access: MessageAttachmentAccess = {
      getAttachment: async () => row(status),
      recoverFromLocalDownloads: async () => { calls.recover += 1; if (recovery === 'recovered') status = 'ready'; return recovery; },
      resolveReadyPath: async () => { calls.resolve += 1; return status === 'ready' ? stored : null; },
    };
    return { access, calls };
  };
  const input = () => ({ attachmentId: 'att-1', displayName: 'report.pdf', jobId: JOB_ID, fileAccess: { workspacePath: workspace, fileRead: true } });

  it('copies a ready file into the job directory and verifies it', async () => {
    const { access, calls } = fake('ready');
    const out = await readMessageAttachmentForJob(access, input());
    expect(calls.recover).toBe(0);
    expect(out).toMatchObject({ available: true, status: 'ready', name: 'report.pdf', reason: null, relativePath: `.agent-attachments/${JOB_ID}/report.pdf` });
    expect(await readFile(out.absolutePath!)).toEqual(bytes);
  });

  it('makes no copy when the job has no workspace or cannot read files', async () => {
    const { access } = fake('ready');
    const none = await readMessageAttachmentForJob(access, { ...input(), fileAccess: null });
    expect(none).toMatchObject({ available: false, reason: 'The job workspace is not available.' });
    const denied = await readMessageAttachmentForJob(access, { ...input(), fileAccess: { workspacePath: workspace, fileRead: false } });
    expect(denied).toMatchObject({ available: false, reason: 'This job cannot read files.', absolutePath: null });
    await expect(readdir(join(workspace, '.agent-attachments'))).rejects.toThrow();
  });

  it('recovers an expired attachment from the local Downloads folder first', async () => {
    const { access, calls } = fake('expired', 'recovered');
    const out = await readMessageAttachmentForJob(access, input());
    expect(calls.recover).toBe(1);
    expect(out).toMatchObject({ available: true, status: 'ready' });
  });

  it('reports available=false when no same file is found', async () => {
    const { access } = fake('expired', 'not_found');
    const out = await readMessageAttachmentForJob(access, input());
    expect(out).toMatchObject({ available: false, status: 'expired', relativePath: null, absolutePath: null });
    expect(out.reason).toContain('no same file was found in the Downloads folder');
    await expect(readdir(join(workspace, '.agent-attachments'))).rejects.toThrow();
  });

  it('reuses an earlier copy and never overwrites another file', async () => {
    const { access } = fake('ready');
    const first = await readMessageAttachmentForJob(access, input());
    const second = await readMessageAttachmentForJob(access, input());
    expect(second.absolutePath).toBe(first.absolutePath);
    // A different file with the same name stays untouched; the new copy gets another name.
    await rm(first.absolutePath!);
    await writeFile(first.absolutePath!, 'other content');
    const third = await readMessageAttachmentForJob(access, input());
    expect(third.absolutePath).not.toBe(first.absolutePath);
    expect(await readFile(first.absolutePath!, 'utf8')).toBe('other content');
    expect(await readFile(third.absolutePath!)).toEqual(bytes);
  });
});
