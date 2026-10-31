import {
  AGENT_SCHEDULE_PROMPT_PREFIX,
  AGENT_SCHEDULE_WINDOW_CAP_MS,
  type AgentScheduleDelivery,
  type AgentScheduleRecurrence,
  type AgentScheduleTarget,
  type AgentScheduleTask,
  type AgentScheduleWindow,
} from '@line-agent/contracts';

export interface ScheduleTimeWindow { from: Date; to: Date }

/** Lookback used by since_last_run when the schedule has no earlier submitted run. */
export function defaultLookbackMinutes(recurrence: AgentScheduleRecurrence): number {
  if (recurrence.kind === 'interval') return recurrence.everyMinutes;
  if (recurrence.kind === 'weekly') return 10_080;
  return 1_440;
}

/**
 * The message window of one scheduled run, ending at the slot time. since_last_run starts at the slot of the last submitted
 * run (or a recurrence-derived default); every window is capped to 7 days.
 */
export function computeScheduleWindow(input: {
  window: AgentScheduleWindow;
  recurrence: AgentScheduleRecurrence;
  scheduledFor: Date;
  previousSubmittedFor: Date | null;
}): ScheduleTimeWindow {
  const to = input.scheduledFor;
  let from: Date;
  if (input.window.mode === 'lookback') from = new Date(to.getTime() - input.window.minutes * 60_000);
  else if (input.previousSubmittedFor && input.previousSubmittedFor.getTime() < to.getTime()) from = input.previousSubmittedFor;
  else from = new Date(to.getTime() - defaultLookbackMinutes(input.recurrence) * 60_000);
  const earliest = new Date(to.getTime() - AGENT_SCHEDULE_WINDOW_CAP_MS);
  return { from: from.getTime() < earliest.getTime() ? earliest : from, to };
}

const taipei = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
/** `YYYY-MM-DD HH:mm` in Asia/Taipei. */
export function formatTaipei(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of taipei.formatToParts(date)) if (part.type !== 'literal') parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export interface ScheduledPromptInput {
  title: string;
  prompt: string;
  task: AgentScheduleTask;
  targets: readonly AgentScheduleTarget[];
  delivery: AgentScheduleDelivery;
  window: ScheduleTimeWindow;
  /** The Primary Admin's direct chat with the Agent account at run time (primary_admin delivery); null when there is none. */
  adminChat?: { accountId: string; chatId: string; title?: string } | null;
  /** new_messages only: the chats whose rule says llm. They are the only chats the Agent reads; the other chats are listed by Main. */
  llmChats?: readonly AgentScheduleTarget[];
}

const targetLabel = (target: AgentScheduleTarget): string => target.title.trim() || target.chatId;
const CHAT_TYPE_LABELS: Record<AgentScheduleTarget['chatType'], string> = { direct: '私訊', group: '群組', room: '聊天室', community: '社群', thread: '討論串' };
const VISIBLE_EXTRA_MAX = 120;

/** `M/D HH:mm–HH:mm` (or `M/D HH:mm–M/D HH:mm` across days) in Asia/Taipei. */
export function formatTaipeiRange(window: ScheduleTimeWindow): string {
  const part = (date: Date) => {
const [day = '', time = ''] = formatTaipei(date).split(' ');
const [, month = '', dom = ''] = day.split('-');
return { md: `${Number(month)}/${Number(dom)}`, time };
  };
  const from = part(window.from);
  const to = part(window.to);
  return from.md === to.md ? `${from.md} ${from.time}–${to.time}` : `${from.md} ${from.time}–${to.md} ${to.time}`;
}

function sourceSummary(targets: readonly AgentScheduleTarget[]): string {
  const shown = targets.slice(0, 2).map((target) => `${targetLabel(target)}（${CHAT_TYPE_LABELS[target.chatType]}）`).join('、');
  return targets.length > 2 ? `${shown} 等 ${targets.length} 個` : shown;
}

