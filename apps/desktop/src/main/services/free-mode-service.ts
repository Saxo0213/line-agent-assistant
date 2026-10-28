import { randomUUID } from 'node:crypto';
import type { AgentProvider, InboundEnvelope } from '@line-agent/contracts';
import type { FreeModeKey, FreeModeRow, RoomFreeModeRepository } from '@line-agent/database';
import type { SystemTextInput, SystemTextResult } from './agent-line-send-service.js';
import { FREE_MODE_MAX_MINUTES, FREE_MODE_MIN_MINUTES, type FreeCommand } from './trigger-router.js';

/** Quiet time after the last pending message before a batch becomes a job. */
export const FREE_MODE_QUIET_MS = 20_000;
/** Longest wait from the first pending message. */
export const FREE_MODE_MAX_WAIT_MS = 60_000;
/** While a free-mode job is in flight, how often its status is checked. */
export const FREE_MODE_INFLIGHT_POLL_MS = 5_000;
/** An expiry older than this at startup is cleared without a notice. */
export const FREE_MODE_STARTUP_NOTICE_MS = 120_000;
export const FREE_MODE_BATCH_MESSAGES_MAX = 50;
export const FREE_MODE_MESSAGE_CHARS_MAX = 2_000;
/** Same value as FREE_MODE_PRINCIPAL in agent-line-send-service (kept literal so this module needs no runtime import of it). */
const FREE_MODE_AUDIT_PRINCIPAL = 'system:free_mode' as const;
export const FREE_MODE_NO_REPLY_MARKER = '[[NO_REPLY]]';

export const FREE_MODE_TEXT = {
  on: (minutes: number) => `AGENT自動回覆${minutes}分鐘`,
  off: '自由模式已關閉',
  notOn: '自由模式未開啟',
  ended: '自由模式已結束',
  roomNotEnabled: '此群組尚未啟用 Agent，無法開啟自由模式',
  range: `自由模式分鐘數須為 ${FREE_MODE_MIN_MINUTES} 到 ${FREE_MODE_MAX_MINUTES} 的整數`,
  remaining: (minutes: number) => `自由模式剩餘 ${minutes} 分鐘`,
} as const;

export type FreeModeStore = Pick<RoomFreeModeRepository,
  'activate' | 'deactivate' | 'list' | 'expire' | 'isJobActive' | 'enqueueJob' | 'memberNames'>;

export interface FreeModeServiceOptions {
  store: FreeModeStore;
  /** The room's active Agent grant (ENABLED policy + active AGENT_USE_ROOM grant), or null when the room is not enabled. */
  roomGrant(key: FreeModeKey): Promise<{ grantId: string; version: number } | null>;
  sendSystemText(input: SystemTextInput): Promise<SystemTextResult>;
  provider(key: FreeModeKey): Promise<AgentProvider>;
  /** The Agent workspace path, or null when none is available. */
  workspacePath(): Promise<string | null>;
  kick(key: FreeModeKey): void;
  now?: () => Date;
  onError?(error: unknown): void;
}

interface PendingMessage { messageId: string; senderId: string; text: string; occurredAt: Date }
interface ChatState {
  key: FreeModeKey;
  expiresAt: Date | null;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  pending: PendingMessage[];
  firstAt: number;
  lastAt: number;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** The one free-mode job in flight; `jobId` stays undefined while it is being inserted. */
  inflight: { jobId?: string } | undefined;
  lane: Promise<unknown>;
}

const keyOf = (key: FreeModeKey): string => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const taipeiTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

/** HH:mm in Asia/Taipei. */
export function formatTaipeiTime(date: Date): string {
  return taipeiTime.format(date);
}

export interface FreeModeBatchMessage { senderName: string | null; senderId: string; text: string; occurredAt: Date }

/** The job prompt of one batch: the instruction, then one `[名稱] HH:mm 內容` line per message. */
export function composeFreeModePrompt(messages: readonly FreeModeBatchMessage[]): string {
  const lines = messages.map((message) => {
    const name = message.senderName ?? `成員 ${message.senderId.slice(-4)}`;
    return `[${name}] ${formatTaipeiTime(message.occurredAt)} ${message.text}`;
  });
  return [
    '[群組自由模式] 目前群組開啟自由模式：成員不必標註你，群組內的新訊息都會交給你。',
    '請以自然的語氣回覆這段對話；需要時可先用讀取工具查看近期聊天記錄。',
    `若沒有任何需要回覆的內容，只輸出 ${FREE_MODE_NO_REPLY_MARKER}，不要加其他文字。`,
    '',
    '新訊息（時間為台北時間）：',
    ...lines,
  ].join('\n');
}

