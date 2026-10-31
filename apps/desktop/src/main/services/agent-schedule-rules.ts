import type {
  AgentScheduleCondition,
  AgentScheduleLeaf,
  AgentScheduleNewMessagesTask,
  AgentScheduleRuleAction,
  McpMessageRecord,
} from '@line-agent/contracts';
import { AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_PER_CHAT, AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_TEXT_CHARS } from '@line-agent/contracts';
import { formatTaipei, formatTaipeiRange, type ScheduleTimeWindow } from './agent-schedule-prompt.js';

/**
 * Rules of the new_messages schedule task (docs/architecture/agent-schedules.md). Pure functions, no I/O: a rule is data and is
 * never evaluated as code or SQL. One run: drop the messages that the schedule itself sent, merge the copies of a group message that
 * several accounts store, drop the messages that fail messageFilter, group the rest by chat, compute the chat and run metrics, then the
 * first rule whose condition is true gives the action of the chat (list when none is true).
 */

/** The message fields the engine reads. */
export type ScheduleMessage = Pick<McpMessageRecord,
  'accountId' | 'chatType' | 'chatId' | 'messageId' | 'conversationTitle' | 'senderId' | 'senderName' | 'direction' | 'kind' | 'text' | 'recalled' | 'occurredAt'>;

export type NewMessagesConfig = Pick<AgentScheduleNewMessagesTask, 'messageFilter' | 'rules'>
  & Partial<Pick<AgentScheduleNewMessagesTask, 'maxMessagesPerChat' | 'maxTextChars'>>;

/** A run reads at most this many messages. */
export const NEW_MESSAGES_RUN_MESSAGE_CAP = 10_000;
/** Last line of a listed text when the read stopped at the cap. */
export const NEW_MESSAGES_INCOMPLETE_LINE = `（已達單次上限 ${NEW_MESSAGES_RUN_MESSAGE_CAP} 則，以上結果不完整）`;
/** A listed text is at most this long (the last lines that the cap adds do not count). */
export const NEW_MESSAGES_LIST_CHARS_CAP = 49_000;
export const NEW_MESSAGES_EMPTY_LINE = '此時段沒有新訊息';
const UNKNOWN_SENDER = '未知';
const TRUNCATED_MARK = '（略）';
const RECALLED_LABEL = '已收回';
const KIND_LABELS: Record<string, string> = {
  image: '圖片', video: '影片', audio: '語音', file: '檔案', sticker: '貼圖', contact: '聯絡人', location: '位置', event: '事件',
};
const DEFAULT_KIND_LABEL = '訊息';

export interface NewMessagesChatResult {
  accountId: string;
  chatType: ScheduleMessage['chatType'];
  chatId: string;
  title: string;
  messageCount: number;
  senderCount: number;
  textChars: number;
  action: AgentScheduleRuleAction;
  /** The formatted text of the chat, whatever its action. */
  text: string;
}

export interface NewMessagesEvaluation {
  /** Newest message first. */
  chats: NewMessagesChatResult[];
  /** All messages that passed messageFilter. */
  messageCount: number;
  chatCount: number;
  /** Length of the text when every chat is listed. */
  listedChars: number;
}

const timeOf = (iso: string): number => Date.parse(iso);

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function cutText(text: string, max: number): string {
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const hhmm = (iso: string): string => formatTaipei(new Date(iso)).split(' ')[1] ?? '';

function messageBody(message: ScheduleMessage, maxTextChars: number): string {
  if (message.recalled) return RECALLED_LABEL;
  const flat = (message.text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (flat.length === 0) return KIND_LABELS[message.kind] ?? DEFAULT_KIND_LABEL;
  return flat.length > maxTextChars ? `${cutText(flat, maxTextChars)}${TRUNCATED_MARK}` : flat;
}

interface ChatGroup {
  accountId: string;
  chatType: ScheduleMessage['chatType'];
  chatId: string;
  title: string;
  messages: ScheduleMessage[];
  senderCount: number;
  textChars: number;
  newest: number;
}

function formatChat(group: ChatGroup, window: ScheduleTimeWindow, maxMessages: number, maxTextChars: number): string {
  const lines = [`【${group.title}】${formatTaipeiRange(window)} · ${group.messages.length} 則`];
  for (const message of group.messages.slice(0, maxMessages)) {
    const sender = message.senderName?.trim() || UNKNOWN_SENDER;
    lines.push(`• ${hhmm(message.occurredAt)} [${sender}]：${messageBody(message, maxTextChars)}`);
  }
  if (group.messages.length > maxMessages) lines.push(`另有 ${group.messages.length - maxMessages} 則`);
  return lines.join('\n');
}

const lower = (text: string | null): string => (text ?? '').toLowerCase();
const containsAny = (text: string | null, needles: readonly string[]): boolean => {
  const haystack = lower(text);
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
};

function compareNumber(actual: number, op: string, value: number): boolean {
  switch (op) {
    case '>': return actual > value;
    case '>=': return actual >= value;
    case '<': return actual < value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    case '!=': return actual !== value;
    default: return false;
  }
}

function compareText(actual: string, op: string, value: string | readonly string[]): boolean {
  switch (op) {
    case '==': return actual === value;
    case '!=': return actual !== value;
    case 'in': return Array.isArray(value) && value.includes(actual);
    case 'not_in': return Array.isArray(value) && !value.includes(actual);
    default: return false;
  }
}

/** Evaluates a condition tree; `leaf` decides one leaf. An unknown metric is false. */
function evaluateTree(condition: AgentScheduleCondition, leaf: (leaf: AgentScheduleLeaf) => boolean): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateTree(child, leaf));
  if ('any' in condition) return condition.any.some((child) => evaluateTree(child, leaf));
  return leaf(condition);
}

