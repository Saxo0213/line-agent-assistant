import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import type { FreeModeKey, FreeModeRow } from '@line-agent/database';
import {
  FreeModeService, composeFreeModePrompt, formatTaipeiTime, FREE_MODE_TEXT, type FreeModeStore,
} from './free-mode-service.js';

const KEY: FreeModeKey = { accountId: 'acc', chatType: 'group', chatId: 'g1' };
const START = new Date('2026-10-28T06:00:00Z'); // 14:00 Asia/Taipei
const GRANT = { grantId: 'grant-1', version: 3 };

const message = (id: string, senderId: string, text: string, at = new Date()): InboundEnvelope => ({
  eventId: `e-${id}`, accountId: 'acc', chatId: 'g1', chatType: 'group', senderId, messageId: id, kind: 'text', text,
  mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
  occurredAt: at.toISOString(), attachments: [], raw: {} });

function harness(over: { grant?: typeof GRANT | null; rows?: FreeModeRow[]; names?: Record<string, string> } = {}) {
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
  const sendSystemText = vi.fn(async (input: { text: string }) => { sent.push(input.text); return { status: 'sent' as const }; });
  const kick = vi.fn();
  const grant = over.grant === undefined ? GRANT : over.grant;
  const service = new FreeModeService({ store, roomGrant: async () => grant, sendSystemText, provider: async () => 'claude',
    workspacePath: async () => 'C:\\work', kick, now: () => new Date(Date.now()), onError: (error) => { throw error; } });
  return { service, store, rows, sent, sendSystemText, kick, activeJobs };
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

  describe('batching', () => {
    async function on(h: ReturnType<typeof harness>) {
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'on', minutes: 60 });
    }

    it('waits for 20 s of quiet, then creates one job with [名稱] lines and Taipei times', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'alice', '大家早', new Date('2026-10-28T06:00:05Z')));
      await vi.advanceTimersByTimeAsync(15_000);
      h.service.addMessage(message('m2', 'bob', '早安', new Date('2026-10-28T06:00:20Z')));
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled(); // the quiet timer restarted at m2
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      const job = h.store.enqueueJob.mock.calls[0]![0] as { prompt: string; sourceMessageId: string; provider: string; roomGrant: unknown };
      expect(job.sourceMessageId).toBe('m2');
      expect(job.provider).toBe('claude');
      expect(job.roomGrant).toEqual(GRANT);
      expect(job.prompt).toContain('[Alice] 14:00 大家早');
      expect(job.prompt).toContain('[Bob] 14:00 早安');
      expect(job.prompt).toContain('[[NO_REPLY]]');
      expect(job.prompt).toContain('自由模式');
      expect(h.kick).toHaveBeenCalledWith(expect.objectContaining(KEY));
    });

    it('flushes at 60 s from the first message even when the chat never goes quiet', async () => {
      const h = harness(); await on(h);
      for (let i = 0; i < 12; i++) {
        h.service.addMessage(message(`m${i}`, 'alice', `line ${i}`));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      expect(h.store.enqueueJob.mock.calls[0]![0]).toMatchObject({ sourceMessageId: 'm11' });
    });

    it('keeps one free-mode job in flight per chat; messages meanwhile form the next batch', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'alice', 'first'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1);
      h.service.addMessage(message('m2', 'bob', 'second'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(1); // job-1 is still running
      h.activeJobs.delete('job-1');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.store.enqueueJob).toHaveBeenCalledTimes(2);
      const second = h.store.enqueueJob.mock.calls[1]![0] as { prompt: string };
      expect(second.prompt).toContain('[Bob]');
      expect(second.prompt).not.toContain('first');
    });

    it('drops an administrator message that took the normal path from the pending batch', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'admin', '@Agent do it'));
      h.service.addMessage(message('m2', 'alice', 'chat'));
      h.service.discardMessage(KEY, 'm1');
      await vi.advanceTimersByTimeAsync(20_000);
      const job = h.store.enqueueJob.mock.calls[0]![0] as { prompt: string };
      expect(job.prompt).not.toContain('do it');
      expect(job.prompt).toContain('chat');
    });

    it('creates no job when the room grant is gone at flush time', async () => {
      const h = harness({ grant: null });
      h.rows.set('g1', { ...KEY, enabledBy: 'admin', expiresAt: new Date(START.getTime() + 3_600_000) });
      await h.service.start();
      h.service.addMessage(message('m1', 'alice', 'hi'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.store.enqueueJob).not.toHaveBeenCalled();
    });

    it('does not carry pending messages past an off command', async () => {
      const h = harness(); await on(h);
      h.service.addMessage(message('m1', 'alice', 'hi'));
      await h.service.handleCommand(KEY, 'admin', { type: 'free', action: 'off' });
      await vi.advanceTimersByTimeAsync(60_000);
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