/**
 * Group free mode: durable per-chat window, in-memory debounce of the members' messages, one Agent job per batch with the
 * room-member principal (docs/architecture/group-free-mode.md).
 */
export class FreeModeService {
  private readonly chats = new Map<string, ChatState>();
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly options: FreeModeServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Loads the durable rows: expired ones are cleared (with a notice only when the expiry is recent), the rest get their timers. */
  async start(): Promise<void> {
    const now = this.now();
    for (const row of await this.options.store.list()) {
      if (row.expiresAt.getTime() > now.getTime()) { this.arm(row); continue; }
      if (!await this.options.store.expire(row, row.expiresAt)) continue;
      if (now.getTime() - row.expiresAt.getTime() < FREE_MODE_STARTUP_NOTICE_MS) await this.notify(row, FREE_MODE_TEXT.ended);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.chats.values()) {
      clearTimeout(state.expiryTimer);
      clearTimeout(state.flushTimer);
    }
    this.chats.clear();
  }

  isActive(key: FreeModeKey): boolean {
    const state = this.chats.get(keyOf(key));
    return !!state?.expiresAt && state.expiresAt.getTime() > this.now().getTime();
  }

  /** The `/status` line while free mode is on, else null. */
  statusText(key: FreeModeKey): string | null {
    const expiresAt = this.chats.get(keyOf(key))?.expiresAt;
    if (!expiresAt) return null;
    const remaining = expiresAt.getTime() - this.now().getTime();
    return remaining > 0 ? FREE_MODE_TEXT.remaining(Math.ceil(remaining / 60_000)) : null;
  }

  /** Runs a Primary Administrator `/free` command. Commands of one chat run in order. */
  handleCommand(key: FreeModeKey, enabledBy: string, command: FreeCommand): Promise<void> {
    return this.enqueue(this.state(key), async () => {
      if (command.type === 'free_range') { await this.notify(key, FREE_MODE_TEXT.range); return; }
      if (command.action === 'off') {
        if (!this.isActive(key)) { await this.notify(key, FREE_MODE_TEXT.notOn); return; }
        await this.options.store.deactivate(key);
        this.clear(key);
        await this.notify(key, FREE_MODE_TEXT.off);
        return;
      }
      if (!await this.options.roomGrant(key)) { await this.notify(key, FREE_MODE_TEXT.roomNotEnabled); return; }
      const row = await this.options.store.activate(key, enabledBy, new Date(this.now().getTime() + command.minutes * 60_000));
      this.arm(row);
      await this.notify(key, FREE_MODE_TEXT.on(command.minutes));
    });
  }

