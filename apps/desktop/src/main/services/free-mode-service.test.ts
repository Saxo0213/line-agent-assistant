import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import type { FreeModeKey, FreeModeRow } from '@line-agent/database';
import {
  FreeModeService, FREE_MODE_JUDGE_SYSTEM_PROMPT, composeFreeModePrompt, composeFreeModeJudgePrompt, parseFreeModeVerdict, formatTaipeiTime, FREE_MODE_TEXT,
  type FreeModeStore, type FreeModeJudgeInput, type FreeModeAuditEvent,
} from './free-mode-service.js';

const KEY: FreeModeKey = { accountId: 'acc', chatType: 'group', chatId: 'g1' };
const START = new Date('2026-10-28T06:00:00Z'); // 14:00 Asia/Taipei
const GRANT = { grantId: 'grant-1', version: 3 };

const message = (id: string, senderId: string, text: string, at = new Date()): InboundEnvelope => ({
  eventId: `e-${id}`, accountId: 'acc', chatId: 'g1', chatType: 'group', senderId, messageId: id, kind: 'text', text,
  mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
  occurredAt: at.toISOString(), attachments: [], raw: {} });

type Scripted = { reply: boolean; urgency: number; reason?: string } | string | Error;

function harness(over: { grant?: typeof GRANT | null; rows?: FreeModeRow[]; names?: Record<string, string>;
  enable?: 'enabled' | 'refused'; fallback?: Scripted; provider?: 'claude' | 'codex'; canUseCodex?: boolean } = {}) {
  const rows = new Map<string, FreeModeRow>();
  for (const row of over.rows ?? []) rows.set(row.chatId, row);
  const activeJobs = new Set<string>();
  let jobSeq = 0;
  const store = {
    activate: vi.fn(async (key: FreeModeKey, enabledBy: string, expiresAt: Date) => {
      const row = { ...key, enabledBy, expiresAt }; rows.set(key.chatId, row); return row;
    }),
    deactivate: vi.fn(async (key: FreeModeKey) => rows.delete(key.chatId)),
    list: vi.fn(async () => [...rows.values()]),
    expire: vi.fn(async (key: FreeModeKey, expiresAt: Date) => {
      const row = rows.get(key.chatId);
      if (!row || row.expiresAt.getTime() !== expiresAt.getTime()) return false;
      rows.delete(key.chatId); return true;
    }),
    isJobActive: vi.fn(async (jobId: string) => activeJobs.has(jobId)),
    enqueueJob: vi.fn(async (_input: unknown) => { const jobId = `job-${++jobSeq}`; activeJobs.add(jobId); return { jobId }; }),
    memberNames: vi.fn(async () => new Map(Object.entries(over.names ?? { alice: 'Alice', bob: 'Bob' }))),
  } satisfies FreeModeStore;
  const sent: string[] = [];
  const personaNow = { value: { description: '', liveliness: 'normal' as 'quiet' | 'normal' | 'lively' } };
  const sendSystemText = vi.fn(async (input: { text: string }) => { sent.push(input.text); return { status: 'sent' as const }; });
  const kick = vi.fn();
  const verdicts: Scripted[] = [];
  const judgeInputs: FreeModeJudgeInput[] = [];
  const judge = vi.fn(async (input: FreeModeJudgeInput) => {
    judgeInputs.push(input);
    const next = verdicts.shift() ?? over.fallback ?? { reply: true, urgency: 50, reason: 'asked' };
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : JSON.stringify(next), sessionId: 'judge-session-1' };
  });
  const cancelled: string[] = [];
  const interruptJob = vi.fn(async (_key: FreeModeKey, jobId: string) => {
    if (!activeJobs.has(jobId)) return false;
    activeJobs.delete(jobId); cancelled.push(jobId); return true;
  });
  const events: FreeModeAuditEvent[] = [];
  let grant = over.grant === undefined ? GRANT : over.grant;
  const order: string[] = [];
  const enableRoom = over.enable === undefined ? undefined : vi.fn(async (_key: FreeModeKey, _admin: string, _message: string) => {
    if (over.enable === 'refused') return null;
    grant = GRANT; order.push('enable'); return { grant: GRANT, announce: true };
  });
  store.activate.mockImplementationOnce(async (key: FreeModeKey, enabledBy: string, expiresAt: Date) => {
    order.push('activate'); const row = { ...key, enabledBy, expiresAt }; rows.set(key.chatId, row); return row;
  });
  const service = new FreeModeService({ store, roomGrant: async () => grant, ...(enableRoom ? { enableRoom } : {}), sendSystemText, provider: async () => over.provider ?? 'claude',
    ...(over.canUseCodex === undefined ? {} : { canUseProvider: async (_key: FreeModeKey, provider: string) => provider !== 'codex' || over.canUseCodex! }),
    workspacePath: async () => 'C:\\work', persona: async () => personaNow.value, kick, judge, interruptJob, audit: (event) => events.push(event), now: () => new Date(Date.now()), onError: (error) => { throw error; } });
  return { service, store, rows, sent, sendSystemText, kick, activeJobs, enableRoom, order, verdicts, judge, judgeInputs, interruptJob, cancelled, events, personaNow };
}

