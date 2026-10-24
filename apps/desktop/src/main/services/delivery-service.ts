import { randomUUID } from 'node:crypto';
import type { LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import type { AgentJob, ClaimedLineDelivery, DeliverySegment } from '@line-agent/database';

const DEFAULT_LIMIT = 4900;
const RECOVERY_PAGE_SIZE = 32;
const MAX_RECOVERY_SCOPES = 4;
const MAX_QUEUED_RECOVERY_SCOPES = 64;
const MAX_SEND_SCOPES = 4;
const SHUTDOWN_DRAIN_MS = 5000;

export function splitDeliveryText(text: string, limit = DEFAULT_LIMIT): string[] {
  if (limit < 24) throw new Error('Delivery limit is too small');
  if (!text) return [];
  const parts: string[] = [];
  const splitPlain = (value: string) => {
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + limit);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
      parts.push(value.slice(start, end));
      start = end;
    }
  };
  const fences = /(^|\n)```([^\n]*)\n([\s\S]*?)\n```(?=\n|$)/g;
  let position = 0;
  for (const match of text.matchAll(fences)) {
    const start = match.index!;
    if (start > position) splitPlain(text.slice(position, start));
    const leading = match[1]!;
    const open = `\`\`\`${match[2]}\n`;
    const close = '\n```';
    const body = match[3]!;
    if (match[0].length <= limit) parts.push(match[0]);
    else {
      for (let offset = 0; offset < body.length;) {
        const prefix = (offset === 0 ? leading : '') + open;
        const capacity = limit - prefix.length - close.length;
        if (capacity < 1) throw new Error('Delivery limit cannot fit the code fence');
        const end = Math.min(body.length, offset + capacity);
        parts.push(prefix + body.slice(offset, end) + close);
        offset = end;
      }
    }
    position = start + match[0].length;
  }
  if (position < text.length) splitPlain(text.slice(position));
  return parts;
}

interface DeliveryRepository {
  getJob(jobId: string): Promise<AgentJob | null>;
  listDeliveries(jobId: string): Promise<DeliverySegment[]>;
  claimLineDelivery(jobId: string, partIndex: number, expectedEpoch: number): Promise<ClaimedLineDelivery | null>;
  markDeliverySent(jobId: string, partIndex: number, lineMessageId: string): Promise<boolean>;
  markDeliveryUnknown(jobId: string, partIndex: number): Promise<boolean>;
  listPendingLineDeliveryJobs?(accountId: string | undefined, afterJobId: string | undefined, limit: number): Promise<string[]>;
}

type SendCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;
interface DeliveryWorker {
  binding(accountId: string): Promise<(WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) | null>;
  waitModeAck?(accountId: string, mode: 'ACTIVE_CONTROL', timeoutMs: number): Promise<boolean>;
  send(command: SendCommand, signal?: AbortSignal): Promise<SendResult>;
}

export class DeliveryService {
  private readonly controller = new AbortController();
  private readonly recoveries = new Map<string, { promise: Promise<void>; resolve(): void; reject(error: unknown): void; rerun: boolean }>();
  private readonly queuedRecoveries = new Map<string, { promise: Promise<void>; resolve(): void; reject(error: unknown): void; rerun: boolean }>();
  private readonly recoveryQueue: string[] = [];
  private readonly activeSendAccounts = new Set<string>();
  private readonly deferredAccounts = new Set<string>();
  private readonly activeJobs = new Map<string, Promise<void>>();
  private globalRecoveryNeeded = false;
  private deferredRecoveryInFlight = false;
  private stopping = false;
  constructor(private readonly repository: DeliveryRepository, private readonly worker: DeliveryWorker,
    private readonly canWriteLine: (accountId: string) => Promise<boolean> = async () => true,
    private readonly onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void) {}

  private reportFailure(stage: SafeDiagnostic['stage'], error?: unknown, outcome: 'failed' | 'unknown' = 'failed', identity?: import('@line-agent/contracts').DiagnosticIdentity): void {
    try { this.onDiagnostic?.(diagnosticFailure('delivery', stage, error, outcome), identity); } catch { /* Preserve durable delivery behavior. */ }
  }

  recoverPending(accountId?: string): Promise<void> {
    if (this.stopping || !this.repository.listPendingLineDeliveryJobs) return Promise.resolve();
    let scope = accountId ?? '*';
    const running = this.recoveries.get(scope);
    if (running) { running.rerun = true; return running.promise; }
    const queued = this.queuedRecoveries.get(scope);
    if (queued) return queued.promise;
    // Keep one reserved wildcard slot for overflow so omitted account scopes
    // are eventually rediscovered from durable pending rows.
    if (scope !== '*' && this.recoveryQueue.length >= MAX_QUEUED_RECOVERY_SCOPES) scope = '*';
    const wildcardRunning = this.recoveries.get(scope);
    if (wildcardRunning) { wildcardRunning.rerun = true; return wildcardRunning.promise; }
    const wildcardQueued = this.queuedRecoveries.get(scope);
    if (wildcardQueued) return wildcardQueued.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.queuedRecoveries.set(scope, { promise, resolve, reject, rerun: false });
    this.recoveryQueue.push(scope);
    this.pumpRecoveries();
    return promise;
  }

  private pumpRecoveries(): void {
    while (!this.stopping && this.recoveries.size < MAX_RECOVERY_SCOPES && this.recoveryQueue.length) {
      const scope = this.recoveryQueue.shift()!;
      const queued = this.queuedRecoveries.get(scope);
      if (!queued) continue;
      this.queuedRecoveries.delete(scope);
      this.recoveries.set(scope, queued);
      void (async () => {
        try {
          do {
            queued.rerun = false;
            await this.scanPending(scope === '*' ? undefined : scope);
          } while (!this.stopping && queued.rerun);
          queued.resolve();
        } catch (error) { queued.reject(error); }
        finally {
          if (this.recoveries.get(scope) === queued) this.recoveries.delete(scope);
          this.pumpRecoveries();
        }
      })();
    }
  }

