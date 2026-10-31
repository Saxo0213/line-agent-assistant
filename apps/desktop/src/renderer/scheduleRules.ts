import {
  AGENT_SCHEDULE_CHAT_NUMBER_METRICS, AGENT_SCHEDULE_KEYWORDS_MAX, AGENT_SCHEDULE_LEAVES_MAX, AGENT_SCHEDULE_MESSAGE_DIRECTIONS, AGENT_SCHEDULE_MESSAGE_KINDS,
  AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_PER_CHAT, AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_TEXT_CHARS, AGENT_SCHEDULE_NEW_MESSAGES_PER_CHAT_MAX,
  AGENT_SCHEDULE_NEW_MESSAGES_TEXT_CHARS_MAX, AGENT_SCHEDULE_NEW_MESSAGES_TEXT_CHARS_MIN, AGENT_SCHEDULE_NUMBER_OPS, AGENT_SCHEDULE_RULES_MAX,
  AgentScheduleNewMessagesTaskSchema, ChatTypeSchema, scheduleExecutionKind,
  type AgentScheduleCondition, type AgentScheduleExecution, type AgentScheduleNewMessagesTask, type AgentScheduleRuleAction, type AgentScheduleTarget, type AgentScheduleTask,
} from '@line-agent/contracts';
import type { ScheduleCopyKey } from '../desktop-schedule-copy.js';

/**
 * Draft state and pure logic of the new_messages task editor. The draft keeps every value as the user typed it (numbers are strings);
 * `buildNewMessagesTask` turns it back into a task and validates it with the contract schema.
 */

type Text = (key: ScheduleCopyKey, values?: Record<string, unknown>) => string;
export type RuleError = { key: ScheduleCopyKey; values?: Record<string, unknown> };
export type RuleErrors = { fields: Record<string, RuleError>; general?: RuleError };

export const RULES_MAX = AGENT_SCHEDULE_RULES_MAX;
export const LEAVES_MAX = AGENT_SCHEDULE_LEAVES_MAX;
/** in / not_in take 1..100 values. */
export const LIST_VALUES_MAX = 100;
export const KEYWORDS_MAX = AGENT_SCHEDULE_KEYWORDS_MAX;
export const COUNT_VALUE_MAX = 1_000_000_000;
export const PER_CHAT_RANGE = { min: 1, max: AGENT_SCHEDULE_NEW_MESSAGES_PER_CHAT_MAX } as const;
export const TEXT_CHARS_RANGE = { min: AGENT_SCHEDULE_NEW_MESSAGES_TEXT_CHARS_MIN, max: AGENT_SCHEDULE_NEW_MESSAGES_TEXT_CHARS_MAX } as const;

// ---- Schedule kind: derived from the task type, never stored ----
export type ScheduleKind = AgentScheduleExecution;
export const KIND_TASKS: Record<ScheduleKind, readonly AgentScheduleTask['type'][]> = {
  program: ['message', 'new_messages'],
  agent: ['custom', 'summary', 'keyword_digest'],
};
export const kindOfTask = (type: AgentScheduleTask['type']): ScheduleKind => scheduleExecutionKind({ type });

// ---- Metrics and operators ----
export type NumberMetric = (typeof AGENT_SCHEDULE_CHAT_NUMBER_METRICS)[number] | 'chat.keywordHits';
export type Metric = NumberMetric | 'chat.type' | 'chat.id' | 'message.direction' | 'message.kind' | 'message.textContains';
export type RuleScope = 'message' | 'rule';
export const MESSAGE_METRICS: readonly Metric[] = ['message.direction', 'message.kind', 'message.textContains'];
export const RULE_METRICS: readonly Metric[] = ['chat.messageCount', 'chat.senderCount', 'chat.textChars', 'chat.keywordHits', 'chat.type', 'chat.id', 'run.messageCount', 'run.chatCount', 'run.listedChars'];
export const metricsOf = (scope: RuleScope): readonly Metric[] => scope === 'message' ? MESSAGE_METRICS : RULE_METRICS;

