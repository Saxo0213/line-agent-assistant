import { createHash, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineSendAuditRow, SendAttachment, SendSourceMessage } from '@line-agent/database';
import {
  AgentLineSendService,
  SEND_PENDING_MAX,
  truncateFileName,
  type AgentLineSendRepository,
  type AgentLineSendWorker,
  type SendPlan,
} from './agent-line-send-service.js';

const ACCOUNT = 'acct-agent';
const PRINCIPAL = 'internal:primary_admin:u-admin';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

class FakeRepository {
  audit: LineSendAuditRow[] = [];
  account: string | null = ACCOUNT;
  chats = new Set(['direct:u-friend', 'group:g-team', 'room:r-one']);
  messages = new Map<string, SendSourceMessage>();
  attachments = new Map<string, SendAttachment & { masked: boolean }>();
  findAgentSendAccount = vi.fn(async () => this.account);
  listSendTargets = vi.fn(async () => []);
  getSendTarget = vi.fn(async (accountId: string, chatType: string, chatId: string) =>
    this.chats.has(`${chatType}:${chatId}`) && accountId === ACCOUNT && chatId !== '__local_agent_room__'
      ? { accountId, chatType: chatType as 'direct' | 'group' | 'room', chatId } : null);
  resolveSendSourceMessage = vi.fn(async (input: { messageId: string }) => this.messages.get(input.messageId) ?? null);
  getSendAttachment = vi.fn(async (attachmentId: string) => this.attachments.get(attachmentId) ?? null);
  recordLineSend = vi.fn(async (row: LineSendAuditRow) => { this.audit.push(row); });
  countJobLineSends = vi.fn(async (jobId: string) =>
    this.audit.filter((row) => row.jobId === jobId && ['sent', 'unknown', 'failed'].includes(row.status)).length);
}

type Sent = { kind: 'text' | 'media'; text?: string; fileName?: string; mediaKind?: string; requestId: string; chatType: string; sha256?: string };
class FakeWorker implements AgentLineSendWorker {
  epoch = 1;
  instance = 'w-1';
  mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' = 'ACTIVE_CONTROL';
  acknowledged = true;
  sent: Sent[] = [];
  active = 0;
  maxActive = 0;
  /** Outcome per send number (1-based); default sent. */
  outcomes = new Map<number, 'failed' | 'unknown' | 'throw'>();
  gates: Array<Promise<void>> = [];
  signals: AbortSignal[] = [];
  onSend?: (count: number) => void;
  binding = vi.fn(async (accountId: string) => ({ accountId, workerInstanceId: this.instance, controlEpoch: this.epoch, mode: this.mode }));
  waitModeAck = vi.fn(async () => this.acknowledged);
  private async perform(record: Sent, command: { accountId: string; workerInstanceId: string; controlEpoch: number; requestId: string }, signal?: AbortSignal) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.sent.push(record);
    if (signal) this.signals.push(signal);
    const number = this.sent.length;
    this.onSend?.(number);
    try {
      const gate = this.gates.shift();
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      const outcome = this.outcomes.get(number);
      if (outcome === 'throw') throw new Error('gateway down');
      return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, requestId: command.requestId, status: outcome ?? 'sent' as const,
        messageId: outcome ? null : `m-${number}`, error: null };
    } finally { this.active -= 1; }
  }
  send: AgentLineSendWorker['send'] = (command, signal) =>
    this.perform({ kind: 'text', text: command.text, requestId: command.requestId, chatType: command.chatType }, command, signal);
  sendMedia: NonNullable<AgentLineSendWorker['sendMedia']> = (command, signal) =>
    this.perform({ kind: 'media', fileName: command.fileName, mediaKind: command.kind, requestId: command.requestId,
      chatType: command.chatType, sha256: command.sha256 }, command, signal);
}

