import { z } from 'zod';
import { AgentProviderSchema } from './agent.js';
import { ChatTypeSchema } from './account.js';

/** Scheduled Agent triggers (docs/architecture/agent-schedules.md). Time math is in-house: no cron dependency. */
export const AGENT_SCHEDULE_TITLE_MAX = 80;
export const AGENT_SCHEDULE_PROMPT_MAX = 4_000;
export const AGENT_SCHEDULE_MAX_ENABLED = 50;
export const AGENT_SCHEDULE_DEFAULT_TIMEZONE = 'Asia/Taipei';
export const AGENT_SCHEDULE_INTERVAL_MIN_MINUTES = 5;
export const AGENT_SCHEDULE_INTERVAL_MAX_MINUTES = 10_080;
export const AGENT_SCHEDULE_RUNS_MAX_LIMIT = 50;
/** A run may start a random 0..N minutes after its nominal time (never before it). */
export const AGENT_SCHEDULE_JITTER_MAX_MINUTES = 5;
/** Prefix of the job `source_request_id` created by a schedule: `schedule:<scheduleId>:<scheduledFor ISO>`. */
export const AGENT_SCHEDULE_REQUEST_PREFIX = 'schedule:';
/** Prefix of a scheduled job's prompt. */
export const AGENT_SCHEDULE_PROMPT_PREFIX = '[排程] ';

const TimestampSchema = z.iso.datetime({ offset: true });
const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm');

export type CronFieldSet = { values: ReadonlySet<number>; star: boolean };
export type ParsedCron = { minute: CronFieldSet; hour: CronFieldSet; dayOfMonth: CronFieldSet; month: CronFieldSet; dayOfWeek: CronFieldSet };
export type CronValidation = { valid: true; cron: ParsedCron } | { valid: false; reason: string };

function parseCronField(text: string, min: number, max: number, label: string, mapValue?: (n: number) => number): CronFieldSet | string {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(',')) {
    if (part.length === 0) return `${label}: empty list item`;
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) return `${label}: invalid step`;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return `${label}: invalid step`;
      step = Number(stepPart);
      if (step < 1) return `${label}: step must be >= 1`;
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min; to = max;
      star = true;
    } else if (rangePart !== undefined && /^\d+-\d+$/.test(rangePart)) {
      [from, to] = rangePart.split('-').map(Number) as [number, number];
      if (from > to) return `${label}: range start is after end`;
    } else if (rangePart !== undefined && /^\d+$/.test(rangePart)) {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    } else return `${label}: invalid value "${part}"`;
    if (from < min || to > max) return `${label}: value out of range ${min}-${max}`;
    for (let n = from; n <= to; n += step) values.add(mapValue ? mapValue(n) : n);
  }
  return { values, star };
}

/** Validates and parses a 5-field cron expression: minute hour day-of-month month day-of-week. */
export function validateCron(expression: string): CronValidation {
  if (typeof expression !== 'string' || expression.length > 256) return { valid: false, reason: 'Cron expression is too long' };
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === '') return { valid: false, reason: 'Cron needs exactly 5 fields' };
  const specs: Array<[number, number, string, ((n: number) => number)?]> = [
    [0, 59, 'minute'], [0, 23, 'hour'], [1, 31, 'day-of-month'], [1, 12, 'month'], [0, 7, 'day-of-week', (n) => n === 7 ? 0 : n],
  ];
  const parsed: CronFieldSet[] = [];
  for (let i = 0; i < 5; i++) {
    const [min, max, label, map] = specs[i]!;
    const result = parseCronField(fields[i]!, min, max, label, map);
    if (typeof result === 'string') return { valid: false, reason: result };
    parsed.push(result);
  }
  return { valid: true, cron: { minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!, month: parsed[3]!, dayOfWeek: parsed[4]! } };
}

export function isValidTimeZone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return timezone.length > 0 && timezone.length <= 64; } catch { return false; }
}

export const AgentScheduleTimezoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'Invalid IANA timezone');