  private async scanPending(accountId?: string): Promise<void> {
    const list = this.repository.listPendingLineDeliveryJobs;
    if (!list) return;
    let cursor: string | undefined;
    while (!this.stopping) {
      const jobIds = await list.call(this.repository, accountId, cursor, RECOVERY_PAGE_SIZE);
      if (this.stopping || !jobIds.length) return;
      for (const jobId of jobIds) {
        if (this.stopping) return;
        await this.deliverCompletedJob(jobId);
      }
      cursor = jobIds.at(-1);
      if (!cursor || jobIds.length < RECOVERY_PAGE_SIZE) return;
    }
  }

  private drainDeferredAccounts(): void {
    if (this.stopping || this.deferredRecoveryInFlight || this.activeSendAccounts.size >= MAX_SEND_SCOPES) return;
    const nextAccount = [...this.deferredAccounts].find((accountId) => !this.activeSendAccounts.has(accountId));
    if (nextAccount) {
      this.deferredAccounts.delete(nextAccount);
      this.deferredRecoveryInFlight = true;
      void this.recoverPending(nextAccount).catch((error: unknown) => this.reportFailure('recover', error, 'failed', { accountId: nextAccount, background: true })).finally(() => {
        this.deferredRecoveryInFlight = false;
        this.drainDeferredAccounts();
      });
      return;
    }
    if (this.globalRecoveryNeeded) {
      this.globalRecoveryNeeded = false;
      void this.recoverPending().catch((error: unknown) => this.reportFailure('recover', error, 'failed', { background: true }));
    }
  }

  deliverCompletedJob(jobId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const active = this.activeJobs.get(jobId);
    if (active) return active;
    const operation = this.deliverJob(jobId).catch((error: unknown) => {
      if (!this.stopping) this.reportFailure('execute', error, 'failed', { jobId });
      throw error;
    });
    this.activeJobs.set(jobId, operation);
    void operation.finally(() => { if (this.activeJobs.get(jobId) === operation) this.activeJobs.delete(jobId); }).catch(() => undefined);
    return operation;
  }

  private async deliverJob(jobId: string): Promise<void> {
    const job = await this.repository.getJob(jobId);
    if (!job || job.sourceType !== 'line' || job.creationEpoch === null || this.stopping) return;
    if (!await this.canWriteLine(job.accountId)) return;
    const binding = await this.worker.binding(job.accountId);
    const acknowledged = !this.worker.waitModeAck || await this.worker.waitModeAck(job.accountId, 'ACTIVE_CONTROL', 0);
    if (!binding || binding.mode !== 'ACTIVE_CONTROL' || !acknowledged) return;
    if (this.activeSendAccounts.has(job.accountId) || this.activeSendAccounts.size >= MAX_SEND_SCOPES) {
      if (this.deferredAccounts.size < MAX_QUEUED_RECOVERY_SCOPES) this.deferredAccounts.add(job.accountId);
      else this.globalRecoveryNeeded = true;
      return;
    }
    this.activeSendAccounts.add(job.accountId);
    try {
      for (const segment of await this.repository.listDeliveries(jobId)) {
        if (this.stopping || segment.status !== 'pending') continue;
        if (!await this.canWriteLine(job.accountId)) return;
        const claimed = await this.repository.claimLineDelivery(jobId, segment.partIndex, binding.controlEpoch);
        if (!claimed) return;
        const fresh = await this.worker.binding(claimed.accountId);
        if (!fresh || fresh.mode !== 'ACTIVE_CONTROL' || fresh.controlEpoch !== claimed.controlEpoch
          || fresh.workerInstanceId !== binding.workerInstanceId
          || (this.worker.waitModeAck && !await this.worker.waitModeAck(claimed.accountId, 'ACTIVE_CONTROL', 0))) {
          await this.repository.markDeliveryUnknown(jobId, segment.partIndex);
          continue;
        }
        const requestId = randomUUID();
        try {
          const result = await this.worker.send({ type: 'sendText', accountId: claimed.accountId,
            chatType: claimed.chatType, chatId: claimed.chatId, workerInstanceId: fresh.workerInstanceId,
            controlEpoch: fresh.controlEpoch, requestId, text: claimed.text, replyToMessageId: null }, this.controller.signal);
          if (result.requestId === requestId && result.accountId === claimed.accountId
            && result.workerInstanceId === fresh.workerInstanceId && result.controlEpoch === fresh.controlEpoch
            && result.status === 'sent' && result.messageId) {
            await this.repository.markDeliverySent(jobId, segment.partIndex, result.messageId);
          } else {
            this.reportFailure('response', undefined, 'unknown', { jobId, accountId: claimed.accountId, requestId, workerInstanceId: fresh.workerInstanceId });
            await this.repository.markDeliveryUnknown(jobId, segment.partIndex);
          }
        } catch (error) {
          this.reportFailure('execute', error, 'unknown', { jobId, accountId: claimed.accountId, requestId, workerInstanceId: fresh.workerInstanceId });
          await this.repository.markDeliveryUnknown(jobId, segment.partIndex);
        }
      }
    } finally {
      this.activeSendAccounts.delete(job.accountId);
      this.drainDeferredAccounts();
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.controller.abort();
    for (const queued of this.queuedRecoveries.values()) queued.resolve();
    this.queuedRecoveries.clear();
    this.recoveryQueue.length = 0;
    const active = [...this.recoveries.values()].map((entry) => entry.promise)
      .concat([...this.activeJobs.values()]);
    if (!active.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(active), new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