  /** Adds one member text to the chat's pending batch. A chat that is not on is ignored. */
  addMessage(envelope: InboundEnvelope): void {
    const key = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId } as FreeModeKey;
    const state = this.chats.get(keyOf(key));
    if (this.stopped || !state || !this.isActive(key) || envelope.text === null) return;
    const at = this.now().getTime();
    if (state.pending.length === 0) state.firstAt = at;
    state.lastAt = at;
    state.pending.push({ messageId: envelope.messageId, senderId: envelope.senderId,
      text: envelope.text.slice(0, FREE_MODE_MESSAGE_CHARS_MAX), occurredAt: new Date(envelope.occurredAt) });
    if (state.pending.length > FREE_MODE_BATCH_MESSAGES_MAX) state.pending.splice(0, state.pending.length - FREE_MODE_BATCH_MESSAGES_MAX);
    this.scheduleFlush(state);
  }

  /** Removes a message from the pending batch (an explicit administrator mention takes the normal path instead). */
  discardMessage(key: FreeModeKey, messageId: string): void {
    const state = this.chats.get(keyOf(key));
    if (state) state.pending = state.pending.filter((message) => message.messageId !== messageId);
  }

  private state(key: FreeModeKey): ChatState {
    const id = keyOf(key);
    let state = this.chats.get(id);
    if (!state) {
      state = { key: { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }, expiresAt: null, expiryTimer: undefined,
        pending: [], firstAt: 0, lastAt: 0, flushTimer: undefined, inflight: undefined, lane: Promise.resolve() };
      this.chats.set(id, state);
    }
    return state;
  }

  private enqueue(state: ChatState, work: () => Promise<void>): Promise<void> {
    const run = state.lane.then(work).catch((error: unknown) => this.options.onError?.(error));
    state.lane = run;
    return run;
  }

  /** Marks the chat on until the row's expiry and (re)starts its expiry timer. */
  private arm(row: Pick<FreeModeRow, 'accountId' | 'chatType' | 'chatId' | 'expiresAt'>): void {
    const state = this.state(row);
    clearTimeout(state.expiryTimer);
    state.expiresAt = row.expiresAt;
    const expiresAt = row.expiresAt;
    const delay = Math.max(0, expiresAt.getTime() - this.now().getTime());
    state.expiryTimer = setTimeout(() => { void this.expire(state, expiresAt); }, delay);
  }

  private async expire(state: ChatState, expiresAt: Date): Promise<void> {
    await this.enqueue(state, async () => {
      if (state.expiresAt?.getTime() !== expiresAt.getTime()) return; // reset in the meantime
      const removed = await this.options.store.expire(state.key, expiresAt);
      this.clear(state.key);
      if (removed) await this.notify(state.key, FREE_MODE_TEXT.ended);
    });
  }

  /** Forgets the on state, the pending batch and the timers of a chat. A job already in flight is left to finish. */
  private clear(key: FreeModeKey): void {
    const state = this.chats.get(keyOf(key));
    if (!state) return;
    clearTimeout(state.expiryTimer);
    clearTimeout(state.flushTimer);
    state.expiresAt = null;
    state.pending = [];
    if (!state.inflight) this.chats.delete(keyOf(key));
  }

  private scheduleFlush(state: ChatState, minimumDelay = 0): void {
    clearTimeout(state.flushTimer);
    if (state.pending.length === 0 || this.stopped) return;
    const due = Math.min(state.lastAt + FREE_MODE_QUIET_MS, state.firstAt + FREE_MODE_MAX_WAIT_MS);
    const delay = Math.max(minimumDelay, due - this.now().getTime(), 0);
    state.flushTimer = setTimeout(() => { void this.flush(state); }, delay);
  }

  private async flush(state: ChatState): Promise<void> {
    try {
      if (this.stopped || !state.expiresAt || state.pending.length === 0) return;
      if (state.inflight) {
        const jobId = state.inflight.jobId;
        const active = jobId === undefined ? true : await this.options.store.isJobActive(jobId);
        if (active) { this.scheduleFlush(state, jobId === undefined ? 1_000 : FREE_MODE_INFLIGHT_POLL_MS); return; }
        state.inflight = undefined;
      }
      const batch = state.pending;
      state.pending = [];
      const slot: { jobId?: string } = {};
      state.inflight = slot;
      try {
        const key = state.key;
        const [grant, workspacePath] = await Promise.all([this.options.roomGrant(key), this.options.workspacePath()]);
        if (!grant || !workspacePath || !state.expiresAt) return;
        const provider = await this.options.provider(key);
        const names = await this.options.store.memberNames(key, [...new Set(batch.map((message) => message.senderId))]);
        const prompt = composeFreeModePrompt(batch.map((message) => ({ senderId: message.senderId,
          senderName: names.get(message.senderId) ?? null, text: message.text, occurredAt: message.occurredAt })));
        const job = await this.options.store.enqueueJob({ key, sourceMessageId: batch.at(-1)!.messageId, provider, prompt,
          workspacePath, roomGrant: grant });
        if (job) { slot.jobId = job.jobId; this.options.kick(key); }
      } finally {
        if (slot.jobId === undefined && state.inflight === slot) state.inflight = undefined;
        if (state.expiresAt) this.scheduleFlush(state);
        else if (!state.inflight) this.chats.delete(keyOf(state.key));
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async notify(key: FreeModeKey, text: string): Promise<void> {
    try {
      await this.options.sendSystemText({ runId: randomUUID(), principalId: FREE_MODE_AUDIT_PRINCIPAL,
        target: { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }, text });
    } catch (error) { this.options.onError?.(error); }
  }
}