export type MetricKind = 'number' | 'enum' | 'chatId' | 'textContains';
export function metricKind(metric: Metric): MetricKind {
  if (metric === 'chat.id') return 'chatId';
  if (metric === 'message.textContains') return 'textContains';
  if (metric === 'chat.type' || metric === 'message.direction' || metric === 'message.kind') return 'enum';
  return 'number';
}
export const NUMBER_OPS: readonly string[] = AGENT_SCHEDULE_NUMBER_OPS;
export const TEXT_OPS: readonly string[] = ['==', '!=', 'in', 'not_in'];
export const CONTAINS_OPS: readonly string[] = ['any_of', 'none_of'];
export const opsOf = (metric: Metric): readonly string[] => { const kind = metricKind(metric); return kind === 'number' ? NUMBER_OPS : kind === 'textContains' ? CONTAINS_OPS : TEXT_OPS; };
export const isSingleOp = (op: string): boolean => op === '==' || op === '!=';
export const NUMBER_OP_SYMBOLS: Record<string, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '==': '=', '!=': '≠' };
export const CHAT_TYPES = ChatTypeSchema.options;
export type ChatType = (typeof CHAT_TYPES)[number];

/** Allowed values of an enum metric. */
export function enumValues(metric: Metric): readonly string[] {
  return metric === 'chat.type' ? CHAT_TYPES : metric === 'message.direction' ? AGENT_SCHEDULE_MESSAGE_DIRECTIONS : AGENT_SCHEDULE_MESSAGE_KINDS;
}

const METRIC_KEYS: Record<Metric, ScheduleCopyKey> = {
  'message.direction': 'metricMessageDirection', 'message.kind': 'metricMessageKind', 'message.textContains': 'metricMessageTextContains',
  'chat.messageCount': 'metricChatMessageCount', 'chat.senderCount': 'metricChatSenderCount', 'chat.textChars': 'metricChatTextChars', 'chat.keywordHits': 'metricChatKeywordHits',
  'chat.type': 'metricChatType', 'chat.id': 'metricChatId', 'run.messageCount': 'metricRunMessageCount', 'run.chatCount': 'metricRunChatCount', 'run.listedChars': 'metricRunListedChars',
};
const TEXT_OP_KEYS: Record<string, ScheduleCopyKey> = { '==': 'opIs', '!=': 'opIsNot', in: 'opIn', not_in: 'opNotIn', any_of: 'opAnyOf', none_of: 'opNoneOf' };
const VALUE_KEYS: Record<string, ScheduleCopyKey> = {
  inbound: 'directionInbound', outbound: 'directionOutbound',
  text: 'msgKindText', image: 'msgKindImage', video: 'msgKindVideo', audio: 'msgKindAudio', file: 'msgKindFile', sticker: 'msgKindSticker', contact: 'msgKindContact',
  event: 'msgKindEvent', location: 'msgKindLocation', rich: 'msgKindRich',
  direct: 'chatTypeDirect', group: 'chatTypeGroup', room: 'chatTypeRoom', community: 'chatTypeCommunity', thread: 'chatTypeThread',
};
export const metricKey = (metric: Metric): ScheduleCopyKey => METRIC_KEYS[metric];
/** Label of an operator: the symbol for a number metric, a word for a text metric. */
export const opLabel = (op: string, text: Text, numeric = false): string => !numeric && TEXT_OP_KEYS[op] ? text(TEXT_OP_KEYS[op]!) : NUMBER_OP_SYMBOLS[op] ?? op;
export const enumValueLabel = (value: string, text: Text): string => VALUE_KEYS[value] ? text(VALUE_KEYS[value]!) : value;
export const ACTION_KEYS: Record<AgentScheduleRuleAction, ScheduleCopyKey> = { list: 'actionList', skip: 'actionSkip', llm: 'actionLlm' };

