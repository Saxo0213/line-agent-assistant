import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ROOM_KEY, type AgentEvent, type AgentRunRequest, type AgentStoredAttachment } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { AgentService } from './agent-service.js';
import { ATTACHMENT_DIRECTORY, DEFAULT_ATTACHMENT_PROMPT } from './agent-attachments.js';
import { fullToolsEnvironment } from './agent-service-test-support.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7 hello');
let workspace: string;

beforeEach(async () => { workspace = await realpath(await mkdtemp(join(tmpdir(), 'linejs-room-attach-'))); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

interface Enqueued { jobId?: string; requestId: string; prompt: string; workspacePath: string; attachments?: AgentStoredAttachment[] }

function submitFixture(options: { failInsert?: boolean; existingJobId?: string } = {}) {
  const enqueued: Enqueued[] = [];
  const repository = {
    async enqueueUiJob(request: Enqueued) {
      if (options.failInsert) throw new Error('insert failed');
      enqueued.push(request);
      return options.existingJobId ? { disposition: 'duplicate' as const, jobId: options.existingJobId } : { disposition: 'inserted' as const, jobId: request.jobId! };
    },
    async claimNext() { return null; },
  };
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => workspace },
    { async *run() {}, async cancel() {} }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, undefined, fullToolsEnvironment);
  return { service, enqueued };
}

const jobDirectories = async () => {
  try { return await readdir(join(workspace, ATTACHMENT_DIRECTORY)); } catch { return []; }
};

describe('submitFromUi with attachments (atomic)', () => {
  it('writes the files, then inserts one row carrying the metadata and the typed prompt', async () => {
    const { service, enqueued } = submitFixture();
    const result = await service.submitFromUi({ provider: 'claude', requestId: 'r1', prompt: '看一下', attachments: [{ name: 'a.png', bytes: PNG }, { name: 'b.pdf', bytes: PDF }] });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ jobId: result.jobId, prompt: '看一下', workspacePath: workspace });
    expect(enqueued[0]!.attachments!.map((item) => [item.name, item.kind])).toEqual([['a.png', 'image'], ['b.pdf', 'file']]);
    expect(await readdir(join(workspace, ATTACHMENT_DIRECTORY, result.jobId))).toEqual(['a.png', 'b.pdf']);
    await service.idle();
  });

  it('stores the default prompt when the text is empty and files are attached (row 3)', async () => {
    const { service, enqueued } = submitFixture();
    await service.submitFromUi({ provider: 'claude', requestId: 'r2', prompt: '   ', attachments: [{ name: 'a.png', bytes: PNG }] });
    expect(enqueued[0]!.prompt).toBe(DEFAULT_ATTACHMENT_PROMPT);
    await service.idle();
  });

  it('leaves no row and no files when the insert fails (row 7)', async () => {
    const { service, enqueued } = submitFixture({ failInsert: true });
    await expect(service.submitFromUi({ provider: 'claude', requestId: 'r3', prompt: 'x', attachments: [{ name: 'a.png', bytes: PNG }] })).rejects.toThrow('insert failed');
    expect(enqueued).toHaveLength(0);
    expect(await jobDirectories()).toEqual([]);
  });

  it('leaves no row and no files when writing fails, and rejects over-limit input before touching the disk (rows 5, 7)', async () => {
    const { service, enqueued } = submitFixture();
    await expect(service.submitFromUi({ provider: 'claude', requestId: 'r4', prompt: 'x',
      attachments: [{ name: 'big.bin', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] })).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT' });
    await expect(service.submitFromUi({ provider: 'claude', requestId: 'r5', prompt: 'x',
      attachments: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, bytes: PNG })) })).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT' });
    expect(enqueued).toHaveLength(0);
    expect(await jobDirectories()).toEqual([]);
  });

  it('removes its files when a repeated request id resolves to an earlier job', async () => {
    const earlier = randomUUID();
    const { service } = submitFixture({ existingJobId: earlier });
    const result = await service.submitFromUi({ provider: 'claude', requestId: 'dup', prompt: 'x', attachments: [{ name: 'a.png', bytes: PNG }] });
    expect(result).toEqual({ disposition: 'duplicate', jobId: earlier });
    expect(await jobDirectories()).toEqual([]);
  });

  it('keeps the attachment-less path unchanged', async () => {
    const { service, enqueued } = submitFixture();
    await service.submitFromUi({ provider: 'codex', requestId: 'plain', prompt: 'hello' });
    expect(enqueued[0]).toEqual({ provider: 'codex', requestId: 'plain', prompt: 'hello', workspacePath: workspace });
    expect(await jobDirectories()).toEqual([]);
    await service.idle();
  });
});

