import {
  AGENT_SCHEDULE_DEFAULT_TIMEZONE, AGENT_SCHEDULE_FOCUS_MAX, AGENT_SCHEDULE_JITTER_MAX_MINUTES, AGENT_SCHEDULE_INTERVAL_MAX_MINUTES, AGENT_SCHEDULE_INTERVAL_MIN_MINUTES,
  AGENT_SCHEDULE_KEYWORDS_MAX, AGENT_SCHEDULE_KEYWORD_MAX, AGENT_SCHEDULE_LOOKBACK_MAX_MINUTES, AGENT_SCHEDULE_LOOKBACK_MIN_MINUTES,
  AGENT_SCHEDULE_MAX_TARGETS, AGENT_SCHEDULE_MESSAGE_MAX, AGENT_SCHEDULE_PROMPT_MAX, AGENT_SCHEDULE_TITLE_MAX, isValidTimeZone, nextFireAfter, scheduleTargetKey, validateCron,
  type AgentSchedule, type AgentScheduleCreateInput, type AgentScheduleRecurrence, type AgentScheduleSendTarget, type AgentScheduleTarget, type AgentScheduleTask, type AgentScheduleWindow,
} from '@line-agent/contracts';
import type { ScheduleCopyKey } from '../desktop-schedule-copy.js';

export type RecurrenceKind = AgentScheduleRecurrence['kind'];
export type ScheduleFormState = {
  title: string;
  taskType: AgentScheduleTask['type'];
  focus: string;
  /** Text of a system message task (task type 'message'). */
  messageText: string;
  keywords: string[];
  targets: AgentScheduleTarget[];
  prompt: string;
  kind: RecurrenceKind;
  /** Wall-clock `YYYY-MM-DDTHH:mm` in `timezone`. */
  onceAt: string;
  time: string;
  days: number[];
  everyMinutes: string;
  anchorAt: string;
  cron: string;
  windowMode: AgentScheduleWindow['mode'];
  lookbackMinutes: string;
  deliveryMode: 'primary_admin' | 'record_only' | 'line_target';
  deliveryTarget: AgentScheduleSendTarget | null;
  provider: 'codex' | 'claude';
  timezone: string;
  /** Random start delay of 0..5 minutes after the nominal time. */
  jitterMinutes: number;
  enabled: boolean;
};
export type FormError = { key: ScheduleCopyKey; values?: Record<string, unknown> };
export type FormErrors = Partial<Record<'title' | 'prompt' | 'messageText' | 'targets' | 'keywords' | 'focus' | 'recurrence' | 'window' | 'delivery' | 'timezone', FormError>>;

const dateTimeParts = (instant: Date, timezone: string) => {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: String(Number(out.hour) % 24).padStart(2, '0'), minute: out.minute!, second: out.second! };
};

