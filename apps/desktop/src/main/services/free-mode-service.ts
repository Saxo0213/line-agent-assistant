import { randomUUID } from 'node:crypto';
import type { AgentPersona, AgentProvider, InboundEnvelope } from '@line-agent/contracts';
import { buildFreeModeJudgePrompt, personaFingerprint } from './agent-persona.js';
import type { FreeModeKey, FreeModeRow, RoomFreeModeRepository } from '@line-agent/database';
import type { SystemTextInput, SystemTextResult } from './agent-line-send-service.js';
import { FREE_MODE_MAX_MINUTES, FREE_MODE_MIN_MINUTES, type FreeCommand } from './trigger-router.js';

/** Quiet time after the last pending message before the batch goes to the judge. */
export const FREE_MODE_QUIET_MS = 3_000;
/** Longest wait from the first pending message; a steady stream of messages still reaches the judge by then. */
export const FREE_MODE_MAX_WAIT_MS = 15_000;
/** While a reply waits for the running one to finish, how often that job's status is checked. */
export const FREE_MODE_INFLIGHT_POLL_MS = 2_000;
/** The judge must answer within this time; a late or missing answer counts as "do not reply". */
export const FREE_MODE_JUDGE_TIMEOUT_MS = 20_000;
/** A reply verdict with at least this urgency may interrupt the reply that is being produced. */
export const FREE_MODE_INTERRUPT_URGENCY = 70;
/** Interruptions allowed in one round (from the first reply job of an idle chat to the last job's completion). */
export const FREE_MODE_INTERRUPTS_MAX = 2;
/** An expiry older than this at startup is cleared without a notice. */
export const FREE_MODE_STARTUP_NOTICE_MS = 120_000;
export const FREE_MODE_BATCH_MESSAGES_MAX = 50;
export const FREE_MODE_MESSAGE_CHARS_MAX = 2_000;
/** Message text shown to the judge for the in-flight trigger summary and the skipped list. */
const JUDGE_MESSAGE_CHARS_MAX = 300;
/** Same value as FREE_MODE_PRINCIPAL in agent-line-send-service (kept literal so this module needs no runtime import of it). */
const FREE_MODE_AUDIT_PRINCIPAL = 'system:free_mode' as const;
export const FREE_MODE_NO_REPLY_MARKER = '[[NO_REPLY]]';

export const FREE_MODE_TEXT = {
  on: (minutes: number) => `AGENT自動回覆${minutes}分鐘`,
  off: '自由模式已關閉',
  notOn: '自由模式未開啟',
  ended: '自由模式已結束',
  roomNotEnabled: '此群組尚未啟用 Agent，無法開啟自由模式',
  roomEnabled: '已啟用 Agent',
  range: `自由模式分鐘數須為 ${FREE_MODE_MIN_MINUTES} 到 ${FREE_MODE_MAX_MINUTES} 的整數`,
  remaining: (minutes: number) => `自由模式剩餘 ${minutes} 分鐘`,
  replyFailed: (reason: string) => `自由模式回覆失敗：${reason}`,
} as const;