export const AgentScheduleRecurrenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: TimestampSchema }),
  z.strictObject({ kind: z.literal('daily'), time: TimeOfDaySchema }),
  z.strictObject({
    kind: z.literal('weekly'),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length, 'Days must be unique'),
    time: TimeOfDaySchema,
  }),
  z.strictObject({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(AGENT_SCHEDULE_INTERVAL_MIN_MINUTES).max(AGENT_SCHEDULE_INTERVAL_MAX_MINUTES),
    anchorAt: TimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('cron'),
    expression: z.string().min(1).max(256).superRefine((value, ctx) => {
      const result = validateCron(value);
      if (!result.valid) ctx.addIssue({ code: 'custom', message: result.reason });
    }),
  }),
]);
export type AgentScheduleRecurrence = z.infer<typeof AgentScheduleRecurrenceSchema>;

/**
 * Agent runs end as submitted / failed / missed / skipped_overlap. System message runs (no Agent job) end as sent / send_failed /
 * send_unknown; `send_unknown` is never retried.
 */
export const AgentScheduleRunOutcomeSchema = z.enum(['submitting', 'submitted', 'missed', 'skipped_overlap', 'failed', 'sent', 'send_failed', 'send_unknown']);
export type AgentScheduleRunOutcome = z.infer<typeof AgentScheduleRunOutcomeSchema>;

export const AGENT_SCHEDULE_MAX_TARGETS = 20;
export const AGENT_SCHEDULE_FOCUS_MAX = 500;
export const AGENT_SCHEDULE_KEYWORD_MAX = 50;
export const AGENT_SCHEDULE_KEYWORDS_MAX = 20;
export const AGENT_SCHEDULE_LOOKBACK_MIN_MINUTES = 5;
export const AGENT_SCHEDULE_LOOKBACK_MAX_MINUTES = 10_080;
/** A window is never longer than this, whatever the mode. */
export const AGENT_SCHEDULE_WINDOW_CAP_MS = 7 * 24 * 3_600_000;

/** A conversation the schedule reads: any chat type the Agent can read through list_targets. `title` is a display snapshot refreshed by Main on save. */
export const AgentScheduleReadTargetSchema = z.strictObject({
  accountId: z.string().min(1).max(256),
  chatType: ChatTypeSchema,
  chatId: z.string().min(1).max(256),
  title: z.string().max(200).default(''),
});
export type AgentScheduleReadTarget = z.infer<typeof AgentScheduleReadTargetSchema>;
/** A conversation the schedule sends to: the Agent account's direct, group or room chats (list_send_targets). */
export const AgentScheduleSendTargetSchema = z.strictObject({
  accountId: z.string().min(1).max(256),
  chatType: z.enum(['direct', 'group', 'room']),
  chatId: z.string().min(1).max(256),
  title: z.string().max(200).default(''),
});
export type AgentScheduleSendTarget = z.infer<typeof AgentScheduleSendTargetSchema>;
/** Stored shape of a read target; kept as the general name used by lists, resolvers and the form. */
export const AgentScheduleTargetSchema = AgentScheduleReadTargetSchema;
export type AgentScheduleTarget = AgentScheduleReadTarget;
export const scheduleTargetKey = (target: Pick<AgentScheduleTarget, 'accountId' | 'chatType' | 'chatId'>): string =>
  JSON.stringify([target.accountId, target.chatType, target.chatId]);

/** A selectable chat in the schedule pickers; `role` marks the administrator's direct chat with the Agent account. */
export const AgentScheduleTargetOptionSchema = AgentScheduleReadTargetSchema.extend({ role: z.literal('primary_admin').optional() });
export type AgentScheduleTargetOption = z.infer<typeof AgentScheduleTargetOptionSchema>;

export const AGENT_SCHEDULE_MESSAGE_MAX = 5_000;
/** Replaced at fire time, in Asia/Taipei, by the system message sender. */
export const AGENT_SCHEDULE_MESSAGE_PLACEHOLDERS = ['{{date}}', '{{time}}', '{{weekday}}'] as const;
const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;
const taipeiParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});
/** Fills {{date}} (YYYY-MM-DD), {{time}} (HH:mm) and {{weekday}} (星期一…星期日) of a system message for `at`, in Asia/Taipei. */
export function resolveScheduleMessagePlaceholders(text: string, at: Date): string {
  const parts: Record<string, string> = {};
  for (const part of taipeiParts.formatToParts(at)) if (part.type !== 'literal') parts[part.type] = part.value;
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  const values: Record<string, string> = {
    '{{date}}': `${parts.year}-${parts.month}-${parts.day}`,
    '{{time}}': `${parts.hour}:${parts.minute}`,
    '{{weekday}}': WEEKDAY_LABELS[index < 0 ? 0 : index]!,
  };
  return text.replace(/\{\{(?:date|time|weekday)\}\}/g, (match) => values[match]!);
}