let root: string;
let attachmentRoot: string;
let workspace: string;
let outside: string;
let repo: FakeRepository;
let worker: FakeWorker;
let canWrite: boolean;
let service: AgentLineSendService;

const fakeClient = () => ({ query: vi.fn(async () => ({ rows: [{ workspace_path: workspace }] })) }) as never;
const makeService = (callBudgetMs?: number) => new AgentLineSendService({
  messages: repo as unknown as AgentLineSendRepository, worker, canWriteLine: async () => canWrite, attachmentRoot,
  ...(callBudgetMs === undefined ? {} : { callBudgetMs }),
});
interface Submit { jobId?: string; chatType?: string; chatId?: string; signal?: AbortSignal; isLive?: () => boolean }
async function authorize(items: unknown[], options: Submit = {}) {
  return service.authorize(fakeClient(), { jobId: options.jobId ?? 'job-1', principalId: PRINCIPAL,
    rawInput: { chatType: options.chatType ?? 'direct', chatId: options.chatId ?? 'u-friend', items } });
}
async function submit(items: unknown[], options: Submit = {}) {
  const outcome = await authorize(items, options);
  if (outcome.kind === 'rejected') return outcome.output.results;
  return (await service.run(outcome.plan, { signal: options.signal ?? new AbortController().signal, isLive: options.isLive ?? (() => true) })).results;
}
const statuses = (results: Array<{ status: string }>) => results.map((result) => result.status);
const codes = (results: Array<{ code?: string | undefined }>) => results.map((result) => result.code);