// ---- Draft ----
export type DraftChat = { accountId: string; chatType: ChatType; title: string };
export type DraftLeaf = {
  type: 'leaf'; key: string; metric: Metric; op: string;
  /** Number metrics. */
  value: string;
  /** Text metrics: one value for == and !=, many for in, not_in, any_of and none_of. */
  list: string[];
  /** chat.keywordHits only. */
  keywords: string[];
  /** chat.id only: display data of the picked chats. Never sent. */
  chats: Record<string, DraftChat>;
};
export type DraftGroup = {
  type: 'group'; key: string; mode: 'all' | 'any'; children: Array<DraftLeaf | DraftGroup>;
  /** Root only: a group with one leaf builds back to that leaf (the stored form was a bare leaf). */
  collapse: boolean;
};
export type DraftRule = { key: string; when: DraftGroup; then: AgentScheduleRuleAction };
export type NewMessagesDraft = {
  messageFilter: DraftGroup | null; rules: DraftRule[];
  maxMessagesPerChat: string; maxTextChars: string; sendWhenEmpty: boolean;
};

let sequence = 0;
const nextKey = (): string => `n${++sequence}`;

/** A leaf of `metric` with the default operator and value. */
export function leafForMetric(metric: Metric, key: string = nextKey()): DraftLeaf {
  const base: DraftLeaf = { type: 'leaf', key, metric, op: '>=', value: '1', list: [], keywords: [], chats: {} };
  switch (metricKind(metric)) {
    case 'number': return base;
    case 'enum': return { ...base, op: '==', value: '', list: [enumValues(metric)[0]!] };
    case 'chatId': return { ...base, op: 'in', value: '', list: [] };
    case 'textContains': return { ...base, op: 'any_of', value: '', list: [] };
  }
}
export const newLeaf = (scope: RuleScope): DraftLeaf => scope === 'message' ? leafForMetric('message.direction') : leafForMetric('chat.messageCount');
/** A new group with one row; `root` groups collapse back to a bare leaf when they keep one row. */
export const newGroup = (scope: RuleScope, root: boolean): DraftGroup => ({ type: 'group', key: nextKey(), mode: 'all', children: [newLeaf(scope)], collapse: root });
export const newRule = (): DraftRule => ({ key: nextKey(), when: newGroup('rule', true), then: 'list' });

/** Changes the operator; a single-value operator keeps only the first value. */
export function leafWithOp(leaf: DraftLeaf, op: string): DraftLeaf {
  return { ...leaf, op, list: isSingleOp(op) && leaf.list.length > 1 ? leaf.list.slice(0, 1) : leaf.list };
}

export function defaultNewMessagesDraft(): NewMessagesDraft {
  return { messageFilter: null, rules: [], maxMessagesPerChat: String(AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_PER_CHAT), maxTextChars: String(AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_TEXT_CHARS), sendWhenEmpty: false };
}

type AnyCondition = AgentScheduleCondition;
const isGroupCondition = (condition: AnyCondition): condition is { all: AnyCondition[] } | { any: AnyCondition[] } => 'all' in condition || 'any' in condition;

function leafFromCondition(condition: AnyCondition, chats: ReadonlyMap<string, AgentScheduleTarget>): DraftLeaf {
  const leaf = condition as { metric: Metric; op: string; value: unknown; keywords?: string[] };
  const metric = leaf.metric;
  const draft: DraftLeaf = { type: 'leaf', key: nextKey(), metric, op: leaf.op, value: '', list: [], keywords: [], chats: {} };
  if (metricKind(metric) === 'number') {
    draft.value = String(leaf.value);
    if (leaf.keywords) draft.keywords = [...leaf.keywords];
    return draft;
  }
  draft.list = Array.isArray(leaf.value) ? (leaf.value as string[]).slice() : [String(leaf.value)];
  if (metric === 'chat.id') {
    for (const id of draft.list) {
      const known = chats.get(id);
      if (known) draft.chats[id] = { accountId: known.accountId, chatType: known.chatType, title: known.title };
    }
  }
  return draft;
}

function groupFromCondition(condition: AnyCondition, chats: ReadonlyMap<string, AgentScheduleTarget>, root: boolean): DraftGroup {
  if (!isGroupCondition(condition)) return { type: 'group', key: nextKey(), mode: 'all', children: [leafFromCondition(condition, chats)], collapse: true };
  const mode = 'all' in condition ? 'all' : 'any';
  const items = 'all' in condition ? condition.all : condition.any;
  return {
    type: 'group', key: nextKey(), mode, collapse: false,
    children: items.map((child) => isGroupCondition(child) ? groupFromCondition(child, chats, false) : leafFromCondition(child, chats)),
  };
}