/** Standing instructions of the judge session (system prompt for Claude, leading block for Codex). */
export const FREE_MODE_JUDGE_SYSTEM_PROMPT = [
  '你是 LINE 群組「自由模式」的回覆判斷器。群組裡有一位 AI Agent 助理，成員不必標註它。你的唯一工作是判斷：Agent 現在該不該回覆這批新訊息。',
  '你沒有任何工具，也不能查資料；只根據收到的訊息判斷，不要回答訊息內容本身。',
  '',
  '輸出：只輸出一行 JSON，不要加說明、程式碼區塊或其他文字：',
  '{"reply": true 或 false, "urgency": 0 到 100 的整數, "reason": "一句簡短理由"}',
  '',
  'reply 判斷準則：',
  '- 該回覆（true）：成員直接向 Agent 或「大家／有沒有人」提問、請求協助、指名 Agent、要求查詢或整理、對 Agent 先前的回覆追問或表達不滿、需要立即處理的事項。',
  '- 不回覆（false）：成員彼此閒聊或對話、單純貼圖或表情、與 Agent 無關的私人話題、已經有人回答完的問題、不需要回應的陳述或問候。',
  '- 「先前判斷不回覆的訊息」只是脈絡；若新訊息讓這些內容變得需要回覆，可以判為 true。',
  '- 若 Agent 已在回覆中，只有新訊息確實需要另外回應，或改變了先前回覆的方向時才判為 true。',
  '',
  'urgency 是急迫度／情緒值（reply 為 false 時通常 0 到 30）：',
  '- 80 到 100：成員直接問 Agent 問題或點名 Agent、明顯不滿或生氣、緊急事項（出事、時限將到）、新訊息推翻或更正先前要 Agent 做的事。',
  '- 40 到 79：一般請求、需要 Agent 回覆但不趕時間、情緒中性偏負面。',
  '- 0 到 39：閒聊、貼圖、成員彼此對話、補充資訊、可有可無的回應。',
  '分數要能區分輕重：不確定時偏低，不要全部給高分。',
].join('\n');

export type FreeModeStore = Pick<RoomFreeModeRepository,
  'activate' | 'deactivate' | 'list' | 'expire' | 'isJobActive' | 'enqueueJob' | 'memberNames'>;

export interface FreeModeJudgeInput {
  key: FreeModeKey;
  provider: AgentProvider;
  systemPrompt: string;
  prompt: string;
  /** The judge session of this free-mode window; absent for the first call of a window. */
  resumeSessionId?: string;
  timeoutMs: number;
}
export interface FreeModeJudgeOutput { text: string; sessionId: string }
export interface FreeModeJudgeVerdict { reply: boolean; urgency: number; reason: string }

export type FreeModeAuditEvent =
  | { type: 'judge'; key: FreeModeKey; verdict: FreeModeJudgeVerdict; replying: boolean }
  | { type: 'judge_failed'; key: FreeModeKey; error: unknown }
  | { type: 'interrupt'; key: FreeModeKey; jobId: string; interrupts: number }
  | { type: 'interrupt_refused'; key: FreeModeKey; jobId: string; reason: 'limit' | 'urgency' | 'not_running' };

export interface FreeModeServiceOptions {
  store: FreeModeStore;
  /** The room's active Agent grant (ENABLED policy + active AGENT_USE_ROOM grant), or null when the room is not enabled. */
  roomGrant(key: FreeModeKey): Promise<{ grantId: string; version: number } | null>;
  /**
   * Enables the room on the Primary Administrator's word and returns its active grant (`announce` when this call enabled it),
   * or null when the room cannot be enabled. The grant is committed before the call returns.
   */
  enableRoom?(key: FreeModeKey, adminUserId: string, sourceMessageId: string):
    Promise<{ grant: { grantId: string; version: number }; announce: boolean } | null>;
  sendSystemText(input: SystemTextInput): Promise<SystemTextResult>;
  provider(key: FreeModeKey): Promise<AgentProvider>;
  /** The Agent persona in force for the chat (docs/architecture/agent-persona.md). Absent or failing: the neutral, normal-liveliness default. */
  persona?(key: FreeModeKey): Promise<AgentPersona>;
  /**
   * Whether the free-mode member principal can run a job on `provider` in this chat (Codex needs the local-tools permission, which the
   * default member rules usually lack). When false for Codex, free mode uses Claude for the reply job and the judge.
   */
  canUseProvider?(key: FreeModeKey, provider: AgentProvider): Promise<boolean>;
  /** The Agent workspace path, or null when none is available. */
  workspacePath(): Promise<string | null>;
  /** One fast, tool-less judge turn. Absent: nothing is ever judged to need a reply. */
  judge?(input: FreeModeJudgeInput): Promise<FreeModeJudgeOutput>;
  /** Cancels a free-mode job that has not completed. Resolves true when this call cancelled it (nothing it produced is sent). */
  interruptJob?(key: FreeModeKey, jobId: string): Promise<boolean>;
  kick(key: FreeModeKey): void;
  now?: () => Date;
  onError?(error: unknown): void;
  /** Judge verdicts, judge failures and interruptions. */
  audit?(event: FreeModeAuditEvent): void;
}

