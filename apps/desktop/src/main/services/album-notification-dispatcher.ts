import type { ConversationKey } from '@line-agent/contracts';
import { AlbumArchiveFailure, type AlbumFailureContext, type AlbumOpenResult, type ChatResourceBinding } from './chat-resources.js';

type DispatchDemand = { key: ConversationKey; binding: ChatResourceBinding; sweep: boolean; recover: boolean; backfill: boolean };
type AccountFlight = { binding: ChatResourceBinding; dirty: boolean; sweep: boolean; recover: boolean; backfill: boolean;
  target: ConversationKey; promise: Promise<void> };

/** Runs bounded photo chunks to completion while retaining any failure from every earlier chunk. */
export async function archiveAlbumContinuations(openSegment: (cursor: string | null, photoIndex: number) => Promise<AlbumOpenResult>): Promise<void> {
  let cursor: string | null = null;
  let photoIndex = 0;
  let failedCount = 0;
  let failureContext: AlbumFailureContext | undefined;
  let anchor: string | undefined;
  let power = 1;
  let cycleLength = 0;
  for (;;) {
    const result = await openSegment(cursor, photoIndex);
    failedCount += result.failedCount;
    failureContext ??= result.failureContext;
    if (result.complete) {
      if (failedCount > 0) throw new AlbumArchiveFailure(failureContext ?? {
        action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' });
      return;
    }
    if (result.nextCursor === null && result.nextPhotoIndex === 0) {
      throw new AlbumArchiveFailure(failureContext ?? (result.errorCode === 'CURSOR_LOOP'
        ? { action: 'album_photos', stage: 'pagination', code: 'ALBUM_PHOTO_CURSOR_LOOP' }
        : failedCount > 0 ? { action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' }
          : { action: 'album_photos', stage: 'archive_scan', code: 'ALBUM_ARCHIVE_INCOMPLETE' }));
    }
    if (result.nextPhotoIndex > 0) { cursor = result.nextCursor; photoIndex = result.nextPhotoIndex; }
    else if (result.nextCursor !== cursor) { cursor = result.nextCursor; photoIndex = 0; }
    else photoIndex = result.nextPhotoIndex;
    const checkpoint = `${cursor ?? ''}\0${photoIndex}`;
    if (anchor === undefined) anchor = checkpoint;
    else {
      cycleLength += 1;
      if (checkpoint === anchor) throw new AlbumArchiveFailure({ action: 'album_photos', stage: 'pagination', code: 'ALBUM_PHOTO_CURSOR_LOOP' });
      if (cycleLength === power) { anchor = checkpoint; power *= 2; cycleLength = 0; }
    }
  }
}

/** Main-process admission owner. Pending work stays in committed AB message rows; memory holds one sweep per account. */
export class AlbumNotificationDispatcher {
  private readonly flights = new Map<string, AccountFlight>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryDemands = new Map<string, DispatchDemand>();
  private stopped = false;

  constructor(private readonly scanCommittedDemand: (accountId: string, binding: ChatResourceBinding, target: ConversationKey | null,
    options: { sweep: boolean; recover: boolean; backfill: boolean }) => Promise<number | null | void>,
    private readonly currentBinding: (accountId: string) => Promise<ChatResourceBinding | null>) {}

  request(key: ConversationKey, binding: ChatResourceBinding, forceSweep = false): void {
    this.admit({ key, binding, sweep: forceSweep, recover: false, backfill: false });
  }

  private admit(demand: DispatchDemand): void {
    const { key, binding, forceSweep } = { ...demand, forceSweep: demand.sweep };
    if (this.stopped || binding.mode !== 'ACTIVE_CONTROL') return;
    if (this.retryTimers.has(key.accountId)) {
      this.retainRetryDemand(demand);
      return;
    }
    const active = this.flights.get(key.accountId);
    if (active) {
      active.dirty = true;
      active.binding = binding;
      if (forceSweep || active.target.chatType !== key.chatType || active.target.chatId !== key.chatId) active.sweep = true;
      active.recover ||= demand.recover;
      active.backfill ||= demand.backfill;
      return;
    }
    const flight: AccountFlight = { binding, dirty: forceSweep, sweep: forceSweep, recover: demand.recover,
      backfill: demand.backfill, target: key, promise: Promise.resolve() };
    flight.promise = (async () => {
      for (;;) {
        flight.dirty = false;
        const capturedBinding = flight.binding;
        let current: ChatResourceBinding | null;
        try { current = await this.currentBinding(key.accountId); }
        catch {
          if (!this.stopped) this.scheduleRetry(key, capturedBinding, true, flight.recover, flight.backfill);
          break;
        }
        if (!current || current.mode !== 'ACTIVE_CONTROL' || !sameBinding(current, capturedBinding)) break;
        const target = flight.sweep ? null : flight.target;
        const options = { sweep: flight.sweep, recover: flight.recover, backfill: flight.backfill };
        flight.sweep = false;
        flight.recover = false;
        flight.backfill = false;
        try {
          const nextRetryAt = await this.scanCommittedDemand(key.accountId, capturedBinding, target, options);
          if (nextRetryAt !== undefined && nextRetryAt !== null && Number.isFinite(nextRetryAt)) {
            this.scheduleWake(key, capturedBinding, nextRetryAt);
          }
        }
        catch {
          if (!this.stopped) this.scheduleRetry(key, capturedBinding, true, true, options.backfill);
          break;
        }
        this.retryAttempts.delete(key.accountId);
        if (this.stopped || !flight.dirty) break;
      }
    })().finally(() => {
      if (this.flights.get(key.accountId) !== flight) return;
      if (flight.dirty && !this.stopped) {
        if (this.retryTimers.has(key.accountId)) {
          this.retainRetryDemand({ key: flight.target, binding: flight.binding, sweep: flight.sweep,
            recover: flight.recover, backfill: flight.backfill });
          this.flights.delete(key.accountId);
          return;
        }
        // Delete and reacquire synchronously; requests cannot interleave this handoff.
        const { target, binding, sweep, recover, backfill } = flight;
        this.flights.delete(key.accountId);
        this.admit({ key: target, binding, sweep, recover, backfill });
      } else {
        this.flights.delete(key.accountId);
      }
    });
    this.flights.set(key.accountId, flight);
  }

  /** Startup reconciliation uses committed AB rows as the bounded, crash-safe demand source. */
  recover(accountId: string, binding: ChatResourceBinding): void {
    const key: ConversationKey = { accountId, chatType: 'group', chatId: '_startup_recovery_' };
    this.admit({ key, binding, sweep: true, recover: true, backfill: true });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryDemands.clear();
    this.retryAttempts.clear();
    await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
  }

  private scheduleRetry(key: ConversationKey, binding: ChatResourceBinding, sweep: boolean, recover = false, backfill = false): void {
    if (this.stopped) return;
    this.retainRetryDemand({ key, binding, sweep, recover, backfill });
    if (this.retryTimers.has(key.accountId)) return;
    const attempt = this.retryAttempts.get(key.accountId) ?? 0;
    this.retryAttempts.set(key.accountId, Math.min(attempt + 1, 5));
    const delayMs = Math.min(5_000 * 2 ** attempt, 60_000);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key.accountId);
      const demand = this.retryDemands.get(key.accountId);
      this.retryDemands.delete(key.accountId);
      if (!this.stopped && demand) this.admit(demand);
    }, delayMs);
    this.retryTimers.set(key.accountId, timer);
  }

  private scheduleWake(key: ConversationKey, binding: ChatResourceBinding, retryAt: number): void {
    if (this.stopped) return;
    if (this.retryTimers.has(key.accountId)) return;
    this.retainRetryDemand({ key, binding, sweep: true, recover: false, backfill: false });
    const delayMs = Math.max(0, Math.min(2_147_000_000, retryAt - Date.now()));
    const timer = setTimeout(() => {
      this.retryTimers.delete(key.accountId);
      const demand = this.retryDemands.get(key.accountId);
      this.retryDemands.delete(key.accountId);
      if (!this.stopped && demand) this.admit(demand);
    }, delayMs);
    this.retryTimers.set(key.accountId, timer);
  }

  private retainRetryDemand(demand: DispatchDemand): void {
    const { key, binding, sweep } = demand;
    const pending = this.retryDemands.get(key.accountId);
    if (!pending) {
      this.retryDemands.set(key.accountId, demand);
      return;
    }
    const sameTarget = pending.key.chatType === key.chatType && pending.key.chatId === key.chatId;
    pending.binding = binding;
    if (!sameTarget || sweep) pending.sweep = true;
    pending.recover ||= demand.recover;
    pending.backfill ||= demand.backfill;
  }
}

function sameBinding(left: ChatResourceBinding, right: ChatResourceBinding): boolean {
  return left.accountId === right.accountId && left.workerInstanceId === right.workerInstanceId
    && left.controlEpoch === right.controlEpoch && left.transportOwnerId === right.transportOwnerId
    && left.transportGeneration === right.transportGeneration && left.writeGrantVersion === right.writeGrantVersion;
}
