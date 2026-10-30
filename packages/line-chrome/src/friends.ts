// Friend-relation cache for the CHROMEOS transport (design ruling 9).
//
// `getAllContactIds [4]` (and `getBlockedContactIds [4]` when the registry has it) are fetched ONCE per session start and then
// kept current from the contact operations that arrive on the SSE stream. A relation check never calls the gateway again.
// A failed first load is not cached; it is retried at most once per `retryAfterMs`, so a broken endpoint cannot turn every
// check into a request.
//
// Op numbers are OkLine `OpType` (okline/enums.py:746-811). `param1` of each is the contact mid.

import type { ChromeOperation } from './receive/types.js';

export const CONTACT_OP = {
  ADD_CONTACT: 4,
  /** Op 5 is not an add: it announces that the contact list changed (OkLine enums.py:747-748). The cache ignores it. */
  NOTIFIED_ADD_CONTACT: 5,
  BLOCK_CONTACT: 6,
  UNBLOCK_CONTACT: 7,
  NOTIFIED_UNREGISTER_USER: 33,
  /** Contact data changed. The cache cannot tell what changed, so it is dropped and loads again (OkLine docs/receiving-events.md:108). */
  UPDATE_CONTACT: 49,
  NOTIFIED_BLOCK_CONTACT: 68,
  NOTIFIED_UNBLOCK_CONTACT: 69,
} as const;

const ADD_OPS: ReadonlySet<number> = new Set([CONTACT_OP.ADD_CONTACT]);
const BLOCK_OPS: ReadonlySet<number> = new Set([CONTACT_OP.BLOCK_CONTACT, CONTACT_OP.NOTIFIED_BLOCK_CONTACT]);
const UNBLOCK_OPS: ReadonlySet<number> = new Set([CONTACT_OP.UNBLOCK_CONTACT, CONTACT_OP.NOTIFIED_UNBLOCK_CONTACT]);
const MID = /^u[0-9a-f]{32}$/i;
/** Upper bound for one list, like the DESKTOPWIN adapter's 100,000-entry guard. */
export const FRIEND_LIST_LIMIT = 100_000;
export const FRIEND_LOAD_RETRY_MS = 60_000;

export type FriendRelationState = 'friend' | 'not_friend';

export class FriendListShapeError extends Error {
  constructor(message: string) { super(message); this.name = 'FriendListShapeError'; }
}

/** Op 49 arrived during a load, so the lists are stale. The caller may load once more. This is not a load failure. */
export class FriendListStaleError extends Error {
  constructor() { super('friend list changed during load'); this.name = 'FriendListStaleError'; }
}

export interface FriendLoaders {
  /** `Talk.TalkService.getAllContactIds [4]`. */
  contactIds(): Promise<unknown>;
  /** `Talk.TalkService.getBlockedContactIds [4]`; undefined when the endpoint is not part of the registry. */
  blockedContactIds?: (() => Promise<unknown>) | undefined;
}

function midList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new FriendListShapeError(`${what} is not a list`);
  if (value.length > FRIEND_LIST_LIMIT) throw new FriendListShapeError(`${what} is too long`);
  if (value.some((mid) => typeof mid !== 'string')) throw new FriendListShapeError(`${what} holds a non-string`);
  return value as string[];
}

export class FriendCache {
  private contacts: Set<string> | null = null;
  private blocked = new Set<string>();
  private loading: Promise<void> | null = null;
  private pending: ChromeOperation[] = [];
  private failedAt: number | null = null;
  private fetches = 0;
  /** Counts the calls to `reset()`. A load that started in an older generation must not install its lists. */
  private generation = 0;

  constructor(private readonly now: () => number = Date.now, private readonly retryAfterMs: number = FRIEND_LOAD_RETRY_MS) {}

  /** How many times the lists were fetched (tests assert it stays at one per session). */
  get loadCount(): number { return this.fetches; }
  get loaded(): boolean { return this.contacts !== null; }

  /** Forget everything: a new session (login, installSecrets) loads the lists again, once. */
  reset(): void {
    this.contacts = null;
    this.blocked = new Set();
    this.loading = null;
    this.pending = [];
    this.failedAt = null;
    this.generation += 1;
  }

  /**
   * Loads the lists if this session has not yet. Concurrent callers share one load. After a failure the next attempt waits
   * `retryAfterMs`; in between it rethrows the last failure without a request.
   */
  async ensureLoaded(loaders: FriendLoaders): Promise<void> {
    if (this.contacts !== null) return;
    if (this.loading !== null) return this.loading;
    if (this.failedAt !== null && this.now() - this.failedAt < this.retryAfterMs) throw new Error('friend list load failed recently');
    let load!: Promise<void>;
    load = (async () => {
      let stale = false;
      const generation = this.generation;
      try {
        this.fetches += 1;
        const contacts = new Set(midList(await loaders.contactIds(), 'contact list'));
        const blocked = loaders.blockedContactIds === undefined
          ? new Set<string>() : new Set(midList(await loaders.blockedContactIds(), 'blocked list'));
        if (generation !== this.generation) {
          // A reset ran during the load (op 49 or a revision jump): install nothing, start no cooldown.
          stale = true;
        } else {
          // Operations that arrived while the lists were in flight are newer than (or equal to) what the server returned.
          const queued = this.pending;
          this.contacts = contacts;
          this.blocked = blocked;
          this.pending = [];
          this.failedAt = null;
          this.applyAll(queued);
          // An update operation in the queue dropped the lists again: this load is already stale. It starts no cooldown.
          stale = this.contacts === null;
        }
      } catch (error) {
        this.failedAt = this.now();
        throw error;
      } finally {
        if (this.loading === load) this.loading = null;
      }
      if (stale) throw new FriendListStaleError();
    })();
    this.loading = load;
    return load;
  }

  /** Applies contact operations seen on the stream. Before the first load they are queued (the load will not have them). */
  observe(operations: readonly ChromeOperation[]): void {
    const relevant = operations.filter((operation) => contactOpType(operation) !== null);
    if (relevant.length === 0) return;
    if (this.contacts === null) {
      if (this.loading !== null) this.pending.push(...relevant);
      return;
    }
    this.applyAll(relevant);
  }

  /** `friend` = a contact that is not blocked. Requires `ensureLoaded` to have succeeded. */
  relation(mid: string): FriendRelationState {
    if (this.contacts === null) throw new Error('friend list is not loaded');
    return this.contacts.has(mid) && !this.blocked.has(mid) ? 'friend' : 'not_friend';
  }

  private applyAll(operations: readonly ChromeOperation[]): void {
    for (const operation of operations) {
      const type = contactOpType(operation);
      if (type === CONTACT_OP.UPDATE_CONTACT) { this.reset(); return; }
      const mid = operation.param1;
      if (type === null || typeof mid !== 'string' || !MID.test(mid)) continue;
      if (ADD_OPS.has(type)) this.contacts!.add(mid);
      else if (BLOCK_OPS.has(type)) this.blocked.add(mid);
      else if (UNBLOCK_OPS.has(type)) this.blocked.delete(mid);
      else if (type === CONTACT_OP.NOTIFIED_UNREGISTER_USER) { this.contacts!.delete(mid); this.blocked.delete(mid); }
    }
  }
}

function contactOpType(operation: ChromeOperation): number | null {
  const raw = operation.type;
  const type = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : null;
  if (type === null) return null;
  return ADD_OPS.has(type) || BLOCK_OPS.has(type) || UNBLOCK_OPS.has(type) || type === CONTACT_OP.NOTIFIED_UNREGISTER_USER ||
    type === CONTACT_OP.UPDATE_CONTACT ? type : null;
}