function deliveryLabel(input: Pick<ScheduledPromptInput, 'delivery'>): string {
  if (input.delivery.mode === 'primary_admin') return '傳給管理員';
  if (input.delivery.mode === 'line_target') return `傳給 ${targetLabel(input.delivery.target)}`;
  return '只存排程紀錄';
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * The visible job prompt of one scheduled run: a short card (at most six lines; no keys, ids, ISO times or rules). The machine
 * instructions live in composeScheduleRunContext and are injected only while the job runs.
 */
export function composeScheduledPrompt(input: ScheduledPromptInput): string {
  const reads = input.task.type !== 'custom' || input.targets.length > 0;
  const lines: string[] = [`${AGENT_SCHEDULE_PROMPT_PREFIX}${input.title}`];
  lines.push(`任務：${input.task.type === 'summary' ? '總結' : input.task.type === 'keyword_digest' ? `關鍵字彙整（${input.task.keywords.join('、')}）` : input.task.type === 'new_messages' ? '新訊息整理' : '自訂'}`);
  const sources = input.task.type === 'new_messages' ? input.llmChats ?? [] : input.targets;
  if (sources.length > 0) lines.push(`來源：${sourceSummary(sources)}`);
  if (reads) lines.push(`範圍：${formatTaipeiRange(input.window)}`);
  lines.push(`輸出：${deliveryLabel(input)}`);
  if (input.prompt.trim()) lines.push(`${input.task.type === 'custom' ? '指示' : '補充'}：${oneLine(input.prompt, VISIBLE_EXTRA_MAX)}`);
  return lines.join('\n');
}

const PAGING_RULE = '分頁規則：訊息查詢工具每頁最多 200 則，結果含 hasMore 與 nextCursor；hasMore 為 true 時，用相同條件加上 cursor=nextCursor 再查下一頁，直到 hasMore 為 false，逐頁整理後再合併。不要自行指定超過 200 的 limit，也不要因為單頁筆數上限而放棄或重試；只有最後一頁（hasMore=false）仍無訊息，才能寫該時段無訊息。';
const NAME_RULE = '人名規則：結果中每個人的顯示名稱一律寫成 [名稱]（半形方括號），例如「• 01:31 [紅點點] 分享因搬出國與規則限制而停卡」；不明發言者寫 [未知]；非人名的詞不加括號；聊天室標題維持【】，人名不用【】。';
const SUMMARY_FORMAT = '每個來源一個區塊（純文字）：\n【<聊天室名稱>】<M/D HH:mm–HH:mm> · <N> 則\n重點：• …（最多 5 點）\n決議／待辦：• [名稱]－事項－期限（沒有就省略）\n未解問題：• …（沒有就省略）\n每區塊最多 15 行；沒有訊息時只寫一行「<名稱>：此時段無訊息」。';

/** The hidden run-time instructions of one scheduled run (injected by Main when the job starts; never stored in the job prompt). */
export function composeScheduleRunContext(input: ScheduledPromptInput): string {
  const lines: string[] = ['【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。'];
  const newMessages = input.task.type === 'new_messages';
  const reads = !newMessages && (input.task.type !== 'custom' || input.targets.length > 0);
  if (newMessages) {
lines.push(`時間：${formatTaipeiRange(input.window)}（台灣時間）；查詢用 UTC from=${input.window.from.toISOString()} to=${input.window.to.toISOString()}`);
lines.push(PAGING_RULE);
const chats = input.llmChats ?? [];
lines.push(chats.length > 0
  ? '來源（只處理下列聊天室；其他聊天室已由系統依規則列出，不要重複。每個聊天室用 query_target_messages_by_time 帶 accountId、chatType、chatId，查到 hasMore=false 為止，只查上述時間）：'
  : '來源：沒有需要處理的聊天室；不要查詢任何聊天室，回覆一行「此時段沒有需要整理的聊天室」。');
for (const chat of chats) lines.push(`• ${targetLabel(chat)}（accountId=${chat.accountId}，chatType=${chat.chatType}，chatId=${chat.chatId}）`);
if (input.task.type === 'new_messages' && input.task.messageFilter && chats.length > 0) {
  lines.push(`訊息過濾：只使用符合下列條件的訊息，其他訊息視為不存在。message.direction 的 inbound 是別人傳入、outbound 是自己傳出；message.kind 是訊息類型；message.textContains 比對文字且不分大小寫。條件：${JSON.stringify(input.task.messageFilter)}`);
}
lines.push(`任務：總結。${SUMMARY_FORMAT}`);
  }
  if (reads) {
lines.push(`時間：${formatTaipeiRange(input.window)}（台灣時間）；查詢用 UTC from=${input.window.from.toISOString()} to=${input.window.to.toISOString()}`);
lines.push(PAGING_RULE);
lines.push('來源（用 query_target_messages_by_time 逐一查到 hasMore=false，只查上述時間）：');
for (const target of input.targets) {
  lines.push(`• ${targetLabel(target)}（accountId=${target.accountId}，chatType=${target.chatType}，chatId=${target.chatId}）`);
}
  }
  if (input.task.type === 'custom' && !reads) {
lines.push(`時間：${formatTaipeiRange(input.window)}（台灣時間）；查詢用 UTC from=${input.window.from.toISOString()} to=${input.window.to.toISOString()}`);
lines.push('來源：未固定聊天室。依指示自行決定要讀取哪些聊天室。要讀取所有聊天室的新訊息時，只呼叫一次 query_target_messages_by_time，帶 from 與 to，不帶 target：它會回傳所有聊天室的訊息，每則訊息都有 chatId 與 conversationTitle；查到 hasMore=false 為止。不要逐一聊天室查詢；只有要讀取某個特定聊天室時，才帶 chatId 或 target。');
lines.push(PAGING_RULE);
  }
  if (input.task.type === 'summary') {
lines.push(`任務：總結。${SUMMARY_FORMAT}`);
if (input.task.focus) lines.push(`特別關注：${input.task.focus}`);
  } else if (input.task.type === 'keyword_digest') {
lines.push(`任務：關鍵字彙整（不分大小寫）：${input.task.keywords.map((keyword) => `「${keyword}」`).join('、')}。每個來源一個區塊，標題「【<名稱>】」，其下每則一行「• HH:mm [發言者]：內容」（台灣時間），最多 20 則，超過寫「另有 N 則」；沒有符合時寫「<名稱>：此時段無符合訊息」。純文字。`);
  }
  if (input.task.type !== 'custom') lines.push(NAME_RULE);
  const sendRules = '只傳結果本身（純文字、不要 Markdown、不加說明）；你的回覆貼同一份文字。傳送失敗或結果不明時不要重試，在回覆說明原因（此規則只適用於傳送與真正的錯誤，分頁不算錯誤，必須繼續查下一頁）。';
  if (input.delivery.mode === 'primary_admin') {
const admin = input.adminChat;
lines.push(admin
  ? `輸出：用 send_to_target 傳給管理員（accountId=${admin.accountId}，chatType=direct，chatId=${admin.chatId}）。${sendRules}`
  : '輸出：找不到主要管理者聊天室，不傳送；結果直接作為回覆並註明未傳送。');
  } else if (input.delivery.mode === 'line_target') {
const target = input.delivery.target;
lines.push(`輸出：用 send_to_target 傳到 ${targetLabel(target)}（accountId=${target.accountId}，chatType=${target.chatType}，chatId=${target.chatId}）。${sendRules}`);
  } else {
lines.push('輸出：結果直接作為回覆，只保存在排程紀錄，不傳送到任何聊天室。');
  }
  if (input.prompt.trim()) lines.push(`${input.task.type === 'custom' ? '指示' : '補充'}：${input.prompt.trim()}`);
  return lines.join('\n');
}