/** One message against messageFilter. */
export function messagePasses(condition: AgentScheduleCondition | undefined, message: ScheduleMessage): boolean {
  if (!condition) return true;
  return evaluateTree(condition, (leaf) => {
    switch (leaf.metric) {
      case 'message.direction': return compareText(message.direction, leaf.op, leaf.value);
      case 'message.kind': return compareText(message.kind, leaf.op, leaf.value);
      case 'message.textContains': return leaf.op === 'any_of' ? containsAny(message.text, leaf.value)
        : leaf.op === 'none_of' ? !containsAny(message.text, leaf.value) : false;
      default: return false;
    }
  });
}

interface RunTotals { messageCount: number; chatCount: number; listedChars: number }

function ruleMatches(condition: AgentScheduleCondition, group: ChatGroup, run: RunTotals): boolean {
  return evaluateTree(condition, (leaf) => {
    switch (leaf.metric) {
      case 'chat.messageCount': return compareNumber(group.messages.length, leaf.op, leaf.value);
      case 'chat.senderCount': return compareNumber(group.senderCount, leaf.op, leaf.value);
      case 'chat.textChars': return compareNumber(group.textChars, leaf.op, leaf.value);
      case 'chat.keywordHits': {
        if (!('keywords' in leaf)) return false;
        return compareNumber(group.messages.filter((message) => containsAny(message.text, leaf.keywords)).length, leaf.op, leaf.value);
      }
      case 'run.messageCount': return compareNumber(run.messageCount, leaf.op, leaf.value);
      case 'run.chatCount': return compareNumber(run.chatCount, leaf.op, leaf.value);
      case 'run.listedChars': return compareNumber(run.listedChars, leaf.op, leaf.value);
      case 'chat.id': return compareText(group.chatId, leaf.op, leaf.value);
      case 'chat.type': return compareText(group.chatType, leaf.op, leaf.value);
      default: return false;
    }
  });
}

/** Separator of two chats in a listed text. */
export const NEW_MESSAGES_CHAT_SEPARATOR = '\n\n';

/** The chat that receives the list of the schedule. */
export interface ScheduleOwnDelivery { accountId: string; chatType: ScheduleMessage['chatType']; chatId: string }

/**
 * Evaluates one run. `ownDelivery` is the delivery chat: the outbound messages of this chat in this account are the lists that the
 * schedule sent, so every message with one of their ids (in all accounts and chats) is dropped before any other step. A message of a
 * group, room or community that several accounts store has the same message id in each copy: one copy stays, and the outbound copy
 * wins (a message from an account of the user is outbound). Direct chats are never merged.
 */