describe('FreeModeService', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
  afterEach(() => { vi.useRealTimers(); });

  it('turns on with the default 5 minutes and confirms through the free-mode principal', async () => {
    const h = harness();
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 });
    expect(h.store.activate).toHaveBeenCalledWith(KEY, 'admin', new Date(START.getTime() + 5 * 60_000));
    expect(h.sent).toEqual(['AGENT自動回覆5分鐘']);
    expect(h.sendSystemText.mock.calls[0]![0]).toMatchObject({ principalId: 'system:free_mode', target: KEY });
    expect(h.service.isActive(KEY)).toBe(true);
    expect(h.service.statusText(KEY)).toBe('自由模式剩餘 5 分鐘');
  });

  it('resets the window with /free N while on, using the same confirmation', async () => {
    const h = harness();
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 30 });
    expect(h.sent).toEqual(['AGENT自動回覆5分鐘', 'AGENT自動回覆30分鐘']);
    expect(h.service.statusText(KEY)).toBe('自由模式剩餘 30 分鐘');
    await vi.advanceTimersByTimeAsync(3 * 60_000); // the first window would have ended by now
    expect(h.sent).toHaveLength(2);
    expect(h.service.isActive(KEY)).toBe(true);
  });

  it('turns off only with /free off; off while already off says it is not on', async () => {
    const h = harness();
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
    expect(h.sent).toEqual([FREE_MODE_TEXT.notOn]);
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 });
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 }); // bare /free keeps it on
    expect(h.service.isActive(KEY)).toBe(true);
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
    expect(h.sent.at(-1)).toBe('自由模式已關閉');
    expect(h.service.isActive(KEY)).toBe(false);
    expect(h.rows.size).toBe(0);
  });

  it('replies with the range for an invalid argument and changes nothing', async () => {
    const h = harness();
    await h.service.handleCommand(KEY, 'admin', { type: 'free_range' });
    expect(h.sent).toEqual(['自由模式分鐘數須為 1 到 120 的整數']);
    expect(h.store.activate).not.toHaveBeenCalled();
  });

  it('refuses when the room has no active Agent grant', async () => {
    const h = harness({ grant: null });
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 });
    expect(h.sent).toEqual(['此群組尚未啟用 Agent，無法開啟自由模式']);
    expect(h.store.activate).not.toHaveBeenCalled();
    expect(h.service.isActive(KEY)).toBe(false);
  });

  it('enables a not-enabled room on the Primary Administrator word, commits the grant before activating, then confirms free mode', async () => {
    const h = harness({ grant: null, enable: 'enabled' });
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 10 }, 'msg-1');
    expect(h.enableRoom).toHaveBeenCalledWith(KEY, 'admin', 'msg-1');
    expect(h.order).toEqual(['enable', 'activate']);
    expect(h.sent).toEqual(['已啟用 Agent', 'AGENT自動回覆10分鐘']);
    expect(h.service.isActive(KEY)).toBe(true);
  });

  it('refuses when the room cannot be enabled, and never enables for /free off', async () => {
    const refused = harness({ grant: null, enable: 'refused' });
    await refused.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 }, 'msg-1');
    expect(refused.sent).toEqual([FREE_MODE_TEXT.roomNotEnabled]);
    expect(refused.store.activate).not.toHaveBeenCalled();
    const off = harness({ grant: null, enable: 'enabled' });
    await off.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' }, 'msg-2');
    expect(off.enableRoom).not.toHaveBeenCalled();
    expect(off.sent).toEqual([FREE_MODE_TEXT.notOn]);
  });

  it('a free-mode job after an on-the-spot enable carries the committed grant', async () => {
    const h = harness({ grant: null, enable: 'enabled' });
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 5 }, 'msg-1');
    h.service.addMessage(message('m1', 'alice', 'hello', new Date()));
    await vi.advanceTimersByTimeAsync(4_000);
    expect((h.store.enqueueJob.mock.calls[0]![0] as { roomGrant: unknown }).roomGrant).toEqual(GRANT);
  });

  it('announces expiry once and stops collecting messages', async () => {
    const h = harness();
    await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent).toEqual(['AGENT自動回覆1分鐘', '自由模式已結束']);
    expect(h.service.isActive(KEY)).toBe(false);
    h.service.addMessage(message('m1', 'alice', 'hello'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.store.enqueueJob).not.toHaveBeenCalled();
  });

  it('ignores messages while off', async () => {
    const h = harness();
    h.service.addMessage(message('m1', 'alice', 'hello'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.store.enqueueJob).not.toHaveBeenCalled();
  });

  describe('batching and judging', () => {
    async function on(h: ReturnType<typeof harness>) {
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 60 });
    }
    const jobPrompt = (h: ReturnType<typeof harness>, index: number) =>
      (h.store.enqueueJob.mock.calls[index]![0] as { prompt: string }).prompt;

    it('judges after 3 s of quiet, then creates one job with [名稱] lines and Taipei times (no NO_REPLY instruction)', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'alice', '大家早', new Date('2026-10-28T06:00:05Z')));
      await vi.advanceTimersByTimeAsync(2_000);
      h.service.addMessage(message('m2', 'bob', '早安', new Date('2026-10-28T06:00:20Z')));
      await vi.advanceTimersByTimeAsync(2_900);
      expect(h.judge).not.toHaveBeenCalled(); // the quiet timer restarted at m2
      await vi.advanceTimersByTimeAsync(100);
      expect(h.judge).toHaveBeenCalledTimes(1);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      const job = h.store.enqueueJob.mock.calls[0]![0] as { prompt: string; sourceMessageId: string; provider: string; roomGrant: unknown };
      expect(job.sourceMessageId).toBe('m2');
      expect(job.provider).toBe('claude');
      expect(job.roomGrant).toEqual(GRANT);
      expect(job.prompt).toContain('[Alice] 14:00 大家早');
      expect(job.prompt).toContain('[Bob] 14:00 早安');
      expect(job.prompt).not.toContain('[[NO_REPLY]]');
      expect(job.prompt).toContain('判斷已決定需要回覆');
      expect(h.kick).toHaveBeenCalledWith(expect.objectContaining(KEY));
      expect(h.events[0]).toMatchObject({ type: 'judge', verdict: { reply: true, urgency: 50 } });
    });

    it('judges at 15 s from the first message even when the chat never goes quiet', async () => {
      const h = harness(); await on(h);
      for (let i = 0; i < 8; i++) {
        h.service.addMessage(message(`m${i}`, 'alice', `line ${i}`));
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(h.judge).toHaveBeenCalledTimes(1); // at t=15 s; the quiet window of 3 s never elapsed
      expect(h.store.enqueueJob.mock.calls[0]![0]).toMatchObject({ sourceMessageId: 'm7' });
      expect(h.judgeInputs[0]!.prompt).toContain('line 7');
    });

    it('carries messages the judge skipped into the next judge turn and reply', async () => {
      const h = harness(); await on(h);
      h.verdicts.push({ reply: false, urgency: 10, reason: 'chatter' }, { reply: true, urgency: 60, reason: 'question' });
      h.service.addMessage(message('m1', 'alice', 'lol'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
      h.service.addMessage(message('m2', 'bob', 'Agent 幫我查一下'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs[1]!.prompt).toMatch(/先前判斷不回覆的訊息\]\n\[Alice\] \d\d:\d\d lol/);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      expect(jobPrompt(h, 0)).toContain('lol');
      expect(jobPrompt(h, 0)).toContain('幫我查一下');
    });

    it.each([
      ['a failing judge', new Error('boom')],
      ['a non-JSON answer', 'sure, reply!'],
      ['an answer without a boolean reply', '{"reply":"yes","urgency":90}'],
    ] as const)('never replies after %s, and records the failure', async (_name, scripted) => {
      const h = harness(); await on(h);
      h.verdicts.push(scripted);
      h.service.addMessage(message('m1', 'alice', '@大家 有人在嗎'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
      expect(h.events.map((event) => event.type)).toEqual(['judge_failed']);
    });

    it('treats a judge that does not answer within 20 s as "do not reply"', async () => {
      const h = harness(); await on(h);
      h.judge.mockImplementationOnce(() => new Promise(() => undefined));
      h.service.addMessage(message('m1', 'alice', 'hi'));
      await vi.advanceTimersByTimeAsync(3_000 + 19_000);
      expect(h.events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.events.map((event) => event.type)).toEqual(['judge_failed']);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
    });

    it('keeps one judge session per window: first call fresh, later calls resume, a new window starts fresh again', async () => {
      const h = harness({ fallback: { reply: false, urgency: 5 } }); await on(h);
      h.service.addMessage(message('m1', 'alice', 'one'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.service.addMessage(message('m2', 'alice', 'two'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs[0]!.resumeSessionId).toBeUndefined();
      expect(h.judgeInputs[1]!.resumeSessionId).toBe('judge-session-1');
      expect(h.judgeInputs[1]!.systemPrompt).toContain('urgency');
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
      await on(h);
      h.service.addMessage(message('m3', 'alice', 'three'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs[2]!.resumeSessionId).toBeUndefined();
    });

    it('puts the liveliness and persona in the judge system prompt and starts a fresh session when they change', async () => {
      const h = harness({ fallback: { reply: false, urgency: 5 } }); await on(h);
      h.service.addMessage(message('m1', 'alice', 'one'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.service.addMessage(message('m2', 'alice', 'two'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.personaNow.value = { description: '愛開玩笑', liveliness: 'lively' };
      h.service.addMessage(message('m3', 'alice', 'three'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.service.addMessage(message('m4', 'alice', 'four'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs[0]!.systemPrompt).toBe(FREE_MODE_JUDGE_SYSTEM_PROMPT);
      expect(h.judgeInputs[1]!.resumeSessionId).toBe('judge-session-1');
      expect(h.judgeInputs[2]!.systemPrompt).toContain('回覆積極度：活潑');
      expect(h.judgeInputs[2]!.systemPrompt).toContain('愛開玩笑');
      expect(h.judgeInputs[2]!.resumeSessionId).toBeUndefined();
      expect(h.judgeInputs[3]!.resumeSessionId).toBe('judge-session-1');
    });

    it('drops the judge session after a failure instead of resuming a broken one', async () => {
      const h = harness({ fallback: { reply: false, urgency: 5 } }); await on(h);
      h.service.addMessage(message('m1', 'alice', 'one'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.verdicts.push('garbage');
      h.service.addMessage(message('m2', 'alice', 'two'));
      await vi.advanceTimersByTimeAsync(3_000);
      h.service.addMessage(message('m3', 'alice', 'three'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs.map((input) => input.resumeSessionId)).toEqual([undefined, 'judge-session-1', undefined]);
    });

    describe('provider and failure notice', () => {
      it('runs the reply job and the judge on Claude when a Codex chat cannot give the member principal local tools', async () => {
        const h = harness({ provider: 'codex', canUseCodex: false }); await on(h);
        h.service.addMessage(message('m1', 'alice', 'hi'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.judgeInputs[0]!.provider).toBe('claude');
        expect(h.store.enqueueJob.mock.calls[0]![0]).toMatchObject({ provider: 'claude' });
      });
      it('keeps Codex when the member principal can run it', async () => {
        const h = harness({ provider: 'codex', canUseCodex: true }); await on(h);
        h.service.addMessage(message('m1', 'alice', 'hi'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.judgeInputs[0]!.provider).toBe('codex');
        expect(h.store.enqueueJob.mock.calls[0]![0]).toMatchObject({ provider: 'codex' });
      });
      it('sends one failure notice per window with the trimmed reason', async () => {
        const h = harness(); await on(h);
        h.service.addMessage(message('m1', 'alice', 'hi'));
        await vi.advanceTimersByTimeAsync(3_000);
        h.service.noteJobFailed('job-1', '  Codex 無法限制本機工具\n請改用 Claude  ');
        h.service.noteJobFailed('job-1', 'again');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.sent).toEqual(['AGENT自動回覆60分鐘', '自由模式回覆失敗：Codex 無法限制本機工具 請改用 Claude']);
        // a new window may notify again
        h.activeJobs.delete('job-1');
        await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
        await on(h);
        h.service.addMessage(message('m2', 'alice', 'hi again'));
        await vi.advanceTimersByTimeAsync(3_000);
        h.service.noteJobFailed('job-2', 'x'.repeat(200));
        await vi.advanceTimersByTimeAsync(10);
        expect(h.sent.at(-1)).toBe(`自由模式回覆失敗：${'x'.repeat(80)}`);
      });
      it('does not notify for a job it interrupted itself, or for an unknown job', async () => {
        const h = harness(); await on(h);
        h.service.addMessage(message('m1', 'alice', 'first'));
        await vi.advanceTimersByTimeAsync(3_000);
        h.verdicts.push({ reply: true, urgency: 95 });
        h.service.addMessage(message('m2', 'bob', 'urgent'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.cancelled).toEqual(['job-1']);
        h.service.noteJobFailed('job-1', 'cancelled by interrupt');
        h.service.noteJobFailed('other-job', 'nope');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.sent).toEqual(['AGENT自動回覆60分鐘']);
        h.service.noteJobFailed('job-2', 'real failure');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.sent.at(-1)).toBe('自由模式回覆失敗：real failure');
      });
    });

    describe('while a reply is running', () => {
      async function running(h: ReturnType<typeof harness>) {
        await on(h);
        h.service.addMessage(message('m1', 'alice', 'first question'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      }
      const next = async (h: ReturnType<typeof harness>, id: string, text: string) => {
        h.service.addMessage(message(id, 'bob', text));
        await vi.advanceTimersByTimeAsync(3_000);
      };

      it('shows the judge the running reply and its trigger messages', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: false, urgency: 5 });
        await next(h, 'm2', 'side chat');
        expect(h.judgeInputs[1]!.prompt).toContain('Agent 正在回覆');
        expect(h.judgeInputs[1]!.prompt).toContain('first question');
      });

      it('interrupts on reply with urgency >= 70 and replies once to both batches, saying it was interrupted', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: true, urgency: 90 });
        await next(h, 'm2', '等一下，改成明天');
        expect(h.interruptJob).toHaveBeenCalledWith(expect.objectContaining(KEY), 'job-1');
        expect(h.cancelled).toEqual(['job-1']);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(2);
        const prompt = jobPrompt(h, 1);
        expect(prompt).toContain('first question');
        expect(prompt).toContain('改成明天');
        expect(prompt).toContain('已被新訊息打斷');
        expect(h.events.map((event) => event.type)).toEqual(['judge', 'judge', 'interrupt']);
      });

      it('stops interrupting after 2 interruptions in a round and replies after completion instead', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: true, urgency: 95 }, { reply: true, urgency: 95 }, { reply: true, urgency: 95 });
        await next(h, 'm2', 'second');
        await next(h, 'm3', 'third');
        expect(h.cancelled).toEqual(['job-1', 'job-2']);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(3);
        await next(h, 'm4', 'fourth');
        expect(h.cancelled).toEqual(['job-1', 'job-2']); // no third interruption
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(3);
        expect(h.events.at(-1)).toMatchObject({ type: 'interrupt_refused', reason: 'limit' });
        h.activeJobs.delete('job-3');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(4);
        expect(jobPrompt(h, 3)).toContain('fourth');
        expect(jobPrompt(h, 3)).not.toContain('已被新訊息打斷');
      });

      it('resets the interruption count when the round completes', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: true, urgency: 95 }, { reply: true, urgency: 95 });
        await next(h, 'm2', 'second');
        await next(h, 'm3', 'third');
        h.activeJobs.delete('job-3');
        await vi.advanceTimersByTimeAsync(2_000); // round over
        h.service.addMessage(message('m4', 'alice', 'new round'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(4);
        h.verdicts.push({ reply: true, urgency: 95 });
        await next(h, 'm5', 'urgent again');
        expect(h.cancelled).toEqual(['job-1', 'job-2', 'job-4']);
      });

      it('waits for the running reply when urgency < 70, then replies to the new messages', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: true, urgency: 69 });
        await next(h, 'm2', 'also this');
        expect(h.interruptJob).not.toHaveBeenCalled();
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(1); // job-1 is still running
        h.activeJobs.delete('job-1');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(2);
        expect(jobPrompt(h, 1)).toContain('also this');
        expect(jobPrompt(h, 1)).not.toContain('first question');
        expect(h.events).toContainEqual(expect.objectContaining({ type: 'interrupt_refused', reason: 'urgency' }));
      });

      it('does not interrupt on reply:false, and keeps the messages for later', async () => {
        const h = harness(); await running(h);
        h.verdicts.push({ reply: false, urgency: 99 });
        await next(h, 'm2', 'banter');
        expect(h.interruptJob).not.toHaveBeenCalled();
        h.activeJobs.delete('job-1');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
        h.service.addMessage(message('m3', 'alice', 'Agent？'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(2);
        expect(jobPrompt(h, 1)).toContain('banter');
      });

      it('falls back to replying after completion when the job can no longer be cancelled', async () => {
        const h = harness(); await running(h);
        h.interruptJob.mockResolvedValueOnce(false);
        h.verdicts.push({ reply: true, urgency: 95 });
        await next(h, 'm2', 'urgent');
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
        h.activeJobs.delete('job-1');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.store.enqueueJob).toHaveBeenCalledTimes(2);
        expect(jobPrompt(h, 1)).toContain('urgent');
      });
    });

    it('drops an administrator message that took the normal path from the pending batch', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'admin', '@Agent do it'));
      h.service.addMessage(message('m2', 'alice', 'chat'));
      h.service.discardMessage(KEY, 'm1');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.judgeInputs[0]!.prompt).not.toContain('do it');
      expect(jobPrompt(h, 0)).not.toContain('do it');
      expect(jobPrompt(h, 0)).toContain('chat');
    });

    it('creates no job when the room grant is gone at reply time', async () => {
      const h = harness({ grant: null });
      h.rows.set('g1', { ...KEY, enabledBy: 'admin', expiresAt: new Date(START.getTime() + 3_600_000) });
      await h.service.start();
      h.service.addMessage(message('m1', 'alice', 'hi'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
    });

    it('does not carry pending messages past an off command, and ignores a judge answer that arrives after it', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'alice', 'hi'));
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.judge).not.toHaveBeenCalled();
      await on(h);
      let release!: () => void;
      h.judge.mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve({ text: '{"reply":true,"urgency":99,"reason":"x"}', sessionId: 's' });
      }));
      h.service.addMessage(message('m2', 'alice', 'late'));
      await vi.advanceTimersByTimeAsync(3_000);
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('startup', () => {
    it('clears an expired row silently when it expired 2 minutes ago or more', async () => {
      const h = harness({ rows: [{ ...KEY, enabledBy: 'a', expiresAt: new Date(START.getTime() - 3 * 60_000) }] });
      await h.service.start();
      expect(h.rows.size).toBe(0);
      expect(h.sent).toEqual([]);
    });
    it('clears with the ended notice when it expired less than 2 minutes ago', async () => {
      const h = harness({ rows: [{ ...KEY, enabledBy: 'a', expiresAt: new Date(START.getTime() - 60_000) }] });
      await h.service.start();
      expect(h.rows.size).toBe(0);
      expect(h.sent).toEqual(['自由模式已結束']);
    });
    it('restores an unexpired row with its expiry timer', async () => {
      const h = harness({ rows: [{ ...KEY, enabledBy: 'a', expiresAt: new Date(START.getTime() + 2 * 60_000) }] });
      await h.service.start();
      expect(h.service.isActive(KEY)).toBe(true);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(h.sent).toEqual(['自由模式已結束']);
    });
  });
});

