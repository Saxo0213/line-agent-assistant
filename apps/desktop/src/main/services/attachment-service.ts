import { randomUUID } from 'node:crypto';
import { diagnosticFailure, type AttachmentBlockReason, type SafeDiagnostic } from '@line-agent/contracts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isWritableChatType, type AttachmentResult, type LineWorkerCommand, type NativeAttachmentDownloadInput, type WorkerBinding } from '@line-agent/contracts';
import type { Attachment, AttachmentAttemptMutation, AttachmentPriorState, MessageRepository } from '@line-agent/database';
import { pickWorkerBinding } from '../worker-binding-fields.js';

type DownloadCommand = Extract<LineWorkerCommand, { type: 'downloadAttachment' }>;
interface AttachmentWorker {
  binding(accountId: string): Promise<(WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) | null>;
  isReady(binding: WorkerBinding, canAcquireAuth?: () => boolean): Promise<boolean>;
  download(command: DownloadCommand, signal?: AbortSignal): Promise<AttachmentResult>;
}
interface RecoveryScan {
  accountId: string | undefined;
  afterAttachmentId: string | undefined;
  afterAccountId?: string;
  generation: number;
}

export const ATTACHMENT_GAP_MIN_MS = 3_000;
export const ATTACHMENT_GAP_MAX_MS = 10_000;

export class AttachmentService {
  private static readonly MAX_ADMITTED = 256;
  private static readonly READ_AHEAD = 16;
  private readonly ownerId = randomUUID();
  private readonly queued = new Set<string>();
  private readonly manualQueued = new Set<string>();
  private readonly waiters = new Map<string, { promise: Promise<boolean>; resolve(value: boolean): void }>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly controllers = new Map<string, AbortController>();
  private dispatcher: Promise<void> | null = null;
  private readonly recoveryScans: RecoveryScan[] = [];
  private readonly scanGenerations = new Map<string | undefined, number>();
  private activeScan: RecoveryScan | null = null;
  private nextScanGeneration = 0;
  private globalScanCycleComplete = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private nextAutomaticAt = 0;
  private closed = false;
  private automaticAttemptLimit = 3;
  private readonly maxConcurrent = 1;
  private readonly externalDownloadLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
  constructor(private readonly messages: MessageRepository, private readonly worker: AttachmentWorker,
    private readonly root?: string, maxConcurrent = 4,
    private readonly onChanged?: (attachmentId: string) => void | Promise<void>,
    private readonly onDispatcherError?: (error: unknown, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void,
    private readonly resolveNativeAttachment?: (attachment: Attachment, signal: AbortSignal) => Promise<NativeAttachmentDownloadInput | null>,
    private readonly isAccountConnected?: (accountId: string) => Promise<boolean>,
    private readonly random: () => number = Math.random,
    private readonly onServerRejection?: (result: Extract<AttachmentResult, { status: 'failed' | 'expired' }>) => void,
    private readonly onBlockReasonChanged?: (accountId: string, reason: AttachmentBlockReason) => void,
    private readonly onPrimaryReady?: (key: import('@line-agent/contracts').WritableConversationKey, attachmentId: string) => void | Promise<void>) {
    void maxConcurrent;
  }

  /** Last worker block reason that was reported for each account. It is cleared when a download passes the worker checks. */
  private readonly workerBlockReasons = new Map<string, AttachmentBlockReason>();
  private readonly externalBlockAccounts = new Set<string>();

  /**
   * Keep the reason why a queued attachment cannot download now.
   * The row is written only when its value changes. The account audit is reported only when the account reason changes.
   * It never throws and never changes the download order or the retry count.
   */
  private async recordBlock(attachment: Attachment, reason: AttachmentBlockReason): Promise<void> {
    try {
      // An External Monitor row keeps its own reason. A worker reason is for the account audit only.
      if (attachment.status === 'queued' && attachment.error !== reason
        && (!attachment.externalSource || reason === 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE')
        && await this.messages.setAttachmentBlockReason(attachment.attachmentId, reason)) this.notifyChanged(attachment.attachmentId);
    } catch { /* A reason write must not change attachment handling. */ }
    try {
      if (reason === 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE') {
        if (this.externalBlockAccounts.has(attachment.accountId)) return;
        this.externalBlockAccounts.add(attachment.accountId);
      } else {
        if (this.workerBlockReasons.get(attachment.accountId) === reason) return;
        this.workerBlockReasons.set(attachment.accountId, reason);
      }
      this.onBlockReasonChanged?.(attachment.accountId, reason);
    } catch { /* Audit must not change attachment handling. */ }
  }

  /** Set the reason on old External Monitor rows. No scan selects them. */
  async backfillBlockReasons(): Promise<void> {
    try {
      for (let pass = 0; pass < 20 && !this.closed; pass += 1) {
        if (await this.messages.backfillExternalAttachmentBlockReasons(1000) < 1000) break;
      }
    } catch { /* The backfill runs again at the next start. */ }
  }

  setAutomaticAttemptLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 3 || limit > 10) throw new Error('Invalid automatic attachment attempt limit');
    this.automaticAttemptLimit = limit;
    void this.recover();
  }