export function evaluateNewMessages(input: {
  task: NewMessagesConfig; messages: readonly ScheduleMessage[]; window: ScheduleTimeWindow; ownDelivery?: ScheduleOwnDelivery | null;
}): NewMessagesEvaluation {
  const maxMessages = input.task.maxMessagesPerChat ?? AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_PER_CHAT;
  const maxTextChars = input.task.maxTextChars ?? AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_TEXT_CHARS;
  const own = input.ownDelivery;
  const ownIds = new Set(own ? input.messages.filter((message) => message.direction === 'outbound' && message.accountId === own.accountId
    && message.chatType === own.chatType && message.chatId === own.chatId).map((message) => message.messageId) : []);
  const unique = new Map<string, ScheduleMessage>();
  for (const message of input.messages) {
    if (ownIds.has(message.messageId)) continue;
    const key = message.chatType === 'direct' ? JSON.stringify([message.accountId, message.chatType, message.chatId, message.messageId])
      : JSON.stringify([message.chatType, message.chatId, message.messageId]);
    const first = unique.get(key);
    if (!first || (first.direction !== 'outbound' && message.direction === 'outbound')) unique.set(key, message);
  }
  const kept = [...unique.values()].filter((message) => messagePasses(input.task.messageFilter, message));
  const sorted = kept.map((message, index) => ({ message, index }))
    .sort((a, b) => timeOf(a.message.occurredAt) - timeOf(b.message.occurredAt) || a.index - b.index).map((entry) => entry.message);
  const groups = new Map<string, ChatGroup>();
  for (const message of sorted) {
    const key = JSON.stringify(message.chatType === 'direct' ? [message.accountId, message.chatType, message.chatId] : [message.chatType, message.chatId]);
    let group = groups.get(key);
    if (!group) {
      group = { accountId: message.accountId, chatType: message.chatType, chatId: message.chatId, title: message.conversationTitle?.trim() || message.chatId,
        messages: [], senderCount: 0, textChars: 0, newest: 0 };
      groups.set(key, group);
    }
    group.messages.push(message);
    if (message.conversationTitle?.trim()) group.title = message.conversationTitle.trim();
    group.textChars += (message.text ?? '').length;
    group.newest = Math.max(group.newest, timeOf(message.occurredAt));
  }
  const ordered = [...groups.values()].sort((a, b) => b.newest - a.newest || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  for (const group of ordered) group.senderCount = new Set(group.messages.map((message) => message.senderId)).size;
  const texts = ordered.map((group) => formatChat(group, input.window, maxMessages, maxTextChars));
  const run: RunTotals = { messageCount: sorted.length, chatCount: ordered.length, listedChars: texts.join(NEW_MESSAGES_CHAT_SEPARATOR).length };
  const rules = input.task.rules ?? [];
  const chats = ordered.map((group, index): NewMessagesChatResult => {
    const action = rules.find((rule) => ruleMatches(rule.when, group, run))?.then ?? 'list';
    return { accountId: group.accountId, chatType: group.chatType, chatId: group.chatId, title: group.title, messageCount: group.messages.length,
      senderCount: group.senderCount, textChars: group.textChars, action, text: texts[index]! };
  });
  return { chats, messageCount: run.messageCount, chatCount: run.chatCount, listedChars: run.listedChars };
}

/** The last line of a listed text that the cap cut. Chats were left out: the count of chats and messages. The first chat was cut and no chat was left out: only the rest of that chat. */
const capLine = (cut: boolean, chats: number, messages: number): string => {
  if (cut && chats === 0) return '（已達單次傳送上限，此聊天室其餘內容未列出）';
  if (cut) return `（已達單次傳送上限，此聊天室其餘內容與另外 ${chats} 個聊天室、${messages} 則未列出）`;
  return `（已達單次傳送上限，另有 ${chats} 個聊天室、${messages} 則未列出）`;
};

/**
 * The text to send for the chats with action list; empty when there are none. It is at most NEW_MESSAGES_LIST_CHARS_CAP long: chats are
 * added in order and the first chat that would pass the cap stops the list (a first chat that is alone longer than the cap is cut).
 * The line of the cap, then the incomplete line when the read stopped at the cap of one run, end the text; they do not count in the cap.
 */
export function listedText(chats: readonly NewMessagesChatResult[], incomplete: boolean): string {
  const listed = chats.filter((chat) => chat.action === 'list');
  if (listed.length === 0) return '';
  let text = '';
  let included = 0;
  let cut = false;
  for (const chat of listed) {
    const next = included === 0 ? chat.text : `${text}${NEW_MESSAGES_CHAT_SEPARATOR}${chat.text}`;
    if (next.length > NEW_MESSAGES_LIST_CHARS_CAP) {
      if (included === 0) { text = cutText(chat.text, NEW_MESSAGES_LIST_CHARS_CAP); included = 1; cut = true; }
      break;
    }
    text = next;
    included += 1;
  }
  if (text.length === 0) return '';
  const rest = listed.slice(included);
  if (rest.length > 0 || cut) {
    text = `${text}${NEW_MESSAGES_CHAT_SEPARATOR}${capLine(cut, rest.length, rest.reduce((sum, chat) => sum + chat.messageCount, 0))}`;
  }
  return incomplete ? `${text}${NEW_MESSAGES_CHAT_SEPARATOR}${NEW_MESSAGES_INCOMPLETE_LINE}` : text;
}