/** Wall-clock `YYYY-MM-DDTHH:mm` of an instant in `timezone`. */
export function isoToWall(iso: string | Date, timezone: string): string {
  const p = dateTimeParts(typeof iso === 'string' ? new Date(iso) : iso, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Instant (ISO) of a wall-clock `YYYY-MM-DDTHH:mm` in `timezone`, or null when malformed. */
export function wallToIso(wall: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (!match || !isValidTimeZone(timezone)) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wallMs = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const p = dateTimeParts(new Date(ms), timezone);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
  };
  let guess = wallMs - offsetAt(wallMs);
  guess = wallMs - offsetAt(guess);
  const date = new Date(guess);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Display text `YYYY-MM-DD HH:mm` of an instant in `timezone`. */
export const wallDisplay = (iso: string, timezone: string): string => isoToWall(iso, timezone).replace('T', ' ');

/** `MM/DD HH:mm` of an instant in `timezone`; `YYYY/MM/DD HH:mm` when it is not in the current year. */
export function shortWall(iso: string, timezone: string, now: Date = new Date()): string {
  const wall = wallDisplay(iso, timezone);
  const display = wall.slice(0, 4) === wallDisplay(now.toISOString(), timezone).slice(0, 4) ? wall.slice(5) : wall;
  return display.replace(/-/g, '/');
}

export function defaultFormState(provider: 'codex' | 'claude', now = new Date()): ScheduleFormState {
  const timezone = AGENT_SCHEDULE_DEFAULT_TIMEZONE;
  const nextHour = new Date(Math.ceil((now.getTime() + 60_000) / 3_600_000) * 3_600_000);
  return {
    title: '', taskType: 'custom', focus: '', messageText: '', keywords: [], targets: [], prompt: '',
    kind: 'daily', onceAt: isoToWall(nextHour, timezone), time: '09:00', days: [1, 2, 3, 4, 5], everyMinutes: '60',
    anchorAt: isoToWall(now, timezone), cron: '0 9 * * 1-5', windowMode: 'since_last_run', lookbackMinutes: '1440',
    deliveryMode: 'primary_admin', deliveryTarget: null, provider, timezone, jitterMinutes: AGENT_SCHEDULE_JITTER_MAX_MINUTES, enabled: true,
  };
}

export function formStateFromSchedule(schedule: AgentSchedule): ScheduleFormState {
  const base = defaultFormState(schedule.provider);
  const next: ScheduleFormState = {
    ...base, title: schedule.title, prompt: schedule.prompt, provider: schedule.provider, timezone: schedule.timezone,
    targets: schedule.targets.map((target) => ({ ...target })), taskType: schedule.task.type, enabled: schedule.enabled, jitterMinutes: schedule.jitterMinutes,
    kind: schedule.recurrence.kind,
    windowMode: schedule.window.mode, lookbackMinutes: schedule.window.mode === 'lookback' ? String(schedule.window.minutes) : base.lookbackMinutes,
    deliveryMode: schedule.delivery.mode, deliveryTarget: schedule.delivery.mode === 'line_target' ? { ...schedule.delivery.target } : null,
  };
  if (schedule.task.type === 'summary') next.focus = schedule.task.focus ?? '';
  if (schedule.task.type === 'message') next.messageText = schedule.task.text;
  if (schedule.task.type === 'keyword_digest') next.keywords = [...schedule.task.keywords];
  const recurrence = schedule.recurrence;
  if (recurrence.kind === 'once') next.onceAt = isoToWall(recurrence.at, schedule.timezone);
  else if (recurrence.kind === 'daily') next.time = recurrence.time;
  else if (recurrence.kind === 'weekly') { next.time = recurrence.time; next.days = [...recurrence.days].sort((a, b) => a - b); }
  else if (recurrence.kind === 'interval') { next.everyMinutes = String(recurrence.everyMinutes); next.anchorAt = isoToWall(recurrence.anchorAt, schedule.timezone); }
  else next.cron = recurrence.expression;
  return next;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Recurrence of the form, or a field error. Mirrors AgentScheduleRecurrenceSchema. */
export function recurrenceFromForm(form: ScheduleFormState): { recurrence: AgentScheduleRecurrence } | { error: FormError } {
  if (!isValidTimeZone(form.timezone)) return { error: { key: 'errTimezone' } };
  switch (form.kind) {
    case 'once': {
      const at = wallToIso(form.onceAt, form.timezone);
      return at ? { recurrence: { kind: 'once', at } } : { error: { key: 'errDateTime' } };
    }
    case 'daily':
      return TIME_PATTERN.test(form.time) ? { recurrence: { kind: 'daily', time: form.time } } : { error: { key: 'errTime' } };
    case 'weekly':
      if (!TIME_PATTERN.test(form.time)) return { error: { key: 'errTime' } };
      if (form.days.length === 0) return { error: { key: 'errDays' } };
      return { recurrence: { kind: 'weekly', days: [...new Set(form.days)].sort((a, b) => a - b), time: form.time } };
    case 'interval': {
      const everyMinutes = Number(form.everyMinutes);
      if (!/^\d+$/.test(form.everyMinutes.trim()) || everyMinutes < AGENT_SCHEDULE_INTERVAL_MIN_MINUTES || everyMinutes > AGENT_SCHEDULE_INTERVAL_MAX_MINUTES) {
        return { error: { key: 'errMinutes', values: { arg0: AGENT_SCHEDULE_INTERVAL_MIN_MINUTES, arg1: AGENT_SCHEDULE_INTERVAL_MAX_MINUTES } } };
      }
      const anchorAt = wallToIso(form.anchorAt, form.timezone);
      return anchorAt ? { recurrence: { kind: 'interval', everyMinutes, anchorAt } } : { error: { key: 'errAnchor' } };
    }
    case 'cron': {
      const expression = form.cron.trim();
      const result = validateCron(expression);
      return result.valid ? { recurrence: { kind: 'cron', expression } } : { error: { key: 'errCron', values: { arg0: result.reason } } };
    }
  }
}

/** Create input of the form, or per-field errors. Mirrors AgentScheduleCreateInputSchema and its cross-field rules. */
export function buildScheduleInput(form: ScheduleFormState): { input: AgentScheduleCreateInput; errors?: undefined } | { input?: undefined; errors: FormErrors } {
  const errors: FormErrors = {};
  const title = form.title.trim();
  if (!title) errors.title = { key: 'errTitleRequired' };
  else if (title.length > AGENT_SCHEDULE_TITLE_MAX) errors.title = { key: 'errTitleTooLong' };
  const isMessage = form.taskType === 'message';
  // A system message uses only its text: no prompt, no chats to read, no time range, and always goes to LINE.
  const prompt = isMessage ? '' : form.prompt.trim();
  const messageText = form.messageText.trim();
  if (isMessage) {
    if (!messageText) errors.messageText = { key: 'errMessageRequired' };
    else if (messageText.length > AGENT_SCHEDULE_MESSAGE_MAX) errors.messageText = { key: 'errMessageTooLong' };
  } else if (prompt.length > AGENT_SCHEDULE_PROMPT_MAX) errors.prompt = { key: 'errPromptTooLong' };
  else if (form.taskType === 'custom' && !prompt) errors.prompt = { key: 'errPromptRequired' };
  if (!isMessage && form.taskType !== 'custom' && form.targets.length === 0) errors.targets = { key: 'errTargetsRequired' };
  const focus = form.focus.trim();
  if (form.taskType === 'summary' && focus.length > AGENT_SCHEDULE_FOCUS_MAX) errors.focus = { key: 'errFocusTooLong' };
  if (form.taskType === 'keyword_digest' && form.keywords.length === 0) errors.keywords = { key: 'errKeywordsRequired' };
  if (!isValidTimeZone(form.timezone)) errors.timezone = { key: 'errTimezone' };
  const recurrence = recurrenceFromForm(form);
  if ('error' in recurrence && !errors.timezone) errors.recurrence = recurrence.error;
  let window: AgentScheduleWindow = { mode: 'since_last_run' };
  if (!isMessage && form.windowMode === 'lookback') {
    const minutes = Number(form.lookbackMinutes);
    if (!/^\d+$/.test(form.lookbackMinutes.trim()) || minutes < AGENT_SCHEDULE_LOOKBACK_MIN_MINUTES || minutes > AGENT_SCHEDULE_LOOKBACK_MAX_MINUTES) {
      errors.window = { key: 'errMinutes', values: { arg0: AGENT_SCHEDULE_LOOKBACK_MIN_MINUTES, arg1: AGENT_SCHEDULE_LOOKBACK_MAX_MINUTES } };
    } else window = { mode: 'lookback', minutes };
  }
  if (form.deliveryMode === 'line_target' && !form.deliveryTarget) errors.delivery = { key: 'errDeliveryTarget' };
  if (Object.keys(errors).length > 0 || 'error' in recurrence) return { errors };
  const task: AgentScheduleTask = form.taskType === 'custom' ? { type: 'custom' }
    : form.taskType === 'message' ? { type: 'message', text: messageText }
    : form.taskType === 'summary' ? (focus ? { type: 'summary', focus } : { type: 'summary' })
      : { type: 'keyword_digest', keywords: form.keywords };
  return {
    input: {
      title, prompt, provider: form.provider, recurrence: recurrence.recurrence, timezone: form.timezone, targets: isMessage ? [] : form.targets,
      task, window,
      delivery: form.deliveryMode === 'line_target' && form.deliveryTarget ? { mode: 'line_target', target: form.deliveryTarget }
        : form.deliveryMode === 'record_only' && !isMessage ? { mode: 'record_only' } : { mode: 'primary_admin' },
      jitterMinutes: Math.max(0, Math.min(AGENT_SCHEDULE_JITTER_MAX_MINUTES, Math.floor(form.jitterMinutes))),
      enabled: form.enabled,
    },
  };
}

/** Next fire time of the form's recurrence (strictly after now), or null. */
export function previewNextFire(form: ScheduleFormState, now = new Date()): Date | null {
  const recurrence = recurrenceFromForm(form);
  return 'recurrence' in recurrence ? nextFireAfter(recurrence.recurrence, form.timezone, now) : null;
}

export const targetKeyOf = scheduleTargetKey;
export { AGENT_SCHEDULE_JITTER_MAX_MINUTES, AGENT_SCHEDULE_KEYWORDS_MAX, AGENT_SCHEDULE_KEYWORD_MAX, AGENT_SCHEDULE_MAX_TARGETS, AGENT_SCHEDULE_MESSAGE_MAX, AGENT_SCHEDULE_PROMPT_MAX, AGENT_SCHEDULE_TITLE_MAX };
