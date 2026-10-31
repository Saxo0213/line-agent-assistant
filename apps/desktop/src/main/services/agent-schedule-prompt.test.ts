import { describe, expect, it } from 'vitest';
import type { AgentScheduleTarget } from '@line-agent/contracts';
import { composeScheduleRunContext, composeScheduledPrompt, computeScheduleWindow, formatTaipei, formatTaipeiRange } from './agent-schedule-prompt.js';

const d = (iso: string) => new Date(iso);
const group: AgentScheduleTarget = { accountId: 'acc-1', chatType: 'group', chatId: 'c0123', title: '專案群' };
const direct: AgentScheduleTarget = { accountId: 'acc-1', chatType: 'direct', chatId: 'u9999', title: 'Alice' };
const window = { from: d('2026-10-01T01:00:00.000Z'), to: d('2026-10-02T01:00:00.000Z') };

describe('computeScheduleWindow', () => {
  const daily = { kind: 'daily', time: '09:00' } as const;
  const scheduledFor = d('2026-10-10T01:00:00.000Z');

  it('since_last_run starts at the last submitted run', () => {
    const result = computeScheduleWindow({ window: { mode: 'since_last_run' }, recurrence: daily, scheduledFor, previousSubmittedFor: d('2026-10-09T01:00:00.000Z') });
    expect(result).toEqual({ from: d('2026-10-09T01:00:00.000Z'), to: scheduledFor });
  });

  it('since_last_run without a prior run uses a recurrence-derived lookback', () => {
    const run = (recurrence: Parameters<typeof computeScheduleWindow>[0]['recurrence']) =>
      (scheduledFor.getTime() - computeScheduleWindow({ window: { mode: 'since_last_run' }, recurrence, scheduledFor, previousSubmittedFor: null }).from.getTime()) / 60_000;
    expect(run({ kind: 'interval', everyMinutes: 30, anchorAt: '2026-10-01T00:00:00.000Z' })).toBe(30);
    expect(run(daily)).toBe(1440);
    expect(run({ kind: 'weekly', days: [1], time: '09:00' })).toBe(10_080);
    expect(run({ kind: 'once', at: '2026-10-10T01:00:00.000Z' })).toBe(1440);
    expect(run({ kind: 'cron', expression: '0 * * * *' })).toBe(1440);
  });

  it('lookback ignores earlier runs, and every window is capped to 7 days', () => {
    expect(computeScheduleWindow({ window: { mode: 'lookback', minutes: 90 }, recurrence: daily, scheduledFor, previousSubmittedFor: d('2026-10-09T01:00:00.000Z') }).from)
      .toEqual(d('2026-10-09T23:30:00.000Z'));
    const capped = computeScheduleWindow({ window: { mode: 'since_last_run' }, recurrence: daily, scheduledFor, previousSubmittedFor: d('2026-09-01T00:00:00.000Z') });
    expect(capped.from).toEqual(d('2026-10-03T01:00:00.000Z'));
    expect(computeScheduleWindow({ window: { mode: 'lookback', minutes: 10_080 }, recurrence: daily, scheduledFor, previousSubmittedFor: null }).from)
      .toEqual(d('2026-10-03T01:00:00.000Z'));
  });
});

const community: AgentScheduleTarget = { accountId: 'acc-2', chatType: 'community', chatId: 'cm-open', title: 'AI & Vibe 社群' };
const range = { from: d('2026-10-27T17:15:00.000Z'), to: d('2026-10-27T23:15:00.000Z') };

