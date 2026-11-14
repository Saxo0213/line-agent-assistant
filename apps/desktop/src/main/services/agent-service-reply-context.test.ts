import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentProvider, AgentRunRequest, SafeDiagnostic, WritableConversationKey } from '@line-agent/contracts';
import type { AgentRepository } from '@line-agent/database';
import { AgentService } from './agent-service.js';
import { ATTACHMENT_DIRECTORY, jobDirectory, type ResolvedAttachment } from './agent-attachments.js';
import type { ReplyContext, ReplyContextInput } from './agent-reply-context.js';
import type { AgentJobEnvironment } from './agent-job-environment.js';

const key: WritableConversationKey = { accountId: 'a', chatType: 'group', chatId: 'g' };
const tools = { localTools: false, fileRead: false, fileWrite: false, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write' as const, webTools: false, interactiveApproval: false };
const SECTION = '\n\n---\n這則訊息是在回覆以下訊息：\n[小明] 11/5 09:03：幾點出發';
let workspace: string;

beforeEach(async () => { workspace = await realpath(await mkdtemp(join(tmpdir(), 'linejs-reply-svc-'))); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

async function run(options: { sourceType?: 'line' | 'ui' | 'schedule'; provider?: AgentProvider; withFile?: boolean; fail?: boolean; failJob?: boolean }) {
  const sourceType = options.sourceType ?? 'line';
  const provider = options.provider ?? 'claude';
  const job = { jobId: randomUUID(), accountId: 'a', chatType: 'group' as const, chatId: 'g', provider, prompt: '有自由座嗎',
    workspacePath: workspace, generation: 1, status: 'running' as const, sourceType, sourceMessageId: 'm-1', sourceRequestId: sourceType === 'line' ? null : 'r',
    creationEpoch: 0, revision: '1' };
  let claimed = false;
  let storedPrompt = job.prompt;
  const repository = {
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async getJob() { return { ...job, prompt: storedPrompt }; },
    async lookupSession() { return null; },
    async appendEvent(_id: string, _event: AgentEvent) {},
    async bindSession() {},
    async completeJob() { return { ...job, status: 'completed' as const, revision: '2' }; },
    async failJob() { return { ...job, status: 'failed' as const, revision: '2' }; },
    async cancelJob() { return { ...job, status: 'cancelled' as const, revision: '2' }; },
  };
  const environment: AgentJobEnvironment = { prepare: async () => ({ ok: true, workspacePath: workspace, tools }) };
  const requests: AgentRunRequest[] = [];
  const asked: ReplyContextInput[] = [];
  const diagnostics: SafeDiagnostic[] = [];
  let directoryDuringRun: string[] = [];
  const resolveReplyContext = async (input: ReplyContextInput): Promise<ReplyContext | null> => {
    asked.push(input);
    if (options.fail) throw new Error('lookup failed');
    const files: ResolvedAttachment[] = [];
    if (options.withFile) {
      const directory = jobDirectory(workspace, input.jobId);
      await mkdir(directory, { recursive: true });
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
      await writeFile(join(directory, 'photo.png'), bytes);
      files.push({ name: 'photo.png', size: bytes.byteLength, kind: 'image', mime: 'image/png', sha256: 'a'.repeat(64),
        relativePath: `${ATTACHMENT_DIRECTORY}/${input.jobId}/photo.png`, absolutePath: join(directory, 'photo.png') });
    }
    return { section: SECTION, files };
  };
  const service = new AgentService(repository as unknown as AgentRepository, { current: async () => workspace }, {
    async *run(request) {
      requests.push(request);
      directoryDuringRun = await readdir(join(workspace, ATTACHMENT_DIRECTORY, job.jobId)).catch(() => []);
      yield { type: 'started', externalSessionId: 's' };
      yield options.failJob ? { type: 'failed', code: 'BRIDGE_ERROR', message: 'x', retryable: false } : { type: 'completed', finalText: 'ok' };
    },
    async cancel() {},
  }, undefined, undefined, 1, 30_000, 5_000, 1, undefined, undefined, undefined, undefined, environment,
  (diagnostic) => { diagnostics.push(diagnostic); }, undefined, undefined, resolveReplyContext);
  service.kick(key);
  await service.idle();
  storedPrompt = job.prompt;
  return { request: requests[0]!, asked, diagnostics, job, directoryDuringRun,
    leftover: await readdir(join(workspace, ATTACHMENT_DIRECTORY)).catch(() => []) };
}

describe('Agent reply context in LINE jobs', () => {
  it('adds the section to the run request only and asks with the job and source message', async () => {
    const { request, asked, job } = await run({});
    expect(request.prompt).toContain('有自由座嗎');
    expect(request.prompt.endsWith(SECTION)).toBe(true);
    expect(job.prompt).toBe('有自由座嗎');
    expect(asked).toEqual([{ jobId: job.jobId, accountId: 'a', chatType: 'group', chatId: 'g', messageId: 'm-1', workspacePath: workspace, provider: 'claude' }]);
  });

  it('puts quoted files into the attachment section and Codex image paths, after the reply section, and removes the directory at the end', async () => {
    const { request, directoryDuringRun, leftover, job } = await run({ withFile: true, provider: 'codex' });
    expect(request.prompt.indexOf(SECTION)).toBeGreaterThan(-1);
    expect(request.prompt.indexOf('附件（位於工作目錄內')).toBeGreaterThan(request.prompt.indexOf(SECTION));
    expect(request.prompt).toContain(`路徑：${ATTACHMENT_DIRECTORY}/${job.jobId}/photo.png`);
    expect(request.imagePaths).toEqual([join(workspace, ATTACHMENT_DIRECTORY, job.jobId, 'photo.png')]);
    expect(directoryDuringRun).toEqual(['photo.png']);
    expect(leftover).toEqual([]);
  });

  it('removes the directory when the job fails', async () => {
    expect((await run({ withFile: true, failJob: true })).leftover).toEqual([]);
  });

  it('runs without the section and reports a prepare failure when the resolver fails', async () => {
    const { request, diagnostics } = await run({ fail: true });
    expect(request.prompt).toBe('有自由座嗎');
    expect(diagnostics.some((item) => item.stage === 'prepare')).toBe(true);
  });

  it('never asks for the Agent room or schedules', async () => {
    expect((await run({ sourceType: 'ui' })).asked).toEqual([]);
    expect((await run({ sourceType: 'schedule' })).asked).toEqual([]);
  });
});