interface PendingMessage { messageId: string; senderId: string; text: string; occurredAt: Date }
interface ChatState {
  key: FreeModeKey;
  expiresAt: Date | null;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Messages the judge has not seen yet. */
  pending: PendingMessage[];
  firstAt: number;
  lastAt: number;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Judged messages that have no reply yet (judge said no, or the reply waits for the running one). */
  unanswered: PendingMessage[];
  /** The judge said "reply" while a reply was running: answer `unanswered` when that one completes. */
  deferredReply: boolean;
  /** The reply job in flight and the messages it answers. */
  inflight: { jobId: string; messages: PendingMessage[] } | undefined;
  interrupts: number;
  judgeSession: { provider: AgentProvider; id: string; persona: string } | undefined;
  /** Bumped when the window ends, so a judge answer that arrives afterwards is dropped. */
  windowEpoch: number;
  /** Recent reply job ids (newest last) so a late failure event still finds its chat. */
  recentJobs: string[];
  /** Jobs we cancelled ourselves: their end is not a failure. */
  interruptedJobs: Set<string>;
  /** One failure notice per free-mode window. */
  failureNotified: boolean;
  busy: boolean;
  lane: Promise<unknown>;
}

const keyOf = (key: FreeModeKey): string => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const taipeiTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const capMessages = (messages: PendingMessage[]): PendingMessage[] =>
  messages.length > FREE_MODE_BATCH_MESSAGES_MAX ? messages.slice(-FREE_MODE_BATCH_MESSAGES_MAX) : messages;

/** HH:mm in Asia/Taipei. */
export function formatTaipeiTime(date: Date): string {
  return taipeiTime.format(date);
}

export interface FreeModeBatchMessage { senderName: string | null; senderId: string; text: string; occurredAt: Date }

const messageLines = (messages: readonly FreeModeBatchMessage[], maxChars = Infinity): string[] => messages.map((message) => {
  const name = message.senderName ?? `成員 ${message.senderId.slice(-4)}`;
  const text = message.text.length > maxChars ? `${message.text.slice(0, maxChars)}…` : message.text;
  return `[${name}] ${formatTaipeiTime(message.occurredAt)} ${text}`;
});

/** The job prompt of one reply: the instruction, then one `[名稱] HH:mm 內容` line per message. */
export function composeFreeModePrompt(messages: readonly FreeModeBatchMessage[], options: { interrupted?: boolean } = {}): string {
  return [
    '[群組自由模式] 目前群組開啟自由模式：成員不必標註你，群組內的新訊息都會交給你。',
    '判斷已決定需要回覆以下訊息（其中可能含先前未回覆的訊息）。請以自然的語氣回覆這段對話；需要時可先用讀取工具查看近期聊天記錄；需要即時資訊（天氣、新聞、價格等）時，可用網路搜尋工具查詢。',
    ...(options.interrupted ? ['你先前的回覆已被新訊息打斷（尚未送出），請把先前與新的訊息一併回覆。'] : []),
    '',
    '訊息（時間為台北時間）：',
    ...messageLines(messages),
  ].join('\n');
}

/** The judge turn: the reply state, earlier skipped messages and the new batch. */
export function composeFreeModeJudgePrompt(input: { inflight: readonly FreeModeBatchMessage[] | null;
  skipped: readonly FreeModeBatchMessage[]; batch: readonly FreeModeBatchMessage[] }): string {
  return [
    '[目前回覆狀態]',
    ...(input.inflight ? ['Agent 正在回覆（尚未送出），觸發訊息：', ...messageLines(input.inflight.slice(-5), JUDGE_MESSAGE_CHARS_MAX)] : ['沒有進行中的回覆。']),
    '',
    '[先前判斷不回覆的訊息]',
    ...(input.skipped.length ? messageLines(input.skipped, JUDGE_MESSAGE_CHARS_MAX) : ['（無）']),
    '',
    '[新訊息（台北時間）]',
    ...messageLines(input.batch, JUDGE_MESSAGE_CHARS_MAX),
    '',
    '請只輸出 JSON。',
  ].join('\n');
}