  private reportFailure(stage: SafeDiagnostic['stage'], error?: unknown, identity?: import('@line-agent/contracts').DiagnosticIdentity): void {
    try { this.onDispatcherError?.(diagnosticFailure('attachment', stage, error), identity); } catch { /* Diagnostics never change attachment state. */ }
  }

  private notifyChanged(attachmentId: string): void {
    if (this.closed) return;
    try { void Promise.resolve(this.onChanged?.(attachmentId)).catch(() => undefined); } catch { /* State publication must not affect attachment durability. */ }
  }

  downloadById(attachmentId: string, signal?: AbortSignal): Promise<boolean> {
    return this.enqueue(attachmentId, false, signal);
  }

  async downloadManually(key: { accountId: string; chatType: Attachment['chatType']; chatId: string }, attachmentId: string): Promise<boolean> {
    if (this.closed) return false;
    const attachment = await this.messages.getAttachment(attachmentId);
    if (!attachment || attachment.accountId !== key.accountId || attachment.chatType !== key.chatType || attachment.chatId !== key.chatId) return false;
    if (this.isAccountConnected && !await this.isAccountConnected(key.accountId)) return false;
    if (this.externalSourceExpired(attachment)) return false;
    const existing = this.inFlight.get(attachmentId) ?? this.waiters.get(attachmentId)?.promise;
    if (existing) return existing;
    if (attachment.status !== 'expired' && !(attachment.status === 'failed' && (attachment.externalSource
      || attachment.retryCount >= this.automaticAttemptLimit || attachment.retryAfter === 'infinity'))
      && !(attachment.status === 'queued' && attachment.externalSource)) return false;
    return this.enqueue(attachmentId, true);
  }

  private externalSourceExpired(attachment: Attachment): boolean {
    if (!attachment.externalSource) return false;
    const occurredAt = Date.parse(attachment.occurredAt);
    return !Number.isFinite(occurredAt) || occurredAt < Date.now() - this.externalDownloadLifetimeMs;
  }