describe('composeFreeModePrompt', () => {
  it('uses [名稱] lines, falls back to a member tag, and formats Asia/Taipei time', () => {
    const prompt = composeFreeModePrompt([
      { senderId: 'u1', senderName: '小明', text: 'a', occurredAt: new Date('2026-10-28T16:30:00Z') },
      { senderId: 'uabcd1234', senderName: null, text: 'b', occurredAt: new Date('2026-10-28T16:31:00Z') },
    ]);
    expect(prompt).toContain('[小明] 00:30 a');
    expect(prompt).toContain('[成員 1234] 00:31 b');
    expect(formatTaipeiTime(new Date('2026-10-28T06:05:00Z'))).toBe('14:05');
  });
});

describe('judge prompt and verdict parsing', () => {
  it('lists the running reply, the skipped messages and the new batch', () => {
    const at = new Date('2026-10-28T06:00:00Z');
    const prompt = composeFreeModeJudgePrompt({
      inflight: [{ senderId: 'u1', senderName: 'A', text: 'running', occurredAt: at }], skipped: [],
      batch: [{ senderId: 'u2', senderName: 'B', text: 'new', occurredAt: at }] });
    expect(prompt).toContain('Agent 正在回覆');
    expect(prompt).toContain('[A] 14:00 running');
    expect(prompt).toContain('（無）');
    expect(prompt).toContain('[B] 14:00 new');
  });
  it('accepts strict JSON (also inside a code fence) and clamps urgency', () => {
    expect(parseFreeModeVerdict('{"reply":true,"urgency":80,"reason":"q"}')).toEqual({ reply: true, urgency: 80, reason: 'q' });
    expect(parseFreeModeVerdict('```json\n{"reply":false,"urgency":250.4,"reason":""}\n```')).toMatchObject({ reply: false, urgency: 100 });
    expect(parseFreeModeVerdict('{"reply":true}')).toMatchObject({ urgency: 0 });
    expect(parseFreeModeVerdict('nope')).toBeNull();
    expect(parseFreeModeVerdict('{"reply":1}')).toBeNull();
  });
});