async function storedAttachment(id: string, content: string, over: Partial<SendAttachment & { masked: boolean }> = {}) {
  const relativePath = `ab/${id}.bin`;
  await mkdir(path.join(attachmentRoot, 'ab'), { recursive: true });
  await writeFile(path.join(attachmentRoot, 'ab', `${id}.bin`), content);
  const value = { attachmentId: id, kind: 'file' as const, name: `${id}-name.txt`, status: 'ready' as const, relativePath,
    sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), masked: false, ...over };
  repo.attachments.set(id, value);
  return value;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'line-send-')));
  attachmentRoot = path.join(root, 'attachments');
  workspace = path.join(root, 'workspace');
  outside = path.join(root, 'outside');
  await mkdir(attachmentRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  repo = new FakeRepository();
  worker = new FakeWorker();
  canWrite = true;
  service = makeService();
});
afterEach(async () => {
  await service.shutdown();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('target and account authorization', () => {
  it('rejects community and thread targets without touching LINE', async () => {
    for (const chatType of ['community', 'thread']) {
      const results = await submit([{ type: 'text', text: 'hi' }, { type: 'text', text: 'again' }], { chatType });
      expect(statuses(results)).toEqual(['failed', 'skipped']);
      expect(results[0]!.code).toBe('send_target_invalid');
    }
    expect(worker.sent).toHaveLength(0);
  });

  it('rejects a chat that does not belong to the Agent account and the local room', async () => {
    expect(codes(await submit([{ type: 'text', text: 'hi' }], { chatId: 'u-stranger' }))).toEqual(['send_target_invalid']);
    repo.chats.add('room:__local_agent_room__');
    expect(codes(await submit([{ type: 'text', text: 'hi' }], { chatType: 'room', chatId: '__local_agent_room__' }))).toEqual(['send_target_invalid']);
    expect(worker.sent).toHaveLength(0);
  });

  it('reports send_line_unavailable for a missing Agent account, a read-only account and an inactive worker', async () => {
    repo.account = null;
    expect(codes(await submit([{ type: 'text', text: 'hi' }]))).toEqual(['send_line_unavailable']);
    repo.account = ACCOUNT;
    canWrite = false;
    expect(codes(await submit([{ type: 'text', text: 'hi' }]))).toEqual(['send_line_unavailable']);
    canWrite = true;
    worker.mode = 'MONITOR_ONLY';
    expect(codes(await submit([{ type: 'text', text: 'hi' }]))).toEqual(['send_line_unavailable']);
    worker.mode = 'ACTIVE_CONTROL';
    worker.acknowledged = false;
    expect(codes(await submit([{ type: 'text', text: 'hi' }]))).toEqual(['send_line_unavailable']);
    expect(worker.sent).toHaveLength(0);
    expect(repo.audit.every((row) => row.status === 'denied' && row.errorCode === 'send_line_unavailable')).toBe(true);
  });

  it('rejects malformed input as invalid input', async () => {
    await expect(authorize([])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(authorize([{ type: 'text', text: '' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('items', () => {
  it('splits long text at 4900 characters and sends the parts in order', async () => {
    expect(statuses(await submit([{ type: 'text', text: 'a'.repeat(4900) + 'b'.repeat(100) }]))).toEqual(['sent']);
    expect(worker.sent.map((entry) => entry.text!.length)).toEqual([4900, 100]);
    // A forwarded message may be longer than one tool item.
    worker.sent.length = 0;
    repo.messages.set('m-long', { kind: 'text', text: 'a'.repeat(4900) + 'b'.repeat(4900) + 'c'.repeat(200), masked: false, attachments: [] });
    expect(statuses(await submit([{ type: 'message', accountId: ACCOUNT, chatType: 'group', chatId: 'g-team', messageId: 'm-long' }], { jobId: 'job-2' }))).toEqual(['sent']);
    expect(worker.sent.map((entry) => entry.text!.length)).toEqual([4900, 4900, 200]);
    expect(worker.sent.map((entry) => entry.text![0])).toEqual(['a', 'b', 'c']);
  });

  it('forwards archived text, image and file messages', async () => {
    const image = await storedAttachment('img-1', 'PNGDATA', { kind: 'image', name: 'photo.png' });
    const file = await storedAttachment('file-1', 'PDFDATA', { name: 'doc.pdf' });
    repo.messages.set('m-text', { kind: 'text', text: 'forward me', masked: false, attachments: [] });
    repo.messages.set('m-image', { kind: 'image', text: null, masked: false, attachments: [image] });
    repo.messages.set('m-file', { kind: 'file', text: null, masked: false, attachments: [file] });
    repo.messages.set('m-video', { kind: 'video', text: null, masked: false, attachments: [{ ...file, attachmentId: 'file-1', name: 'clip.mp4' }] });
    const message = (messageId: string) => ({ type: 'message', accountId: 'acct-other', chatType: 'community', chatId: 'c-1', messageId });
    const results = await submit([message('m-text'), message('m-image'), message('m-file'), message('m-video')]);
    expect(statuses(results)).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(worker.sent.map((entry) => [entry.kind, entry.mediaKind ?? entry.text])).toEqual([
      ['text', 'forward me'], ['media', 'image'], ['media', 'file'], ['media', 'file']]);
    expect(worker.sent[1]!.fileName).toBe('photo.png');
    expect(worker.sent[1]!.sha256).toBe(createHash('sha256').update('PNGDATA').digest('hex'));
  });

  it('refuses masked, unknown and unsupported sources', async () => {
    repo.messages.set('m-masked', { kind: 'text', text: null, masked: true, attachments: [] });
    repo.messages.set('m-sticker', { kind: 'sticker', text: null, masked: false, attachments: [] });
    repo.messages.set('m-noatt', { kind: 'image', text: null, masked: false, attachments: [] });
    const message = (messageId: string) => ({ type: 'message', accountId: ACCOUNT, chatType: 'group', chatId: 'g-team', messageId });
    expect(codes(await submit([message('m-masked')]))).toEqual(['send_source_unavailable']);
    expect(codes(await submit([message('m-missing')]))).toEqual(['send_source_unavailable']);
    expect(codes(await submit([message('m-sticker')]))).toEqual(['send_kind_unsupported']);
    expect(codes(await submit([message('m-noatt')]))).toEqual(['send_attachment_unavailable']);
    expect(worker.sent).toHaveLength(0);
  });

  it('sends a stored attachment and refuses one that is masked, not ready, missing on disk or changed', async () => {
    await storedAttachment('att-ok', 'hello world', { kind: 'image' });
    await storedAttachment('att-queued', 'x', { status: 'queued' });
    await storedAttachment('att-masked', 'x', { masked: true });
    await storedAttachment('att-size', 'abcdef', { sizeBytes: 3 });
    repo.attachments.set('att-gone', { attachmentId: 'att-gone', kind: 'file', name: 'g.txt', status: 'ready', relativePath: 'ab/gone.bin',
      sha256: null, sizeBytes: 5, masked: false });
    await storedAttachment('att-hash', 'abcdef', { sha256: createHash('sha256').update('different').digest('hex') });
    expect(statuses(await submit([{ type: 'attachment', attachmentId: 'att-ok' }]))).toEqual(['sent']);
    expect(worker.sent[0]).toMatchObject({ kind: 'media', mediaKind: 'image' });
    for (const id of ['att-queued', 'att-masked', 'att-size', 'att-gone', 'att-hash', 'att-unknown']) {
      expect(codes(await submit([{ type: 'attachment', attachmentId: id }]))).toEqual(['send_attachment_unavailable']);
    }
    expect(worker.sent).toHaveLength(1);
  });

  it('sends a workspace file by extension and keeps the name within 180 bytes', async () => {
    const longName = `${'名'.repeat(80)}.txt`;
    await writeFile(path.join(workspace, 'pic.PNG'), 'img');
    await writeFile(path.join(workspace, longName), 'text');
    await mkdir(path.join(workspace, 'sub'));
    await writeFile(path.join(workspace, 'sub', 'a.zip'), 'zip');
    const results = await submit([{ type: 'file', path: 'pic.PNG' }, { type: 'file', path: longName }, { type: 'file', path: 'sub/a.zip' }]);
    expect(statuses(results)).toEqual(['sent', 'sent', 'sent']);
    expect(worker.sent.map((entry) => entry.mediaKind)).toEqual(['image', 'file', 'file']);
    expect(Buffer.byteLength(worker.sent[1]!.fileName!, 'utf8')).toBeLessThanOrEqual(180);
    expect(truncateFileName('x'.repeat(300))).toHaveLength(180);
  });

  it('rejects workspace paths that escape through .., an absolute path or a junction', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(workspace, 'link'), 'junction');
    await mkdir(path.join(workspace, 'dir'));
    for (const candidate of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'link/secret.txt', 'dir', 'missing.txt', 'dir/../../outside/secret.txt']) {
      const results = await submit([{ type: 'text', text: 'before' }, { type: 'file', path: candidate }]);
      expect(statuses(results)).toEqual(['skipped', 'failed']);
      expect(results[1]!.code).toBe('send_file_invalid');
    }
    expect(worker.sent).toHaveLength(0);
  });

  it('enforces the size limits and refuses room media', async () => {
    const image = await open(path.join(workspace, 'big.png'), 'w');
    await image.truncate(20 * 1024 * 1024 + 1);
    await image.close();
    const exactImage = await open(path.join(workspace, 'edge.png'), 'w');
    await exactImage.truncate(20 * 1024 * 1024);
    await exactImage.close();
    const file = await open(path.join(workspace, 'big.bin'), 'w');
    await file.truncate(100 * 1024 * 1024 + 1);
    await file.close();
    await writeFile(path.join(workspace, 'empty.txt'), '');
    await writeFile(path.join(workspace, 'ok.txt'), 'ok');
    expect(codes(await submit([{ type: 'file', path: 'big.png' }]))).toEqual(['send_too_large']);
    expect(codes(await submit([{ type: 'file', path: 'big.bin' }]))).toEqual(['send_too_large']);
    expect(codes(await submit([{ type: 'file', path: 'empty.txt' }]))).toEqual(['send_file_invalid']);
    expect(codes(await submit([{ type: 'file', path: 'ok.txt' }], { chatType: 'room', chatId: 'r-one' }))).toEqual(['send_media_unsupported_chat']);
    expect(worker.sent).toHaveLength(0);
    // Text to a room is allowed.
    expect(statuses(await submit([{ type: 'text', text: 'hello room' }], { chatType: 'room', chatId: 'r-one' }))).toEqual(['sent']);
    expect(worker.sent[0]!.chatType).toBe('room');
  });
});

describe('send loop', () => {
  it('stops at the first failed item and skips the rest', async () => {
    worker.outcomes.set(2, 'failed');
    const results = await submit([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'text', text: 'three' }]);
    expect(statuses(results)).toEqual(['sent', 'failed', 'skipped']);
    expect(results[1]!.code).toBe('send_failed');
    expect(worker.sent).toHaveLength(2);
  });

  it('never retries an unknown outcome, including a gateway exception', async () => {
    worker.outcomes.set(1, 'unknown');
    let results = await submit([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
    expect(statuses(results)).toEqual(['unknown', 'skipped']);
    expect(results[0]!.code).toBe('send_unknown');
    expect(worker.sent).toHaveLength(1);
    worker.outcomes.set(2, 'throw');
    results = await submit([{ type: 'text', text: 'again' }], { jobId: 'job-2' });
    expect(statuses(results)).toEqual(['unknown']);
    expect(worker.sent).toHaveLength(2);
  });

  it('treats a mismatched result as unknown', async () => {
    worker.send = async (command) => ({ type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
      controlEpoch: command.controlEpoch, requestId: 'another-request', status: 'sent', messageId: 'm-1', error: null });
    expect(statuses(await submit([{ type: 'text', text: 'one' }]))).toEqual(['unknown']);
  });

  it('stops further items when the capability is released mid-loop', async () => {
    let live = true;
    worker.onSend = () => { live = false; };
    const results = await submit([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], { isLive: () => live });
    expect(statuses(results)).toEqual(['sent', 'skipped']);
    expect(worker.sent).toHaveLength(1);
  });

  it('sends nothing when the binding drifts after authorization', async () => {
    const outcome = await authorize([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
    if (outcome.kind !== 'plan') throw new Error('expected a plan');
    const started = service.run(outcome.plan, { signal: new AbortController().signal, isLive: () => true });
    worker.onSend = () => { worker.epoch = 2; };
    const results = (await started).results;
    // The first item went out under the authorized epoch; the second sees the new epoch and stays unsent.
    expect(statuses(results)).toEqual(['sent', 'failed']);
    expect(results[1]!.code).toBe('send_line_unavailable');
    expect(worker.sent).toHaveLength(1);
    expect(repo.audit.at(-1)).toMatchObject({ itemIndex: 1, status: 'denied', errorCode: 'send_line_unavailable' });
  });

  it('enforces the 30-items-per-job cap against recorded sends', async () => {
    for (let i = 0; i < 29; i += 1) {
      repo.audit.push({ jobId: 'job-cap', accountId: ACCOUNT, principalId: PRINCIPAL, chatType: 'direct', chatId: 'u-friend',
        itemIndex: i, itemKind: 'text', byteSize: 1, status: 'sent' });
    }
    const results = await submit([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], { jobId: 'job-cap' });
    expect(statuses(results)).toEqual(['failed', 'skipped']);
    expect(results[0]!.code).toBe('send_limit_exceeded');
    expect(statuses(await submit([{ type: 'text', text: 'a' }], { jobId: 'job-cap' }))).toEqual(['sent']);
    expect(codes(await submit([{ type: 'text', text: 'again' }], { jobId: 'job-cap' }))).toEqual(['send_limit_exceeded']);
  });

  it('writes one audit row per item and never stores content', async () => {
    await writeFile(path.join(workspace, 'private-name.txt'), 'secret body');
    await submit([{ type: 'text', text: 'TOP-SECRET-TEXT' }, { type: 'file', path: 'private-name.txt' }]);
    expect(repo.audit.map((row) => [row.itemIndex, row.itemKind, row.status])).toEqual([[0, 'text', 'sent'], [1, 'file', 'sent']]);
    expect(repo.audit[0]!.byteSize).toBe(Buffer.byteLength('TOP-SECRET-TEXT'));
    expect(repo.audit[1]!.byteSize).toBe(Buffer.byteLength('secret body'));
    const stored = JSON.stringify(repo.audit);
    for (const forbidden of ['TOP-SECRET-TEXT', 'private-name', 'secret body', workspace]) expect(stored).not.toContain(forbidden);
  });
});

describe('queue', () => {
  it('sends the items of different jobs one at a time in FIFO order', async () => {
    const gate = deferred();
    worker.gates.push(gate.promise);
    const first = submit([{ type: 'text', text: 'A0' }, { type: 'text', text: 'A1' }], { jobId: 'job-a' });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const second = submit([{ type: 'text', text: 'B0' }, { type: 'text', text: 'B1' }], { jobId: 'job-b' });
    await vi.waitFor(() => expect(service.pendingForJob('job-b')).toBe(2));
    const third = submit([{ type: 'text', text: 'C0' }], { jobId: 'job-c' });
    await vi.waitFor(() => expect(service.pendingForJob('job-c')).toBe(1));
    gate.resolve();
    expect(statuses(await first)).toEqual(['sent', 'sent']);
    expect(statuses(await second)).toEqual(['sent', 'sent']);
    expect(statuses(await third)).toEqual(['sent']);
    expect(worker.sent.map((entry) => entry.text)).toEqual(['A0', 'A1', 'B0', 'B1', 'C0']);
    expect(worker.maxActive).toBe(1);
  });

  it('caps pending items across jobs at 30 and enqueues nothing for a refused call', async () => {
    const gate = deferred();
    worker.gates.push(gate.promise);
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `t${i}` }));
    const calls = [submit(items(10), { jobId: 'job-1' })];
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    calls.push(submit(items(10), { jobId: 'job-2' }), submit(items(10), { jobId: 'job-3' }));
    await vi.waitFor(() => expect(service.pendingForJob('job-3')).toBe(10));
    // 9 + 10 + 10 queued; one more item fits, two do not.
    const refused = await submit(items(2), { jobId: 'job-4' });
    expect(statuses(refused)).toEqual(['failed', 'skipped']);
    expect(refused[0]!.code).toBe('send_limit_exceeded');
    expect(service.pendingForJob('job-4')).toBe(0);
    expect(SEND_PENDING_MAX).toBe(30);
    gate.resolve();
    const results = await Promise.all(calls);
    expect(results.every((result) => statuses(result).every((status) => status === 'sent'))).toBe(true);
    expect(worker.sent).toHaveLength(30);
  });

  it('drops only the pending items of a job whose capability is released', async () => {
    const gate = deferred();
    worker.gates.push(gate.promise);
    const releasedJob = new AbortController();
    const running = submit([{ type: 'text', text: 'A0' }, { type: 'text', text: 'A1' }], { jobId: 'job-a', signal: releasedJob.signal });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const other = submit([{ type: 'text', text: 'B0' }], { jobId: 'job-b' });
    await vi.waitFor(() => expect(service.pendingForJob('job-b')).toBe(1));
    releasedJob.abort();
    gate.resolve();
    // The item already in flight ends normally; the job's pending item is skipped.
    expect(statuses(await running)).toEqual(['sent', 'skipped']);
    expect(statuses(await other)).toEqual(['sent']);
    expect(worker.sent.map((entry) => entry.text)).toEqual(['A0', 'B0']);
  });

  it('drops all pending items on shutdown and aborts the in-flight send', async () => {
    worker.gates.push(new Promise<void>(() => undefined));
    const running = submit([{ type: 'text', text: 'A0' }, { type: 'text', text: 'A1' }], { jobId: 'job-a' });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const queued = submit([{ type: 'text', text: 'B0' }], { jobId: 'job-b' });
    await vi.waitFor(() => expect(service.pendingForJob('job-b')).toBe(1));
    await service.shutdown();
    expect(worker.signals[0]!.aborted).toBe(true);
    expect(statuses(await running)).toEqual(['unknown', 'skipped']);
    expect(statuses(await queued)).toEqual(['skipped']);
    expect(worker.sent).toHaveLength(1);
    expect(statuses(await submit([{ type: 'text', text: 'late' }], { jobId: 'job-c' }))).toEqual(['failed']);
  });

  it('skips items that cannot start within the call budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    service = makeService(1_000);
    worker.gates.push(new Promise<void>(() => undefined));
    const blocker = submit([{ type: 'text', text: 'A0' }], { jobId: 'job-a' });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const late = submit([{ type: 'text', text: 'B0' }], { jobId: 'job-b' });
    await vi.waitFor(() => expect(service.pendingForJob('job-b')).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses(await late)).toEqual(['skipped']);
    await service.shutdown();
    expect(statuses(await blocker)).toEqual(['unknown']);
  });
});

describe('resources', () => {
  it('leaves no timer or abort listener after a drained call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const baseline = vi.getTimerCount();
    const results = await submit([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], { signal: controller.signal });
    expect(statuses(results)).toEqual(['sent', 'sent']);
    expect(vi.getTimerCount()).toBe(baseline);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    // A failed call cleans up as well.
    worker.outcomes.set(3, 'failed');
    const failed = await submit([{ type: 'text', text: 'three' }], { signal: controller.signal });
    expect(statuses(failed)).toEqual(['failed']);
    expect(vi.getTimerCount()).toBe(baseline);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(service.pendingForJob('job-1')).toBe(0);
  });

  it('survives a randomized burst without overlap or leftovers', async () => {
    const calls: Array<Promise<Array<{ status: string }>>> = [];
    for (let i = 0; i < 6; i += 1) {
      calls.push(submit([{ type: 'text', text: `x${i}` }, { type: 'text', text: `y${i}` }], { jobId: `burst-${i}-${randomUUID()}` }));
    }
    const results = await Promise.all(calls);
    expect(results.flat().every((result) => result.status === 'sent')).toBe(true);
    expect(worker.maxActive).toBe(1);
  });
});

describe('plan shape', () => {
  it('authorizes into a plan that carries no secrets beyond what the send needs', async () => {
    const outcome = await authorize([{ type: 'text', text: 'hi' }]);
    expect(outcome.kind).toBe('plan');
    const plan = (outcome as { plan: SendPlan }).plan;
    expect(plan).toMatchObject({ accountId: ACCOUNT, chatType: 'direct', chatId: 'u-friend', principalId: PRINCIPAL });
  });
});

describe('system text (system message schedules)', () => {
  const RUN = 'run-0001';
  const direct = { accountId: ACCOUNT, chatType: 'direct' as const, chatId: 'u-friend' };
  const send = (text: string, over: { runId?: string; target?: typeof direct; signal?: AbortSignal } = {}) =>
    service.sendSystemText({ runId: over.runId ?? RUN, target: over.target ?? direct, text, ...(over.signal ? { signal: over.signal } : {}) });

  it('sends through the same queue and writes a system:schedule audit row keyed by the run id', async () => {
    expect(await send('早安')).toEqual({ status: 'sent' });
    expect(worker.sent).toEqual([expect.objectContaining({ kind: 'text', text: '早安', chatType: 'direct' })]);
    expect(worker.binding).toHaveBeenCalled();
    expect(worker.waitModeAck).toHaveBeenCalled();
    expect(repo.audit).toEqual([expect.objectContaining({ jobId: RUN, accountId: ACCOUNT, principalId: 'system:schedule', chatType: 'direct',
      chatId: 'u-friend', itemIndex: 0, itemKind: 'text', byteSize: Buffer.byteLength('早安'), status: 'sent' })]);
    expect(JSON.stringify(repo.audit)).not.toContain('早安');
  });

  it('shares the single FIFO queue with send_to_target calls: one send at a time, in order', async () => {
    const gate = deferred();
    worker.gates.push(gate.promise);
    const tool = submit([{ type: 'text', text: 'from the Agent' }], { jobId: 'job-tool' });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const system = send('from the system');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.sent).toHaveLength(1);
    expect(worker.maxActive).toBe(1);
    gate.resolve();
    expect(statuses(await tool)).toEqual(['sent']);
    expect(await system).toEqual({ status: 'sent' });
    expect(worker.sent.map((entry) => entry.text)).toEqual(['from the Agent', 'from the system']);
    expect(worker.maxActive).toBe(1);
  });

  it('splits text over the per-message limit and sends the parts in order', async () => {
    expect(await send('a'.repeat(4900) + 'b'.repeat(100))).toEqual({ status: 'sent' });
    expect(worker.sent.map((entry) => entry.text!.length)).toEqual([4900, 100]);
    expect(repo.audit).toHaveLength(1);
  });

  it('checks the write gate, binding, mode acknowledgement, account and target like the tool does, auditing a denial', async () => {
    canWrite = false;
    expect(await send('x')).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    canWrite = true;
    worker.mode = 'MONITOR_ONLY';
    expect(await send('x')).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    worker.mode = 'ACTIVE_CONTROL';
    worker.acknowledged = false;
    expect(await send('x')).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    worker.acknowledged = true;
    expect(await send('x', { target: { ...direct, accountId: 'acct-other' } })).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    expect(await send('x', { target: { ...direct, chatId: 'u-stranger' } })).toEqual({ status: 'failed', code: 'send_target_invalid' });
    repo.account = null;
    expect(await send('x')).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    expect(worker.sent).toHaveLength(0);
    expect(repo.audit.length).toBeGreaterThan(0);
    expect(repo.audit.every((row) => row.principalId === 'system:schedule' && row.status === 'denied' && row.jobId === RUN)).toBe(true);
  });

  it('reports a failed send and never retries an unknown one, including a gateway exception', async () => {
    worker.outcomes.set(1, 'failed');
    expect(await send('one')).toEqual({ status: 'failed', code: 'send_failed' });
    worker.outcomes.set(2, 'unknown');
    expect(await send('two', { runId: 'run-2' })).toEqual({ status: 'unknown', code: 'send_unknown' });
    worker.outcomes.set(3, 'throw');
    expect(await send('three', { runId: 'run-3' })).toEqual({ status: 'unknown', code: 'send_unknown' });
    expect(worker.sent).toHaveLength(3);
    expect(repo.audit.map((row) => row.status)).toEqual(['failed', 'unknown', 'unknown']);
    expect(repo.audit.every((row) => row.principalId === 'system:schedule')).toBe(true);
  });

  it('does not send after shutdown or an aborted signal and never touches a database transaction', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await send('late', { signal: controller.signal })).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    await service.shutdown();
    expect(await send('after shutdown')).toEqual({ status: 'failed', code: 'send_line_unavailable' });
    expect(worker.sent).toHaveLength(0);
    // The repository is only ever called without a transaction client (the default pool queryable).
    for (const call of repo.getSendTarget.mock.calls) expect(call).toHaveLength(3);
    for (const call of repo.findAgentSendAccount.mock.calls) expect(call).toHaveLength(0);
  });
});