/** Draft of a stored task. `knownChats` supplies the titles of chat.id values (display only). */
export function draftFromTask(task: AgentScheduleNewMessagesTask | undefined, knownChats: readonly AgentScheduleTarget[] = []): NewMessagesDraft {
  const base = defaultNewMessagesDraft();
  if (!task) return base;
  const chats = new Map(knownChats.map((chat) => [chat.chatId, chat]));
  return {
    messageFilter: task.messageFilter ? groupFromCondition(task.messageFilter, chats, true) : null,
    rules: (task.rules ?? []).map((rule) => ({ key: nextKey(), then: rule.then, when: groupFromCondition(rule.when, chats, true) })),
    maxMessagesPerChat: String(task.maxMessagesPerChat ?? AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_PER_CHAT),
    maxTextChars: String(task.maxTextChars ?? AGENT_SCHEDULE_NEW_MESSAGES_DEFAULT_TEXT_CHARS),
    sendWhenEmpty: task.sendWhenEmpty ?? false,
  };
}

const countGroupLeaves = (group: DraftGroup): number => group.children.reduce((sum, child) => sum + (child.type === 'leaf' ? 1 : countGroupLeaves(child)), 0);
/** Leaves of the message filter and all rules; the contract allows LEAVES_MAX in all. */
export const countDraftLeaves = (draft: NewMessagesDraft): number =>
  (draft.messageFilter ? countGroupLeaves(draft.messageFilter) : 0) + draft.rules.reduce((sum, rule) => sum + countGroupLeaves(rule.when), 0);
export const hasLlmRule = (draft: NewMessagesDraft): boolean => draft.rules.some((rule) => rule.then === 'llm');