function runFixture(provider: 'claude' | 'codex', stored: AgentStoredAttachment[], jobId: string) {
  const job = { jobId, accountId: null, chatType: null, chatId: null, provider, prompt: '使用者原文', workspacePath: workspace, generation: 0,
    status: 'running' as const, sourceType: 'ui' as const, sourceMessageId: null, sourceRequestId: 'req', creationEpoch: null, revision: '1', attachments: stored };
  let claimed = false;
  const appended: AgentEvent[] = [];
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return job; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, event: AgentEvent) { appended.push(event); },
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const requests: AgentRunRequest[] = [];
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => workspace }, {
    async *run(request) { requests.push(request); yield { type: 'started', externalSessionId: 's' }; yield { type: 'completed', finalText: 'ok' }; },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, undefined, fullToolsEnvironment);
  return { service, requests, appended, job };
}

async function storedJob(provider: 'claude' | 'codex') {
  const { service: writer, enqueued } = submitFixture();
  const submitted = await writer.submitFromUi({ provider, requestId: 'seed', prompt: '使用者原文', attachments: [{ name: 'shot.png', bytes: PNG }, { name: 'doc.pdf', bytes: PDF }] });
  await writer.idle();
  return { jobId: submitted.jobId, stored: enqueued[0]!.attachments! };
}

describe('attachment section at run time', () => {
  it('Claude: appends the workspace-relative section to the run request only, with no image flags (rows 1, 10)', async () => {
    const { jobId, stored } = await storedJob('claude');
    const f = runFixture('claude', stored, jobId);
    f.service.kick(AGENT_ROOM_KEY);
    await f.service.idle();
    expect(f.requests).toHaveLength(1);
    const prompt = f.requests[0]!.prompt;
    expect(prompt.startsWith('使用者原文')).toBe(true);
    expect(prompt).toContain(`[1] shot.png（image/png，12 B）路徑：.agent-attachments/${jobId}/shot.png 這是圖片，請用 Read 讀取後再回答。`);
    expect(prompt).toContain(`[2] doc.pdf（application/octet-stream，14 B）路徑：.agent-attachments/${jobId}/doc.pdf`);
    expect(prompt).not.toContain(workspace);
    expect(f.requests[0]!.imagePaths).toBeUndefined();
    // The persisted job text is untouched.
    expect(f.job.prompt).toBe('使用者原文');
    expect(f.job.prompt).not.toContain('附件');
  });

  it('Codex: passes only the image as an absolute --image path (row 4)', async () => {
    const { jobId, stored } = await storedJob('codex');
    const f = runFixture('codex', stored, jobId);
    f.service.kick(AGENT_ROOM_KEY);
    await f.service.idle();
    expect(f.requests[0]!.imagePaths).toEqual([join(workspace, ATTACHMENT_DIRECTORY, jobId, 'shot.png')]);
    expect(f.requests[0]!.prompt).toContain('這是圖片，已隨訊息附上。');
  });

  it('a jobs without attachments gets neither section nor image paths', async () => {
    const f = runFixture('codex', [], randomUUID());
    f.service.kick(AGENT_ROOM_KEY);
    await f.service.idle();
    expect(f.requests[0]!.prompt).toBe('使用者原文');
    expect(f.requests[0]!.imagePaths).toBeUndefined();
  });

  it('fails with ATTACHMENT_MISSING on a retry when a file is gone, and never starts the runner (row 8)', async () => {
    const { jobId, stored } = await storedJob('claude');
    await unlink(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'doc.pdf'));
    const f = runFixture('claude', stored, jobId);
    f.service.kick(AGENT_ROOM_KEY);
    await f.service.idle();
    expect(f.requests).toHaveLength(0);
    expect(f.appended).toContainEqual(expect.objectContaining({ type: 'failed', code: 'ATTACHMENT_MISSING', retryable: false }));
    // The surviving file is not touched by the failure.
    expect((await stat(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'shot.png'))).isFile()).toBe(true);
  });

  it('same files are reused on a retry run', async () => {
    const { jobId, stored } = await storedJob('claude');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const f = runFixture('claude', stored, jobId);
      f.service.kick(AGENT_ROOM_KEY);
      await f.service.idle();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.prompt).toContain(`.agent-attachments/${jobId}/shot.png`);
    }
  });
});