  private enqueue(attachmentId: string, manual: boolean, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.resolve(false);
    const existing = this.inFlight.get(attachmentId) ?? this.waiters.get(attachmentId)?.promise;
    if (existing) return existing;
    if (this.waiters.size >= AttachmentService.MAX_ADMITTED) return Promise.resolve(false);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    this.waiters.set(attachmentId, { promise, resolve });
    this.queued.add(attachmentId);
    if (manual) this.manualQueued.add(attachmentId);
    if (signal) {
      const cancel = () => {
        if (this.queued.delete(attachmentId)) {
          this.waiters.get(attachmentId)?.resolve(false);
          this.waiters.delete(attachmentId);
        } else this.controllers.get(attachmentId)?.abort(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      void promise.finally(() => signal.removeEventListener('abort', cancel));
    }
    this.kick();
    return promise;
  }

  private async downloadClaimed(attachmentId: string, signal: AbortSignal, manual: boolean): Promise<boolean> {
    const attachment = await this.messages.getAttachment(attachmentId);
    if (!signal.aborted && attachment && !manual && attachment.externalSource && isWritableChatType(attachment.chatType)
      && (attachment.status === 'queued' || attachment.status === 'failed') && !this.externalSourceExpired(attachment)) {
      await this.recordBlock(attachment, 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE');
    }
    if (signal.aborted || !attachment || attachment.status === 'ready' || attachment.status === 'downloading'
      || !isWritableChatType(attachment.chatType)
      || this.externalSourceExpired(attachment)
      || (!manual && attachment.externalSource)
      || (!manual && attachment.status === 'expired')
      || (manual && attachment.status !== 'expired' && !(attachment.status === 'failed' && (attachment.externalSource
        || attachment.retryCount >= this.automaticAttemptLimit || attachment.retryAfter === 'infinity'))
        && !(attachment.status === 'queued' && attachment.externalSource))) return false;
    const binding = await this.worker.binding(attachment.accountId);
    if (signal.aborted || this.externalSourceExpired(attachment)) return false;
    if (!binding) { await this.recordBlock(attachment, 'ATTACHMENT_WORKER_UNAVAILABLE'); return false; }
    if (binding.mode === 'PAUSED') { await this.recordBlock(attachment, 'ATTACHMENT_WORKER_NOT_READY'); return false; }
    const ready = await this.worker.isReady(binding, () => !this.externalSourceExpired(attachment));
    if (signal.aborted || this.externalSourceExpired(attachment)) return false;
    if (!ready) { await this.recordBlock(attachment, 'ATTACHMENT_WORKER_NOT_READY'); return false; }
    // The worker checks passed. The claim below clears the row reason. A later block is a new reason change.
    this.workerBlockReasons.delete(attachment.accountId);
    const mutation = { attachmentId, accountId: attachment.accountId, chatType: attachment.chatType,
      chatId: attachment.chatId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
    const attemptToken = await this.messages.claimAttachmentDownload({ ...mutation, ownerId: this.ownerId },
      { manual, expected: attachment as AttachmentPriorState, automaticAttemptLimit: this.automaticAttemptLimit });
    if (!attemptToken) return false;
    const attempt: AttachmentAttemptMutation = { ...mutation, ownerId: this.ownerId, attemptToken };
    if (this.closed || signal.aborted || this.externalSourceExpired(attachment)) {
      await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
      return false;
    }
    let current: (WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) | null = null;
    try {
      current = await this.worker.binding(attachment.accountId);
      if (!current || current.mode === 'PAUSED' || current.workerInstanceId !== binding.workerInstanceId
        || current.controlEpoch !== binding.controlEpoch || this.externalSourceExpired(attachment)
        || !await this.worker.isReady(current, () => !this.externalSourceExpired(attachment))
        || signal.aborted || this.externalSourceExpired(attachment)) {
        await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
        return false;
      }
    } catch {
      await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
      return false;
    }
    this.notifyChanged(attachmentId);
    const identity = { requestId: attachmentId, accountId: attachment.accountId, workerInstanceId: binding.workerInstanceId, correlationId: randomUUID() };
    let dispatched = false;
    let stage: SafeDiagnostic['stage'] = 'prepare';
    try {
      const lease = pickWorkerBinding(binding);
      let nativeAttachment: NativeAttachmentDownloadInput | null | undefined;
      if (attachment.externalSource) {
        if (this.externalSourceExpired(attachment)) {
          await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
          return false;
        }
        try { nativeAttachment = await this.resolveNativeAttachment?.(attachment, signal) ?? null; }
        catch (error) { this.reportFailure('prepare', error, identity); nativeAttachment = null; }
      }
      if (this.externalSourceExpired(attachment)) {
        await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
        return false;
      }
      const sourceName = nativeAttachment?.fileName ?? attachment.name;
      const syntheticName = sourceName == null || sourceName.trim().length === 0;
      const command: DownloadCommand = { type: 'downloadAttachment', ...lease,
        accountId: attachment.accountId, chatType: attachment.chatType, chatId: attachment.chatId,
        requestId: attachment.attachmentId, attemptToken, messageId: attachment.messageId, attachmentId: attachment.attachmentId,
        externalAttachmentId: attachment.externalAttachmentId, kind: attachment.kind,
        occurredAt: attachment.occurredAt, originalFileName: nativeAttachment?.fileName ?? attachment.name ?? 'attachment.bin',
        ...(attachment.chatType !== 'direct' ? { senderId: attachment.senderId ?? 'unknown', senderDisplayName: attachment.senderDisplayName ?? null } : {}),
        lineMessage: attachment.lineMessage,
        ...(nativeAttachment ? { nativeAttachment } : {}),
        maxBytes: 100 * 1024 * 1024, timeoutMs: 120_000 };
      if (this.closed || signal.aborted || this.externalSourceExpired(attachment)) {
        await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
        return false;
      }
      dispatched = true;
      stage = 'download';
      const result: AttachmentResult = await this.worker.download(command, signal);
      stage = 'persist';
      if (this.closed) return false;
      if (result.attachmentId !== attachmentId || result.attemptToken !== attemptToken || result.workerInstanceId !== binding.workerInstanceId
        || result.accountId !== attachment.accountId || result.chatType !== attachment.chatType
        || result.chatId !== attachment.chatId) {
        this.reportFailure('response', undefined, identity);
        await this.messages.markAttachmentFailed(attempt, 'Mismatched worker attachment result', this.automaticAttemptLimit);
        this.notifyChanged(attachmentId); return false;
      }
      if (result.status === 'ready') {
        const name = syntheticName && (result.name === 'attachment.bin' || /^attachment\.[A-Za-z0-9]{1,12}$/.test(result.name))
          ? undefined : result.name;
        const ready = await this.messages.markAttachmentReady(attempt,
          { relativePath: result.relativePath, sha256: result.sha256, sizeBytes: result.sizeBytes, ...(name === undefined ? {} : { name }) });
        if (ready) void Promise.resolve(this.onPrimaryReady?.({ accountId: attachment.accountId, chatType: attachment.chatType as import('@line-agent/contracts').WritableConversationKey['chatType'], chatId: attachment.chatId }, attachmentId))
          .catch((error: unknown) => this.reportFailure('persist', error, identity));
        this.notifyChanged(attachmentId);
        return ready;
      }
      if (result.status === 'expired') await this.messages.markAttachmentExpired(attempt, result.error);
      else await this.messages.markAttachmentFailed(attempt, result.error, this.automaticAttemptLimit);
      if (result.serverErrorCode) {
        try { this.onServerRejection?.(result); } catch { /* Diagnostics cannot change attachment state. */ }
      }
      this.reportFailure('download', undefined, identity);
      this.notifyChanged(attachmentId);
      return false;
    } catch (error) {
      if (!signal.aborted && !this.closed) this.reportFailure(stage, error, identity);
      if (this.closed) return false;
      if (!dispatched) await this.messages.cancelAttachmentDownloadBeforeDispatch(attempt, attachment).catch(() => false);
      else if (signal.aborted) await this.messages.cancelAttachmentDownload(attempt, this.automaticAttemptLimit).catch(() => false);
      else await this.messages.markAttachmentFailed(attempt, 'ATTACHMENT_ATTEMPT_FAILED', this.automaticAttemptLimit);
      this.notifyChanged(attachmentId);
      return false;
    } finally {
      if (dispatched) this.nextAutomaticAt = Date.now() + this.randomGapMs();
    }
  }

  private randomGapMs(): number {
    const span = ATTACHMENT_GAP_MAX_MS - ATTACHMENT_GAP_MIN_MS + 1;
    const unit = Math.min(Math.max(this.random(), 0), 0.999999999);
    return ATTACHMENT_GAP_MIN_MS + Math.floor(unit * span);
  }

  async recover(accountId?: string): Promise<void> {
    if (this.closed) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const generation = ++this.nextScanGeneration;
    this.scanGenerations.set(accountId, generation);
    if (accountId === undefined) this.globalScanCycleComplete = false;

    // A new recovery request supersedes only that account's old cursor pass.
    // Other accounts may have durable work queued behind the current page.
    const activeScan = this.activeScan;
    const activeFirstPage = activeScan !== null && activeScan.accountId === accountId
      && activeScan.afterAttachmentId === undefined && activeScan.afterAccountId === undefined;
    if (activeFirstPage && activeScan) activeScan.generation = generation;
    for (let i = this.recoveryScans.length - 1; i >= 0; i -= 1) {
      if (this.recoveryScans[i]?.accountId === accountId) this.recoveryScans.splice(i, 1);
    }
    if (!activeFirstPage) this.recoveryScans.push({ accountId, afterAttachmentId: undefined, generation });

    // Keep request memory bounded. A global first-page scan conservatively
    // subsumes all pending scopes if many distinct accounts arrive at once.
    if (this.recoveryScans.length > 64) {
      this.scanGenerations.clear();
      this.recoveryScans.length = 0;
      const globalGeneration = ++this.nextScanGeneration;
      this.scanGenerations.set(undefined, globalGeneration);
      this.recoveryScans.push({ accountId: undefined, afterAttachmentId: undefined, generation: globalGeneration });
    }
    this.kick();
  }

  private scheduleScanRetry(): void {
    if (this.closed || this.retryTimer || this.queued.size || this.inFlight.size || this.recoveryScans.length) return;
    void this.scheduleDurableWake();
  }

  private armWake(delay: number): void {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.recover(); }, Math.max(1, delay));
  }

  private async scheduleDurableWake(): Promise<void> {
    if (this.closed || this.retryTimer) return;
    try {
      const nextAt = await this.messages.nextAttachmentWakeAt(this.automaticAttemptLimit);
      const delay = nextAt === null || nextAt <= Date.now() ? 30_000 : Math.min(30_000, nextAt - Date.now());
      this.armWake(delay);
    } catch (error) {
      if (this.onDispatcherError) this.onDispatcherError(error);
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.retryAttempt++, 5));
      this.armWake(delay);
    }
  }