/** Strict parse of the judge answer: `{"reply": boolean, "urgency": 0-100, "reason": string}`; anything else is null. */
export function parseFreeModeVerdict(text: string): FreeModeJudgeVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof value.reply !== 'boolean') return null;
    const urgency = typeof value.urgency === 'number' && Number.isFinite(value.urgency)
      ? Math.min(100, Math.max(0, Math.round(value.urgency))) : 0;
    return { reply: value.reply, urgency, reason: typeof value.reason === 'string' ? value.reason.slice(0, 200) : '' };
  } catch { return null; }
}

/**
 * Group free mode: durable per-chat window; in-memory batching of the members' messages; a fast judge decides whether a batch
 * needs a reply; a reply is one Agent job with the room-member principal (docs/architecture/group-free-mode.md).
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
  handleCommand(key: FreeModeKey, enabledBy: string, command: FreeCommand, sourceMessageId?: string): Promise<void> {
    return this.enqueue(this.state(key), async () => {
      if (command.type === 'free_range') { await this.notify(key, FREE_MODE_TEXT.range); return; }
      if (command.action === 'off') {
        if (!this.isActive(key)) { await this.notify(key, FREE_MODE_TEXT.notOn); return; }
        await this.options.store.deactivate(key);
        this.clear(key);
        await this.notify(key, FREE_MODE_TEXT.off);
        return;
      }
      // A room that is not enabled is first enabled on the Primary Administrator's word; the grant commits before free mode activates.
      if (!await this.options.roomGrant(key)) {
        const enabled = sourceMessageId === undefined ? null : await this.options.enableRoom?.(key, enabledBy, sourceMessageId) ?? null;
        if (!enabled) { await this.notify(key, FREE_MODE_TEXT.roomNotEnabled); return; }
        if (enabled.announce) await this.notify(key, FREE_MODE_TEXT.roomEnabled);
      }
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
    state.pending = capMessages(state.pending);
    this.scheduleFlush(state);
  }

  /** Removes a message from the pending batch (an explicit administrator mention takes the normal path instead). */
  discardMessage(key: FreeModeKey, messageId: string): void {
    const state = this.chats.get(keyOf(key));
    if (!state) return;
    state.pending = state.pending.filter((message) => message.messageId !== messageId);
    state.unanswered = state.unanswered.filter((message) => message.messageId !== messageId);
  }

  private state(key: FreeModeKey): ChatState {
    const id = keyOf(key);
    let state = this.chats.get(id);
    if (!state) {
      state = { key: { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }, expiresAt: null, expiryTimer: undefined,
        pending: [], firstAt: 0, lastAt: 0, flushTimer: undefined, unanswered: [], deferredReply: false, inflight: undefined,
        interrupts: 0, judgeSession: undefined, windowEpoch: 0, recentJobs: [], interruptedJobs: new Set(), failureNotified: false, busy: false, lane: Promise.resolve() };
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

  /** Ends the window of a chat: forgets the on state, the batches, the judge session and the timers. A job already in flight is left to finish. */
  private clear(key: FreeModeKey): void {
    const state = this.chats.get(keyOf(key));
    if (!state) return;
    clearTimeout(state.expiryTimer);
    clearTimeout(state.flushTimer);
    state.expiresAt = null;
    state.pending = [];
    state.unanswered = [];
    state.deferredReply = false;
    state.judgeSession = undefined;
    state.windowEpoch += 1;
    state.failureNotified = false;
    if (!state.inflight && !state.busy) this.chats.delete(keyOf(key));
  }

  private scheduleFlush(state: ChatState, minimumDelay = 0): void {
    clearTimeout(state.flushTimer);
    if (this.stopped || !state.expiresAt) return;
    let delay: number;
    if (state.pending.length > 0) {
      const due = Math.min(state.lastAt + FREE_MODE_QUIET_MS, state.firstAt + FREE_MODE_MAX_WAIT_MS);
      delay = Math.max(minimumDelay, due - this.now().getTime(), 0);
    } else if (state.deferredReply && state.unanswered.length > 0) delay = FREE_MODE_INFLIGHT_POLL_MS;
    else return;
    state.flushTimer = setTimeout(() => { void this.flush(state); }, delay);
  }

  /** One pass: finish the running reply bookkeeping, start a waiting reply, then judge the pending batch. */
  private async flush(state: ChatState): Promise<void> {
    if (state.busy || this.stopped) return;
    state.busy = true;
    try {
      if (!state.expiresAt) return;
      if (state.inflight && !await this.options.store.isJobActive(state.inflight.jobId)) {
        state.inflight = undefined;
        state.interrupts = 0; // the round ends with the last job's completion
      }
      if (!state.inflight && state.deferredReply) {
        state.deferredReply = false;
        if (state.unanswered.length > 0) {
          const messages = state.unanswered;
          state.unanswered = [];
          await this.startReply(state, messages, false);
        }
      }
      if (state.pending.length > 0) await this.judgeBatch(state);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      state.busy = false;
      if (state.expiresAt) this.scheduleFlush(state);
      else if (!state.inflight) this.chats.delete(keyOf(state.key));
    }
  }

  /** The chat's provider, except that Codex falls back to Claude when the member principal could not run it. */
  private async effectiveProvider(key: FreeModeKey): Promise<AgentProvider> {
    const provider = await this.options.provider(key);
    if (provider === 'codex' && this.options.canUseProvider && !await this.options.canUseProvider(key, provider)) return 'claude';
    return provider;
  }

  /** A free-mode reply job ended failed. One notice per window; jobs this service cancelled itself are ignored. */
  noteJobFailed(jobId: string, message: string): void {
    const state = [...this.chats.values()].find((candidate) => candidate.recentJobs.includes(jobId));
    if (!state || state.interruptedJobs.has(jobId) || state.failureNotified || !state.expiresAt) return;
    state.failureNotified = true;
    const reason = message.replace(/\s+/g, ' ').trim().slice(0, 80) || '未知原因';
    void this.enqueue(state, () => this.notify(state.key, FREE_MODE_TEXT.replyFailed(reason)));
  }

  private async names(key: FreeModeKey, messages: readonly PendingMessage[]): Promise<Map<string, string>> {
    return this.options.store.memberNames(key, [...new Set(messages.map((message) => message.senderId))]);
  }

  private batchMessages(messages: readonly PendingMessage[], names: Map<string, string>): FreeModeBatchMessage[] {
    return messages.map((message) => ({ senderId: message.senderId, senderName: names.get(message.senderId) ?? null,
      text: message.text, occurredAt: message.occurredAt }));
  }

  private async judgeBatch(state: ChatState): Promise<void> {
    const key = state.key;
    const batch = state.pending;
    state.pending = [];
    const epoch = state.windowEpoch;
    const verdict = await this.askJudge(state, batch);
    if (state.windowEpoch !== epoch || !state.expiresAt) return; // the window ended while judging
    const inflight = state.inflight;
    if (verdict) this.options.audit?.({ type: 'judge', key, verdict, replying: verdict.reply });
    if (!verdict?.reply) {
      state.unanswered = capMessages([...state.unanswered, ...batch]);
      return;
    }
    if (!inflight) {
      const messages = capMessages([...state.unanswered, ...batch]);
      state.unanswered = [];
      await this.startReply(state, messages, false);
      return;
    }
    // A reply is being produced: only a pressing verdict, within the round's limit, cancels it.
    const refusal = verdict.urgency < FREE_MODE_INTERRUPT_URGENCY ? 'urgency' as const
      : state.interrupts >= FREE_MODE_INTERRUPTS_MAX ? 'limit' as const : null;
    if (!refusal && this.options.interruptJob && await this.options.interruptJob(key, inflight.jobId)) {
      state.inflight = undefined;
      state.interruptedJobs.add(inflight.jobId);
      state.interrupts += 1;
      this.options.audit?.({ type: 'interrupt', key, jobId: inflight.jobId, interrupts: state.interrupts });
      const messages = capMessages([...inflight.messages, ...state.unanswered, ...batch]);
      state.unanswered = [];
      await this.startReply(state, messages, true);
      return;
    }
    this.options.audit?.({ type: 'interrupt_refused', key, jobId: inflight.jobId, reason: refusal ?? 'not_running' });
    state.unanswered = capMessages([...state.unanswered, ...batch]);
    state.deferredReply = true;
  }

  /** Asks the judge about one batch. Any failure, timeout or unparsable answer is `null` (do not reply). */
  private async askJudge(state: ChatState, batch: readonly PendingMessage[]): Promise<FreeModeJudgeVerdict | null> {
    const judge = this.options.judge;
    if (!judge) return null;
    const key = state.key;
    const epoch = state.windowEpoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = await this.effectiveProvider(key);
      const names = await this.names(key, [...(state.inflight?.messages ?? []), ...state.unanswered, ...batch]);
      const prompt = composeFreeModeJudgePrompt({
        inflight: state.inflight ? this.batchMessages(state.inflight.messages, names) : null,
        skipped: this.batchMessages(state.unanswered, names), batch: this.batchMessages(batch, names) });
      // The judge's standing instructions carry the liveliness and persona; a resumed session would keep the old ones.
      const persona = await this.options.persona?.(key).catch(() => null) ?? { description: '', liveliness: 'normal' as const };
      const fingerprint = personaFingerprint(persona);
      const resume = state.judgeSession?.provider === provider && state.judgeSession.persona === fingerprint ? state.judgeSession.id : undefined;
      const timeoutMs = FREE_MODE_JUDGE_TIMEOUT_MS;
      const output = await Promise.race([
        judge({ key, provider, systemPrompt: buildFreeModeJudgePrompt(FREE_MODE_JUDGE_SYSTEM_PROMPT, persona), prompt, timeoutMs, ...(resume ? { resumeSessionId: resume } : {}) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Free-mode judge timed out')), timeoutMs); }),
      ]);
      if (state.windowEpoch === epoch) state.judgeSession = { provider, id: output.sessionId, persona: fingerprint };
      const verdict = parseFreeModeVerdict(output.text);
      if (!verdict) throw new Error('Free-mode judge returned an invalid answer');
      return verdict;
    } catch (error) {
      if (state.windowEpoch === epoch) state.judgeSession = undefined; // a broken session is not resumed again
      this.options.audit?.({ type: 'judge_failed', key, error });
      return null;
    } finally { clearTimeout(timer); }
  }

  /** Inserts the reply job for `messages`. A job that cannot be inserted leaves the messages unanswered. */
  private async startReply(state: ChatState, messages: PendingMessage[], interrupted: boolean): Promise<void> {
    const key = state.key;
    const [grant, workspacePath] = await Promise.all([this.options.roomGrant(key), this.options.workspacePath()]);
    if (!grant || !workspacePath || !state.expiresAt) { state.unanswered = capMessages([...messages, ...state.unanswered]); return; }
    const provider = await this.effectiveProvider(key);
    const names = await this.names(key, messages);
    const prompt = composeFreeModePrompt(this.batchMessages(messages, names), { interrupted });
    const job = await this.options.store.enqueueJob({ key, sourceMessageId: messages.at(-1)!.messageId, provider, prompt,
      workspacePath, roomGrant: grant });
    if (!job) { state.unanswered = capMessages([...messages, ...state.unanswered]); return; }
    state.inflight = { jobId: job.jobId, messages };
    state.recentJobs = [...state.recentJobs.slice(-9), job.jobId];
    this.options.kick(key);
  }

  private async notify(key: FreeModeKey, text: string): Promise<void> {
    try {
      await this.options.sendSystemText({ runId: randomUUID(), principalId: FREE_MODE_AUDIT_PRINCIPAL,
        target: { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }, text });
    } catch (error) { this.options.onError?.(error); }
  }
}