describe('visible schedule card', () => {
  it('formats Taipei time and ranges', () => {
    expect(formatTaipei(d('2026-10-01T01:00:00Z'))).toBe('2026-10-01 09:00');
    expect(formatTaipeiRange(range)).toBe('10/28 01:15–07:15');
    expect(formatTaipeiRange(window)).toBe('10/1 09:00–10/2 09:00');
  });

  it('is a short card without keys, ids or rules', () => {
    const card = composeScheduledPrompt({ title: 'AI & Vibe 社群摘要', prompt: '', task: { type: 'summary' }, targets: [community], delivery: { mode: 'primary_admin' }, window: range });
    expect(card).toMatchInlineSnapshot(`
      "[排程] AI & Vibe 社群摘要
      任務：總結
      來源：AI & Vibe 社群（社群）
      範圍：10/28 01:15–07:15
      輸出：傳給管理員"
    `);
    expect(card.split('\n').length).toBeLessThanOrEqual(6);
    expect(card).not.toMatch(/accountId|chatId|chatType|from=|T\d\d:\d\d:\d\dZ/);
  });

  it('shows two sources then a count, the extra prompt in one truncated line, and the custom task', () => {
    const many = composeScheduledPrompt({ title: '多個', prompt: `第一行\n第二行${'字'.repeat(200)}`, task: { type: 'keyword_digest', keywords: ['請款', 'Invoice'] },
      targets: [group, direct, community], delivery: { mode: 'line_target', target: { accountId: 'acc-1', chatType: 'direct', chatId: 'uadmin', title: '管理者' } }, window });
    expect(many).toMatchInlineSnapshot(`
      "[排程] 多個
      任務：關鍵字彙整（請款、Invoice）
      來源：專案群（群組）、Alice（私訊） 等 3 個
      範圍：10/1 09:00–10/2 09:00
      輸出：傳給 管理者
      補充：第一行 第二行字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字字…"
    `);
    expect(many.split('\n').length).toBeLessThanOrEqual(6);
    const custom = composeScheduledPrompt({ title: '早報', prompt: '整理昨天的訊息', task: { type: 'custom' }, targets: [], delivery: { mode: 'record_only' }, window });
    expect(custom).toMatchInlineSnapshot(`
      "[排程] 早報
      任務：自訂
      輸出：只存排程紀錄
      指示：整理昨天的訊息"
    `);
  });
});