  private kick(): void {
    if (this.dispatcher || this.closed) return;
    this.dispatcher = (async () => {
      while (!this.closed && this.inFlight.size < this.maxConcurrent) {
        if (!this.queued.size && this.recoveryScans.length) {
          const scan = this.recoveryScans.shift()!;
          this.activeScan = scan;
          let ids: string[];
          let globalPage: Awaited<ReturnType<MessageRepository['recoverAttachmentPage']>> | undefined;
          try {
            if (scan.accountId === undefined) {
              globalPage = await this.messages.recoverAttachmentPage(scan.afterAccountId ?? null, AttachmentService.READ_AHEAD, this.automaticAttemptLimit);
              ids = globalPage.items.map((item) => item.attachmentId);
            } else ids = await this.messages.recoverAttachments(scan.accountId, scan.afterAttachmentId, this.automaticAttemptLimit);
          }
          finally { this.activeScan = null; }
          if (this.closed) break;
          if (this.scanGenerations.get(scan.accountId) !== scan.generation) continue;
          if (globalPage) {
            let lastConsumedAccountId = scan.afterAccountId;
            let truncated = false;
            for (const item of globalPage.items) {
              if (this.waiters.size >= AttachmentService.MAX_ADMITTED) {
                truncated = true;
                break;
              }
              const id = item.attachmentId;
              if (!this.waiters.has(id) && !this.inFlight.has(id)) {
                let resolve!: (value: boolean) => void;
                const promise = new Promise<boolean>((done) => { resolve = done; });
                this.waiters.set(id, { promise, resolve });
                this.queued.add(id);
              }
              lastConsumedAccountId = item.accountId;
            }
            if ((truncated || globalPage.hasMore) && globalPage.items.length) {
              const afterAccountId = truncated ? lastConsumedAccountId : globalPage.items.at(-1)!.accountId;
              this.recoveryScans.push(afterAccountId === undefined ? scan : { ...scan, afterAccountId });
            } else {
              this.globalScanCycleComplete = true;
              this.scanGenerations.delete(undefined);
            }
            if (!this.queued.size && !this.recoveryScans.length) this.scheduleScanRetry();
          } else {
          let lastScannedId = scan.afterAttachmentId;
          let truncated = false;
          for (const id of ids) {
            if (this.waiters.size >= AttachmentService.MAX_ADMITTED) {
              truncated = true;
              break;
            }
            if (!this.waiters.has(id) && !this.inFlight.has(id)) {
              let resolve!: (value: boolean) => void;
              const promise = new Promise<boolean>((done) => { resolve = done; });
              this.waiters.set(id, { promise, resolve });
              this.queued.add(id);
            }
            lastScannedId = id;
          }
          if (truncated || ids.length === 256) {
            this.recoveryScans.push({ ...scan, afterAttachmentId: lastScannedId });
          } else if (!this.recoveryScans.some((next) => next.accountId === scan.accountId)
            && this.scanGenerations.get(scan.accountId) === scan.generation) {
            this.scanGenerations.delete(scan.accountId);
          }
          }
          if (!this.queued.size && !this.recoveryScans.length) break;
        }
        const id = (this.manualQueued.size ? [...this.manualQueued].find((candidate) => this.queued.has(candidate)) : undefined)
          ?? this.queued.values().next().value as string | undefined;
        if (!id) break;
        const manual = this.manualQueued.has(id);
        if (!manual) {
          let wakeAt = this.nextAutomaticAt;
          let row: Attachment | null;
          try { row = await this.messages.getAttachment(id); }
          catch { this.armWake(Math.min(30_000, 1_000 * 2 ** Math.min(this.retryAttempt++, 5))); break; }
          if (row?.status === 'queued' || row?.status === 'failed') {
            const dueAt = row.status === 'queued' ? Date.parse(row.createdAt) + 10_000 : Date.parse(row.retryAfter ?? new Date(Date.parse(row.updatedAt) + Math.min(300_000, 10_000 * 2 ** Math.max(0, row.retryCount - 1))).toISOString());
            if (Number.isFinite(dueAt)) wakeAt = Math.max(wakeAt, dueAt);
          }
          if (wakeAt > Date.now()) {
            this.armWake(Math.min(30_000, wakeAt - Date.now()));
            break;
          }
        }
        this.queued.delete(id);
        this.manualQueued.delete(id);
        const controller = new AbortController();
        this.controllers.set(id, controller);
        const task = (async () => {
          let result = false;
          try { result = await this.downloadClaimed(id, controller.signal, manual); } catch { result = false; }
          this.waiters.get(id)?.resolve(result);
          this.controllers.delete(id);
          this.inFlight.delete(id);
          this.waiters.delete(id);
          if (result) {
            this.retryAttempt = 0;
            const attachment = await this.messages.getAttachment(id).catch(() => null);
            if (attachment) void this.recover(attachment.accountId);
          }
          this.scheduleScanRetry();
          this.kick();
          return result;
        })();
        this.inFlight.set(id, task);
      }
    })().catch((error: unknown) => {
      try {
        if (this.onDispatcherError) this.onDispatcherError(error);
        else console.error('Attachment recovery dispatcher failed; retry scheduled', error);
      } catch { /* Reporting cannot break the dispatcher. */ }
      if (!this.closed && !this.retryTimer) {
        const delay = Math.min(30_000, 250 * 2 ** Math.min(this.retryAttempt++, 7));
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.recover(); }, delay);
      }
    }).finally(() => { this.dispatcher = null;
      this.scheduleScanRetry();
      if (!this.closed && !this.retryTimer && this.inFlight.size < this.maxConcurrent && (this.queued.size || this.recoveryScans.length)) this.kick(); });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const controller of this.controllers.values()) controller.abort(new Error('Attachment service shutting down'));
    for (const id of this.queued) {
      this.waiters.get(id)?.resolve(false);
      this.waiters.delete(id);
    }
    this.queued.clear();
    this.manualQueued.clear();
    this.recoveryScans.length = 0;
    this.scanGenerations.clear();
    const drain = Promise.allSettled([...this.inFlight.values()]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([drain, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
    } finally { if (timer) clearTimeout(timer); }
    try { await this.messages.revokeAttachmentOwner(this.ownerId, this.automaticAttemptLimit); }
    finally {
      for (const waiter of this.waiters.values()) waiter.resolve(false);
      this.waiters.clear();
    }
  }

  async resolveReadyPath(attachmentId: string): Promise<string | null> {
    if (!this.root) throw new Error('Managed attachment root is not configured');
    const item: Attachment | null = await this.messages.getAttachment(attachmentId);
    if (!item || item.status !== 'ready' || !item.relativePath || item.relativePath.includes('\\')
      || item.relativePath.startsWith('/') || item.relativePath.split('/').some((part) => !part || part === '..' || part === '.')) return null;
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, ...item.relativePath.split('/')));
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return target;
  }
}