export const AgentScheduleTaskSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('custom') }),
  /** A system message (alarm / reminder): Main sends `text` to LINE at fire time. No Agent job, no provider, no tokens. */
  z.strictObject({ type: z.literal('message'), text: z.string().trim().min(1).max(AGENT_SCHEDULE_MESSAGE_MAX) }),
  z.strictObject({ type: z.literal('summary'), focus: z.string().trim().min(1).max(AGENT_SCHEDULE_FOCUS_MAX).optional() }),
  z.strictObject({
    type: z.literal('keyword_digest'),
    keywords: z.array(z.string().trim().min(1).max(AGENT_SCHEDULE_KEYWORD_MAX)).min(1).max(AGENT_SCHEDULE_KEYWORDS_MAX),
  }),
]);
export type AgentScheduleTask = z.infer<typeof AgentScheduleTaskSchema>;

export const AgentScheduleWindowSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('since_last_run') }),
  z.strictObject({ mode: z.literal('lookback'), minutes: z.number().int().min(AGENT_SCHEDULE_LOOKBACK_MIN_MINUTES).max(AGENT_SCHEDULE_LOOKBACK_MAX_MINUTES) }),
]);
export type AgentScheduleWindow = z.infer<typeof AgentScheduleWindowSchema>;

/**
 * primary_admin (default): at fire time Main resolves the Agent account's direct chat with the current Primary Admin.
 * record_only: nothing is sent; the Agent's reply stays in the run history (agent tasks only).
 */
export const AgentScheduleDeliverySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('primary_admin') }),
  z.strictObject({ mode: z.literal('record_only') }),
  z.strictObject({ mode: z.literal('line_target'), target: AgentScheduleSendTargetSchema }),
]);
export type AgentScheduleDelivery = z.infer<typeof AgentScheduleDeliverySchema>;

/** Cross-field rules shared by create, update (on the merged result) and the MCP tools. Returns an error message or null. */
export function agentScheduleShapeError(shape: {
  prompt: string; targets: readonly AgentScheduleTarget[]; task: AgentScheduleTask; delivery?: AgentScheduleDelivery | undefined;
}): string | null {
  const keys = new Set(shape.targets.map(scheduleTargetKey));
  if (keys.size !== shape.targets.length) return 'Targets must be unique';
  if (shape.task.type === 'message') {
    if (shape.targets.length > 0) return 'A system message does not read chats';
    if (shape.delivery?.mode === 'record_only') return 'A system message must be delivered to LINE';
    return null;
  }
  if (shape.task.type === 'custom' && shape.prompt.trim().length === 0) return 'A custom task needs a prompt';
  if (shape.task.type !== 'custom' && shape.targets.length === 0) return 'This task needs at least one target';
  return null;
}
const shapeRefine = (shape: {
  prompt?: string | undefined; targets?: readonly AgentScheduleTarget[] | undefined; task?: AgentScheduleTask | undefined;
  delivery?: AgentScheduleDelivery | undefined;
}, ctx: z.RefinementCtx) => {
  const message = agentScheduleShapeError({ prompt: shape.prompt ?? '', targets: shape.targets ?? [], task: shape.task ?? { type: 'custom' },
    delivery: shape.delivery ?? { mode: 'primary_admin' } });
  if (message) ctx.addIssue({ code: 'custom', message });
};