describe('hidden schedule run context', () => {
  it('states the paging rule and keeps the no-retry rule for sending only', () => {
    const input = { title: '社群', prompt: '', task: { type: 'summary' as const }, targets: [community], delivery: { mode: 'primary_admin' as const }, window: range };
    const context = composeScheduleRunContext({ ...input, adminChat: { accountId: 'acc-1', chatId: 'uadmin', title: '徐佳誠' } });
    expect(context).toContain('每頁最多 200 則');
    expect(context).toContain('hasMore');
    expect(context).toContain('cursor=nextCursor');
    expect(context).toContain('不要自行指定超過 200 的 limit');
    expect(context).toContain('分頁不算錯誤');
    expect(context).not.toMatch(/500/);
  });

  it('summary of a community, delivered to the administrator', () => {
    const input = { title: '社群', prompt: '', task: { type: 'summary' as const }, targets: [community], delivery: { mode: 'primary_admin' as const }, window: range };
    const context = composeScheduleRunContext({ ...input, adminChat: { accountId: 'acc-1', chatId: 'uadmin', title: '徐佳誠' } });
    expect(context).toMatchInlineSnapshot(`
      "【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。
      時間：10/28 01:15–07:15（台灣時間）；查詢用 UTC from=2026-10-27T17:15:00.000Z to=2026-10-27T23:15:00.000Z
      分頁規則：訊息查詢工具每頁最多 200 則，結果含 hasMore 與 nextCursor；hasMore 為 true 時，用相同條件加上 cursor=nextCursor 再查下一頁，直到 hasMore 為 false，逐頁整理後再合併。不要自行指定超過 200 的 limit，也不要因為單頁筆數上限而放棄或重試；只有最後一頁（hasMore=false）仍無訊息，才能寫該時段無訊息。
      來源（用 query_target_messages_by_time 逐一查到 hasMore=false，只查上述時間）：
      • AI & Vibe 社群（accountId=acc-2，chatType=community，chatId=cm-open）
      任務：總結。每個來源一個區塊（純文字）：
      【<聊天室名稱>】<M/D HH:mm–HH:mm> · <N> 則
      重點：• …（最多 5 點）
      決議／待辦：• [名稱]－事項－期限（沒有就省略）
      未解問題：• …（沒有就省略）
      每區塊最多 15 行；沒有訊息時只寫一行「<名稱>：此時段無訊息」。
      人名規則：結果中每個人的顯示名稱一律寫成 [名稱]（半形方括號），例如「• 01:31 [紅點點] 分享因搬出國與規則限制而停卡」；不明發言者寫 [未知]；非人名的詞不加括號；聊天室標題維持【】，人名不用【】。
      輸出：用 send_to_target 傳給管理員（accountId=acc-1，chatType=direct，chatId=uadmin）。只傳結果本身（純文字、不要 Markdown、不加說明）；你的回覆貼同一份文字。傳送失敗或結果不明時不要重試，在回覆說明原因（此規則只適用於傳送與真正的錯誤，分頁不算錯誤，必須繼續查下一頁）。"
    `);
    expect(context.length).toBeLessThanOrEqual(1200);
    expect(composeScheduleRunContext({ ...input, adminChat: null })).toContain('找不到主要管理者聊天室');
  });

  it('keyword digest and the full extra prompt', () => {
    const context = composeScheduleRunContext({ title: 'k', prompt: '只看昨天的', task: { type: 'keyword_digest', keywords: ['請款'] }, targets: [group], delivery: { mode: 'record_only' }, window });
    expect(context).toMatchInlineSnapshot(`
      "【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。
      時間：10/1 09:00–10/2 09:00（台灣時間）；查詢用 UTC from=2026-10-01T01:00:00.000Z to=2026-10-02T01:00:00.000Z
      分頁規則：訊息查詢工具每頁最多 200 則，結果含 hasMore 與 nextCursor；hasMore 為 true 時，用相同條件加上 cursor=nextCursor 再查下一頁，直到 hasMore 為 false，逐頁整理後再合併。不要自行指定超過 200 的 limit，也不要因為單頁筆數上限而放棄或重試；只有最後一頁（hasMore=false）仍無訊息，才能寫該時段無訊息。
      來源（用 query_target_messages_by_time 逐一查到 hasMore=false，只查上述時間）：
      • 專案群（accountId=acc-1，chatType=group，chatId=c0123）
      任務：關鍵字彙整（不分大小寫）：「請款」。每個來源一個區塊，標題「【<名稱>】」，其下每則一行「• HH:mm [發言者]：內容」（台灣時間），最多 20 則，超過寫「另有 N 則」；沒有符合時寫「<名稱>：此時段無符合訊息」。純文字。
      人名規則：結果中每個人的顯示名稱一律寫成 [名稱]（半形方括號），例如「• 01:31 [紅點點] 分享因搬出國與規則限制而停卡」；不明發言者寫 [未知]；非人名的詞不加括號；聊天室標題維持【】，人名不用【】。
      輸出：結果直接作為回覆，只保存在排程紀錄，不傳送到任何聊天室。
      補充：只看昨天的"
    `);
  });

  it('custom task without targets states no fixed chats and names the read tools', () => {
    const context = composeScheduleRunContext({ title: 'c', prompt: '整理昨天的訊息', task: { type: 'custom' }, targets: [], delivery: { mode: 'record_only' }, window });
    expect(context.split(String.fromCharCode(10))).toEqual([
      '【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。',
      expect.stringMatching(/^時間：.*（台灣時間）；查詢用 UTC from=.* to=/),
      expect.stringContaining('來源：未固定聊天室'),
      expect.stringContaining('分頁規則'),
      '輸出：結果直接作為回覆，只保存在排程紀錄，不傳送到任何聊天室。',
      '指示：整理昨天的訊息',
    ]);
    expect(context).toContain('來源：未固定聊天室');
    expect(context).toContain('只呼叫一次 query_target_messages_by_time，帶 from 與 to，不帶 target');
    expect(context).toContain('每則訊息都有 chatId 與 conversationTitle');
    expect(context).toContain('不要逐一聊天室查詢');
    expect(context).not.toContain('list_targets');
    expect(context).toContain('時間：');
  });
});