/** Moves the item at `index` by `delta` places; returns the same array when the move is outside the list. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items.slice();
  const copy = items.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item!);
  return copy;
}

// ---- Build ----
const INTEGER = /^\d+$/;
function integerIn(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!INTEGER.test(trimmed)) return null;
  const number = Number(trimmed);
  return number >= min && number <= max ? number : null;
}

function leafToCondition(leaf: DraftLeaf, fields: Record<string, RuleError>): unknown {
  const kind = metricKind(leaf.metric);
  if (kind === 'number') {
    let ok = true;
    if (!leaf.value.trim()) { fields[leaf.key] = { key: 'errRuleValueRequired' }; ok = false; }
    else if (integerIn(leaf.value, 0, COUNT_VALUE_MAX) === null) { fields[leaf.key] = { key: 'errRuleNumber', values: { arg0: 0, arg1: COUNT_VALUE_MAX } }; ok = false; }
    if (leaf.metric === 'chat.keywordHits' && leaf.keywords.length === 0) { fields[`${leaf.key}.keywords`] = { key: 'errRuleValueRequired' }; ok = false; }
    if (!ok) return null;
    const value = Number(leaf.value.trim());
    return leaf.metric === 'chat.keywordHits' ? { metric: leaf.metric, op: leaf.op, value, keywords: [...leaf.keywords] } : { metric: leaf.metric, op: leaf.op, value };
  }
  if (leaf.list.length === 0) { fields[leaf.key] = { key: 'errRuleValueRequired' }; return null; }
  if (kind === 'textContains') return { metric: leaf.metric, op: leaf.op, value: [...leaf.list] };
  return { metric: leaf.metric, op: leaf.op, value: isSingleOp(leaf.op) ? leaf.list[0] : [...leaf.list] };
}

function groupToCondition(group: DraftGroup, fields: Record<string, RuleError>, root: boolean): unknown {
  if (group.children.length === 0) { fields[group.key] = { key: 'errRuleGroupEmpty' }; return null; }
  const items = group.children.map((child) => child.type === 'leaf' ? leafToCondition(child, fields) : groupToCondition(child, fields, false));
  if (items.some((item) => item === null)) return null;
  if (root && group.collapse && items.length === 1 && group.children[0]!.type === 'leaf') return items[0];
  return { [group.mode]: items };
}

/** The task of a draft, validated with AgentScheduleNewMessagesTaskSchema, or field errors (by leaf key / group key / parameter name) and a general error. */
export function buildNewMessagesTask(draft: NewMessagesDraft): { task: AgentScheduleNewMessagesTask; errors?: undefined } | { task?: undefined; errors: RuleErrors } {
  const fields: Record<string, RuleError> = {};
  const messageFilter = draft.messageFilter ? groupToCondition(draft.messageFilter, fields, true) : null;
  const rules = draft.rules.map((rule) => ({ when: groupToCondition(rule.when, fields, true), then: rule.then }));
  const param = (name: 'maxMessagesPerChat' | 'maxTextChars', range: { min: number; max: number }): number => {
    const raw = draft[name];
    if (!raw.trim()) { fields[name] = { key: 'errRuleValueRequired' }; return 0; }
    const value = integerIn(raw, range.min, range.max);
    if (value === null) { fields[name] = { key: 'errRuleNumber', values: { arg0: range.min, arg1: range.max } }; return 0; }
    return value;
  };
  const maxMessagesPerChat = param('maxMessagesPerChat', PER_CHAT_RANGE);
  const maxTextChars = param('maxTextChars', TEXT_CHARS_RANGE);
  if (Object.keys(fields).length > 0) return { errors: { fields, general: { key: 'errRulesFix' } } };
  const candidate = {
    type: 'new_messages' as const,
    ...(messageFilter ? { messageFilter } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    maxMessagesPerChat, maxTextChars, sendWhenEmpty: draft.sendWhenEmpty,
  };
  const parsed = AgentScheduleNewMessagesTaskSchema.safeParse(candidate);
  if (!parsed.success) return { errors: { fields: {}, general: { key: 'errRulesInvalid' } } };
  return { task: parsed.data };
}

// ---- Description (list page) ----
export type DescribeOptions = { chatTitle?: (chatId: string) => string | undefined };

function describeLeaf(condition: AnyCondition, text: Text, options: DescribeOptions): string {
  const leaf = condition as { metric: Metric; op: string; value: unknown; keywords?: string[] };
  const label = text(METRIC_KEYS[leaf.metric] ?? 'metricChatId');
  const separator = text('listSeparator');
  const kind = metricKind(leaf.metric);
  if (kind === 'number') {
    const keywords = leaf.keywords && leaf.keywords.length > 0 ? ` (${leaf.keywords.join(separator)})` : '';
    return `${label}${keywords} ${NUMBER_OP_SYMBOLS[leaf.op] ?? leaf.op} ${String(leaf.value)}`;
  }
  const values = Array.isArray(leaf.value) ? (leaf.value as string[]) : [String(leaf.value)];
  const shown = values.map((value) => kind === 'enum' ? enumValueLabel(value, text) : kind === 'chatId' ? options.chatTitle?.(value) || value : `"${value}"`);
  return `${label} ${opLabel(leaf.op, text)} ${shown.join(separator)}`;
}

/** Localized one-line text of a condition. Never raw JSON. */
export function describeCondition(condition: AgentScheduleCondition, text: Text, options: DescribeOptions = {}, nested = false): string {
  if (!isGroupCondition(condition)) return describeLeaf(condition, text, options);
  const items = 'all' in condition ? condition.all : condition.any;
  const joined = items.map((child) => describeCondition(child, text, options, true)).join('all' in condition ? text('condAnd') : text('condOr'));
  return nested && items.length > 1 ? `(${joined})` : joined;
}

/** Conditions of the rules that hand a chat to the LLM, joined; empty when there is no such rule. */
export function describeLlmRules(task: AgentScheduleTask, text: Text, options: DescribeOptions = {}): string {
  if (task.type !== 'new_messages') return '';
  return (task.rules ?? []).filter((rule) => rule.then === 'llm').map((rule) => describeCondition(rule.when, text, options)).join(' / ');
}