export const AgentScheduleSchema = z.strictObject({
  scheduleId: z.uuid(),
  title: z.string().min(1).max(AGENT_SCHEDULE_TITLE_MAX),
  prompt: z.string().max(AGENT_SCHEDULE_PROMPT_MAX),
  provider: AgentProviderSchema,
  recurrence: AgentScheduleRecurrenceSchema,
  timezone: AgentScheduleTimezoneSchema,
  targets: z.array(AgentScheduleTargetSchema).max(AGENT_SCHEDULE_MAX_TARGETS),
  task: AgentScheduleTaskSchema,
  window: AgentScheduleWindowSchema,
  delivery: AgentScheduleDeliverySchema,
  jitterMinutes: z.number().int().min(0).max(AGENT_SCHEDULE_JITTER_MAX_MINUTES),
  enabled: z.boolean(),
  nextFireAt: TimestampSchema.nullable(),
  lastFireAt: TimestampSchema.nullable(),
  lastOutcome: AgentScheduleRunOutcomeSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;

export const AgentScheduleRunSchema = z.strictObject({
  runId: z.uuid(),
  scheduleId: z.uuid(),
  scheduledFor: TimestampSchema,
  outcome: AgentScheduleRunOutcomeSchema,
  jobId: z.string().min(1).nullable(),
  /** At most 200 characters of the run job's reply (agent runs that completed); null otherwise. The full reply is read through the job. */
  replyPreview: z.string().max(400).nullable(),
  createdAt: TimestampSchema,
});
export type AgentScheduleRun = z.infer<typeof AgentScheduleRunSchema>;

/** Editable fields shared by the UI (IPC) and the Agent (MCP). `prompt` is extra instructions unless the task is custom. */
const scheduleFields = {
  title: z.string().trim().min(1).max(AGENT_SCHEDULE_TITLE_MAX),
  prompt: z.string().trim().max(AGENT_SCHEDULE_PROMPT_MAX),
  provider: AgentProviderSchema,
  recurrence: AgentScheduleRecurrenceSchema,
  timezone: AgentScheduleTimezoneSchema,
  targets: z.array(AgentScheduleTargetSchema).max(AGENT_SCHEDULE_MAX_TARGETS),
  task: AgentScheduleTaskSchema,
  window: AgentScheduleWindowSchema,
  delivery: AgentScheduleDeliverySchema,
  /** Random delay of 0..5 minutes after each nominal time; 0 = none. */
  jitterMinutes: z.number().int().min(0).max(AGENT_SCHEDULE_JITTER_MAX_MINUTES),
  enabled: z.boolean(),
};
export const AgentScheduleCreateInputSchema = z.strictObject({
  title: scheduleFields.title,
  prompt: scheduleFields.prompt.default(''),
  provider: scheduleFields.provider,
  recurrence: scheduleFields.recurrence,
  timezone: scheduleFields.timezone.default(AGENT_SCHEDULE_DEFAULT_TIMEZONE),
  targets: scheduleFields.targets.default([]),
  task: scheduleFields.task.default({ type: 'custom' }),
  window: scheduleFields.window.default({ mode: 'since_last_run' }),
  delivery: scheduleFields.delivery.default({ mode: 'primary_admin' }),
  jitterMinutes: scheduleFields.jitterMinutes.default(0),
  enabled: scheduleFields.enabled.default(true),
}).superRefine(shapeRefine);
export type AgentScheduleCreateInput = z.infer<typeof AgentScheduleCreateInputSchema>;
export const AgentScheduleUpdatePatchSchema = z.strictObject({
  title: scheduleFields.title.optional(),
  prompt: scheduleFields.prompt.optional(),
  provider: scheduleFields.provider.optional(),
  recurrence: scheduleFields.recurrence.optional(),
  timezone: scheduleFields.timezone.optional(),
  targets: scheduleFields.targets.optional(),
  task: scheduleFields.task.optional(),
  window: scheduleFields.window.optional(),
  delivery: scheduleFields.delivery.optional(),
  jitterMinutes: scheduleFields.jitterMinutes.optional(),
  enabled: scheduleFields.enabled.optional(),
}).refine((patch) => Object.keys(patch).length > 0, 'At least one field is required');
export type AgentScheduleUpdatePatch = z.infer<typeof AgentScheduleUpdatePatchSchema>;

// ---- Internal MCP tools (never in McpToolNameSchema / external token scopes) ----
export const LIST_SCHEDULES_TOOL_NAME = 'list_schedules' as const;
export const CREATE_SCHEDULE_TOOL_NAME = 'create_schedule' as const;
export const UPDATE_SCHEDULE_TOOL_NAME = 'update_schedule' as const;
export const DELETE_SCHEDULE_TOOL_NAME = 'delete_schedule' as const;
export const SCHEDULE_TOOL_NAMES = [LIST_SCHEDULES_TOOL_NAME, CREATE_SCHEDULE_TOOL_NAME, UPDATE_SCHEDULE_TOOL_NAME, DELETE_SCHEDULE_TOOL_NAME] as const;
export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number];
export const isScheduleToolName = (value: unknown): value is ScheduleToolName => (SCHEDULE_TOOL_NAMES as readonly unknown[]).includes(value);

/** Tool-only convenience: a one-time run N minutes from now. Main converts it to { kind: 'once', at }. */
export const AGENT_SCHEDULE_IN_MINUTES_MAX = 10_080;
export const ScheduleToolRecurrenceSchema = z.union([
  AgentScheduleRecurrenceSchema,
  z.strictObject({ kind: z.literal('once'), inMinutes: z.number().int().min(1).max(AGENT_SCHEDULE_IN_MINUTES_MAX) }),
]);
export type ScheduleToolRecurrence = z.infer<typeof ScheduleToolRecurrenceSchema>;

export const LIST_SCHEDULES_STATUS_VALUES = ['active', 'disabled', 'all'] as const;
export const ListSchedulesToolInputSchema = z.strictObject({ status: z.enum(LIST_SCHEDULES_STATUS_VALUES).default('active') });
export const CreateScheduleToolInputSchema = z.strictObject({
  title: scheduleFields.title,
  prompt: scheduleFields.prompt.optional(),
  provider: scheduleFields.provider.optional(),
  recurrence: ScheduleToolRecurrenceSchema,
  timezone: scheduleFields.timezone.optional(),
  targets: scheduleFields.targets.optional(),
  task: scheduleFields.task.optional(),
  window: scheduleFields.window.optional(),
  delivery: scheduleFields.delivery.optional(),
  jitterMinutes: scheduleFields.jitterMinutes.optional(),
  enabled: scheduleFields.enabled.optional(),
}).superRefine((shape, ctx) => {
  // The tool defaults the task to summary when chats are given, else custom.
  shapeRefine({ ...shape, task: shape.task ?? ((shape.targets ?? []).length > 0 ? { type: 'summary' } : { type: 'custom' }) }, ctx);
});
export const UpdateScheduleToolInputSchema = z.strictObject({
  scheduleId: z.uuid(),
  title: scheduleFields.title.optional(),
  prompt: scheduleFields.prompt.optional(),
  provider: scheduleFields.provider.optional(),
  recurrence: ScheduleToolRecurrenceSchema.optional(),
  timezone: scheduleFields.timezone.optional(),
  targets: scheduleFields.targets.optional(),
  task: scheduleFields.task.optional(),
  window: scheduleFields.window.optional(),
  delivery: scheduleFields.delivery.optional(),
  jitterMinutes: scheduleFields.jitterMinutes.optional(),
  enabled: scheduleFields.enabled.optional(),
}).refine((input) => Object.keys(input).length > 1, 'At least one field to change is required');
export const DeleteScheduleToolInputSchema = z.strictObject({ scheduleId: z.uuid() });
export const ListSchedulesToolOutputSchema = z.strictObject({ toolName: z.literal(LIST_SCHEDULES_TOOL_NAME), schedules: z.array(AgentScheduleSchema).max(200) });
export const CreateScheduleToolOutputSchema = z.strictObject({
  toolName: z.literal(CREATE_SCHEDULE_TOOL_NAME),
  schedule: AgentScheduleSchema,
  /** Asia/Taipei display of nextFireAt (YYYY-MM-DD HH:mm), or null when there is none. */
  nextFireAtTaipei: z.string().nullable(),
  /** Where the result goes, as the user should read it: a chat title or 「管理員」. */
  deliveryLabel: z.string(),
});
export const UpdateScheduleToolOutputSchema = z.strictObject({ toolName: z.literal(UPDATE_SCHEDULE_TOOL_NAME), schedule: AgentScheduleSchema });
export const DeleteScheduleToolOutputSchema = z.strictObject({ toolName: z.literal(DELETE_SCHEDULE_TOOL_NAME), deleted: z.literal(true), scheduleId: z.uuid() });
export type ListSchedulesToolOutput = z.infer<typeof ListSchedulesToolOutputSchema>;

// ---- IPC payloads ----
export const AgentScheduleListRunsInputSchema = z.strictObject({
  scheduleId: z.uuid(),
  limit: z.number().int().min(1).max(AGENT_SCHEDULE_RUNS_MAX_LIMIT).default(20),
});

export const AgentScheduleListTargetsInputSchema = z.strictObject({
  /** read: chats a schedule may read (communities included); delivery: chats it may send to. */
  purpose: z.enum(['read', 'delivery']).default('read'),
  query: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

// ---- Time math ----
type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function localParts(instant: Date, timezone: string): LocalParts & { second: number } {
  const out: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: (out.hour ?? 0) % 24, minute: out.minute!, second: out.second! };
}

/** UTC offset in ms of `timezone` at `instant`. */
function offsetMs(instant: Date, timezone: string): number {
  const p = localParts(instant, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in `timezone` to an instant. A time skipped by DST moves forward; an ambiguous one picks the first. */
function zonedToInstant(p: LocalParts, timezone: string): Date {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  let guess = wall - offsetMs(new Date(wall), timezone);
  guess = wall - offsetMs(new Date(guess), timezone);
  const settled = new Date(guess);
  const back = localParts(settled, timezone);
  if (back.hour === p.hour && back.minute === p.minute && back.day === p.day) return settled;
  // Wall time does not exist (DST gap): use the earlier offset so the result lands just after the gap.
  return new Date(wall - offsetMs(new Date(wall - 24 * 3_600_000), timezone));
}

const SEARCH_DAYS_CRON = 366;

function matchesCronDay(cron: ParsedCron, month: number, dayOfMonth: number, dayOfWeek: number): boolean {
  if (!cron.month.values.has(month)) return false;
  const domOk = cron.dayOfMonth.values.has(dayOfMonth);
  const dowOk = cron.dayOfWeek.values.has(dayOfWeek);
  // Standard cron: when both day fields are restricted, either one matches; otherwise the restricted one decides.
  if (!cron.dayOfMonth.star && !cron.dayOfWeek.star) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Next fire time strictly after `after`, or null when there is none (an elapsed `once`, or a cron with no match within 366 days).
 * Times are evaluated in the schedule's IANA `timezone`.
 */
export function nextFireAfter(recurrence: AgentScheduleRecurrence, timezone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) return null;
  if (recurrence.kind === 'once') {
    const at = new Date(recurrence.at);
    return at.getTime() > afterMs ? at : null;
  }
  if (recurrence.kind === 'interval') {
    const anchor = new Date(recurrence.anchorAt).getTime();
    const step = recurrence.everyMinutes * 60_000;
    if (!Number.isFinite(anchor) || recurrence.everyMinutes < AGENT_SCHEDULE_INTERVAL_MIN_MINUTES) return null;
    if (anchor > afterMs) return new Date(anchor);
    return new Date(anchor + (Math.floor((afterMs - anchor) / step) + 1) * step);
  }
  const start = localParts(after, timezone);
  let timesOfDay: Array<[number, number]>;
  let dayMatches: (month: number, dom: number, dow: number) => boolean;
  let searchDays: number;
  if (recurrence.kind === 'daily' || recurrence.kind === 'weekly') {
    const [h, m] = recurrence.time.split(':').map(Number) as [number, number];
    timesOfDay = [[h, m]];
    const days = recurrence.kind === 'weekly' ? new Set(recurrence.days) : null;
    dayMatches = (_month, _dom, dow) => days === null || days.has(dow);
    searchDays = 9;
  } else {
    const parsed = validateCron(recurrence.expression);
    if (!parsed.valid) return null;
    const cron = parsed.cron;
    const hours = [...cron.hour.values].sort((a, b) => a - b);
    const minutes = [...cron.minute.values].sort((a, b) => a - b);
    timesOfDay = hours.flatMap((h) => minutes.map((m): [number, number] => [h, m]));
    dayMatches = (month, dom, dow) => matchesCronDay(cron, month, dom, dow);
    searchDays = SEARCH_DAYS_CRON;
  }
  for (let offset = 0; offset <= searchDays; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, dom = day.getUTCDate(), dow = day.getUTCDay();
    if (!dayMatches(month, dom, dow)) continue;
    for (const [hour, minute] of timesOfDay) {
      const candidate = zonedToInstant({ year, month, day: dom, hour, minute }, timezone);
      if (candidate.getTime() > afterMs) return candidate;
    }
  }
  return null;
}
