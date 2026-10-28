import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentSchedule, AgentScheduleSendTarget, AgentScheduleTarget, AgentScheduleTargetOption, ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { scheduleTextFor, type ScheduleCopyKey } from '../../desktop-schedule-copy.js';
import { ChatTypeIcon } from '../ChatTypeIcon.js';
import {
  AGENT_SCHEDULE_KEYWORDS_MAX, AGENT_SCHEDULE_KEYWORD_MAX, AGENT_SCHEDULE_MAX_TARGETS, AGENT_SCHEDULE_MESSAGE_MAX, AGENT_SCHEDULE_PROMPT_MAX, AGENT_SCHEDULE_TITLE_MAX,
  buildScheduleInput, defaultFormState, formStateFromSchedule, previewNextFire, recurrenceFromForm, shortWall, targetKeyOf,
  type FormError, type FormErrors, type RecurrenceKind, type ScheduleFormState,
} from '../scheduleForm.js';
import { AGENT_ROOM_ID, AGENT_SCHEDULE_DEFAULT_TIMEZONE, AGENT_SCHEDULE_JITTER_MAX_MINUTES, type AgentScheduleCreateInput } from '@line-agent/contracts';
import { readAgentProvider } from '../agentProviderMemory.js';

/** Providers the Agent room can run a job with (signed in, or status not yet known); all of them while the status list is empty. */
export function availableProviders(providers: readonly ProviderStatus[] | undefined): Array<'codex' | 'claude'> {
  if (!providers || providers.length === 0) return ['claude', 'codex'];
  return (['claude', 'codex'] as const).filter((provider) => { const status = providers.find((item) => item.provider === provider)?.status; return status === 'logged_in' || status === 'unknown'; });
}

/** The provider a new schedule starts with: the one the Agent room remembers (when still available), else the app default. Read-only: never writes the room's memory. */
export function roomProvider(defaultProvider: 'codex' | 'claude', providers: readonly ProviderStatus[] | undefined): 'codex' | 'claude' {
  return readAgentProvider({ accountId: AGENT_ROOM_ID, chatType: 'direct', chatId: AGENT_ROOM_ID }, availableProviders(providers)) ?? defaultProvider;
}

const KINDS: RecurrenceKind[] = ['once', 'daily', 'weekly', 'interval', 'cron'];
const KIND_KEYS: Record<RecurrenceKind, ScheduleCopyKey> = { once: 'kindOnce', daily: 'kindDaily', weekly: 'kindWeekly', interval: 'kindInterval', cron: 'kindCron' };
const DAY_KEYS = ['day0', 'day1', 'day2', 'day3', 'day4', 'day5', 'day6'] as const;
const TASKS = [['custom', 'taskCustom', 'taskHintCustom'], ['summary', 'taskSummary', 'taskHintSummary'], ['keyword_digest', 'taskKeywordDigest', 'taskHintKeywordDigest'],
  ['message', 'taskMessage', 'taskHintMessage']] as const;

type Text = (key: ScheduleCopyKey, values?: Record<string, unknown>) => string;

/** The pickers hand out read targets; the delivery picker only ever lists direct, group and room chats. */
const toSendTarget = (target: AgentScheduleTarget): AgentScheduleSendTarget => ({ ...target, chatType: target.chatType === 'group' || target.chatType === 'room' ? target.chatType : 'direct' });

function TargetLabel({ target, text }: { target: AgentScheduleTargetOption | AgentScheduleTarget; text: Text }) {
  const role = 'role' in target ? target.role : undefined;
  return <>
    <ChatTypeIcon chatType={target.chatType} /><span>{target.title || target.chatId}</span>
    {role === 'primary_admin' && <span className="badge schedule-admin-badge">{text('adminBadge')}</span>}
  </>;
}

/** Chat search box: nothing is requested or listed until something is typed, then a dropdown offers the matches. */
function ChatCombobox({ api, text, label, purpose, selected, max, onChange, error, errorId, hint }: {
  api: DesktopApi; text: Text; label: string; purpose: 'read' | 'delivery'; selected: AgentScheduleTarget[]; max: number; onChange: (targets: AgentScheduleTarget[]) => void; error?: FormError | undefined; errorId: string; hint?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentScheduleTargetOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const request = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const searchId = useId();
  const labelId = useId();
  const trimmed = query.trim();
  useEffect(() => {
    const current = ++request.current;
    if (!trimmed) { setResults([]); setState('idle'); return; }
    setState('loading');
    const timer = window.setTimeout(() => {
      api.listAgentScheduleTargets(trimmed, 20, purpose).then((items) => {
        if (request.current !== current) return;
        // The administrator's chat comes first, whatever order the server used.
        setResults([...items.filter((item) => item.role === 'primary_admin'), ...items.filter((item) => item.role !== 'primary_admin')]); setState('idle'); setActive(0);
      }, () => { if (request.current === current) { setResults([]); setState('failed'); } });
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [api, trimmed, purpose]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => { document.removeEventListener('mousedown', close); };
  }, []);
  const selectedKeys = new Set(selected.map(targetKeyOf));
  const options = max === 1 ? results : results.filter((target) => !selectedKeys.has(targetKeyOf(target)));
  const full = max > 1 && selected.length >= max;
  const showPanel = open && trimmed.length > 0;
  const add = (target: AgentScheduleTarget) => {
    if (full) return;
    onChange(max === 1 ? [target] : [...selected, target]);
    setQuery(''); setOpen(false); setActive(0);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return;
      event.preventDefault(); setOpen(true);
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = options[active];
      if (showPanel && target) add(target);
    } else if (event.key === 'Escape' && showPanel) { event.stopPropagation(); setOpen(false); }
  };
  return <div className="schedule-field" role="group" aria-labelledby={labelId}>
    <div className="schedule-label-row">
      <label id={labelId} htmlFor={searchId} className="schedule-label">{label}</label>
      {max > 1 && selected.length > 0 && <span className="schedule-hint" aria-live="polite">{text('targetsSelected', { arg0: selected.length, arg1: max })}</span>}
    </div>
    {selected.length > 0 && <ul className="schedule-chips">{selected.map((target) => <li key={targetKeyOf(target)} className="schedule-chip">
      <TargetLabel target={target} text={text} />
      <button type="button" aria-label={text('targetRemove', { arg0: target.title || target.chatId })} onClick={() => onChange(selected.filter((item) => targetKeyOf(item) !== targetKeyOf(target)))}><span aria-hidden="true">×</span></button>
    </li>)}</ul>}
    <div className="schedule-combobox" ref={box}>
      <input id={searchId} type="search" role="combobox" name="chat-search" aria-expanded={showPanel} aria-controls={showPanel && options.length > 0 ? listId : undefined} aria-autocomplete="list" autoComplete="off"
        aria-activedescendant={showPanel && options[active] ? `${listId}-${active}` : undefined} value={query} placeholder={text('targetsPlaceholder')}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined} />
      {showPanel && <div className="schedule-dropdown">
        {options.length > 0 && <div role="listbox" id={listId} aria-label={text('targetsResults')}>
          {options.map((target, index) => <div key={targetKeyOf(target)} id={`${listId}-${index}`} role="option" aria-selected={index === active} aria-disabled={full || undefined}
            aria-label={text('targetAdd', { arg0: target.title || target.chatId })} className={index === active ? 'schedule-option active' : 'schedule-option'}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => add(target)}><TargetLabel target={target} text={text} /></div>)}
        </div>}
        {options.length === 0 && <p className="schedule-hint schedule-dropdown-status" role="status">{state === 'loading' ? text('targetsSearching') : state === 'failed' ? text('targetsLoadFailed') : text('targetsNoResults')}</p>}
      </div>}
    </div>
    {hint && <p className="schedule-hint">{hint}</p>}
    {error && <p id={errorId} role="alert" className="schedule-error">{text(error.key, error.values)}</p>}
  </div>;
}

function KeywordInput({ text, keywords, onChange, error, errorId, pending, onPending }: {
  text: Text; keywords: string[]; onChange: (keywords: string[]) => void; error?: FormError | undefined; errorId: string; pending: string; onPending: (value: string) => void;
}) {
  const inputId = useId();
  const add = () => {
    const keyword = pending.trim().slice(0, AGENT_SCHEDULE_KEYWORD_MAX);
    if (!keyword) return;
    if (!keywords.includes(keyword) && keywords.length < AGENT_SCHEDULE_KEYWORDS_MAX) onChange([...keywords, keyword]);
    onPending('');
  };
  return <div className="schedule-field">
    <label htmlFor={inputId} className="schedule-label">{text('fieldKeywords')}</label>
    <p className="schedule-hint">{text('keywordsCount', { arg0: keywords.length, arg1: AGENT_SCHEDULE_KEYWORDS_MAX })}</p>
    {keywords.length > 0 && <ul className="schedule-chips">{keywords.map((keyword) => <li key={keyword} className="schedule-chip"><span>{keyword}</span>
      <button type="button" aria-label={text('keywordRemove', { arg0: keyword })} onClick={() => onChange(keywords.filter((item) => item !== keyword))}>×</button></li>)}</ul>}
    <div className="schedule-inline">
      <input name="keyword" autoComplete="off" id={inputId} value={pending} maxLength={AGENT_SCHEDULE_KEYWORD_MAX} placeholder={text('keywordInput')} aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined}
        onChange={(event) => onPending(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <button type="button" onClick={add}>{text('keywordAdd')}</button>
    </div>
    {error && <p id={errorId} role="alert" className="schedule-error">{text(error.key, error.values)}</p>}
  </div>;
}

export type ScheduleFormResult = { ok: true } | { ok: false; message: string };

/** Create/edit dialog. `onSubmit` resolves with the localized server error, if any. */
export function ScheduleForm({ api, schedule, defaultProvider, providers, onSubmit, onClose, onDelete, history }: {
  api: DesktopApi; schedule: AgentSchedule | null; defaultProvider: 'codex' | 'claude'; providers?: readonly ProviderStatus[];
  onSubmit: (input: AgentScheduleCreateInput) => Promise<ScheduleFormResult>; onClose: () => void;
  /** Existing schedule only: asks the page to confirm and delete it. */
  onDelete?: (element: HTMLElement) => void;
  /** Existing schedule only: the run history section. */
  history?: React.ReactNode;
}) {
  const locale = useDesktopLocale();
  const text: Text = (key, values) => scheduleTextFor(locale, key, values);
  const [form, setForm] = useState<ScheduleFormState>(() => schedule ? formStateFromSchedule(schedule) : defaultFormState(roomProvider(defaultProvider, providers)));
  const [pendingKeyword, setPendingKeyword] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const [initialJson] = useState(() => JSON.stringify(form));
  const [failTick, setFailTick] = useState(0);
  const ids = { messageText: useId(), title: useId(), prompt: useId(), focus: useId(), time: useId(), once: useId(), minutes: useId(), anchor: useId(), cron: useId(), lookback: useId(), provider: useId(), jitter: useId(), heading: useId(), enabled: useId() };
  const errorIds = { messageText: useId(), title: useId(), prompt: useId(), targets: useId(), keywords: useId(), focus: useId(), recurrence: useId(), window: useId(), delivery: useId() };
  const set = (patch: Partial<ScheduleFormState>) => { setForm((current) => ({ ...current, ...patch })); setServerError(''); };

  useEffect(() => { titleRef.current?.focus(); }, []);
  // After a failed submit the first invalid field takes focus.
  useEffect(() => { if (failTick > 0) dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }, [failTick]);
  const dirty = JSON.stringify(form) !== initialJson || pendingKeyword.trim().length > 0;
  const trapTab = (event: React.KeyboardEvent) => {
    const root = dialogRef.current;
    if (event.key !== 'Tab' || !root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')).filter((item) => !item.hasAttribute('disabled') && item.getAttribute('tabindex') !== '-1');
    if (items.length === 0) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !root.contains(activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (activeElement === last || !root.contains(activeElement))) { event.preventDefault(); first.focus(); }
  };
  const liveRecurrence = useMemo(() => recurrenceFromForm(form), [form]);
  const next = useMemo(() => previewNextFire(form), [form]);
  // Re-validate after the first submit attempt; a cron error is also shown while typing.
  const current = useMemo(() => buildScheduleInput(form), [form]);
  const visible: FormErrors = attempted ? (current.errors ?? {}) : (form.kind === 'cron' && 'error' in liveRecurrence && form.cron.trim() ? { recurrence: liveRecurrence.error } : {});
  // Only the providers the Agent room offers: signed in (or not yet known). A saved schedule keeps its own provider in the list.
  const providerOptions = (['claude', 'codex'] as const).filter((provider) => provider === form.provider || availableProviders(providers).includes(provider));
  const isMessage = form.taskType === 'message';
  const showsWindow = !isMessage && (form.taskType !== 'custom' || form.targets.length > 0);
  const promptLength = form.prompt.trim().length;
  const messageLength = form.messageText.trim().length;
  const zone = form.timezone === AGENT_SCHEDULE_DEFAULT_TIMEZONE ? '' : form.timezone;
  const nextLine = next ? (zone ? text('nextPreviewZone', { arg0: shortWall(next.toISOString(), form.timezone), arg1: zone }) : text('nextPreview', { arg0: shortWall(next.toISOString(), form.timezone) }))
    : 'recurrence' in liveRecurrence ? text('nextPreviewNone') : '';
  const choose = (value: boolean, label: ScheduleCopyKey, onClick: () => void, extra?: string) => <button type="button" role="radio" aria-checked={value} className={value ? 'active' : undefined} onClick={onClick}>{text(label)}{extra}</button>;
  const onceDate = form.onceAt.slice(0, 10);
  const onceTime = form.onceAt.slice(11, 16);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    let candidate = form;
    if (form.taskType === 'keyword_digest' && pendingKeyword.trim()) {
      const keyword = pendingKeyword.trim().slice(0, AGENT_SCHEDULE_KEYWORD_MAX);
      if (!form.keywords.includes(keyword) && form.keywords.length < AGENT_SCHEDULE_KEYWORDS_MAX) candidate = { ...form, keywords: [...form.keywords, keyword] };
      setForm(candidate); setPendingKeyword('');
    }
    setAttempted(true);
    const built = buildScheduleInput(candidate);
    if (!built.input) { setFailTick((tick) => tick + 1); return; }
    savingRef.current = true; setSaving(true); setServerError('');
    try {
      const result = await onSubmit(built.input);
      if (!result.ok) setServerError(result.message);
    } finally { savingRef.current = false; setSaving(false); }
  }

  const err = (field: keyof FormErrors, id: string) => {
    const error = visible[field];
    return error ? <p id={id} role="alert" className="schedule-error">{text(error.key, error.values)}</p> : null;
  };
  const invalid = (field: keyof FormErrors, id: string) => {
    const hasError = visible[field];
    return hasError ? { 'aria-invalid': true as const, 'aria-describedby': id } : {};
  };

  return <div className="modal-scrim" onMouseDown={(event) => { if (!savingRef.current && !dirty && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal schedule-dialog" role="dialog" aria-modal="true" aria-labelledby={ids.heading}
      onKeyDown={(event) => { if (event.key === 'Escape' && !savingRef.current) { event.stopPropagation(); onClose(); } else trapTab(event); }}>
      <form className="schedule-form" onSubmit={(event) => void submit(event)} noValidate>
        <h2 id={ids.heading} className="schedule-header">{schedule ? text('formEditTitle') : text('formNewTitle')}</h2>
        <div className="schedule-body">
        <div className="schedule-field">
          <label htmlFor={ids.title} className="schedule-label">{text('fieldTitle')}</label>
          <input name="title" autoComplete="off" id={ids.title} ref={titleRef} value={form.title} maxLength={AGENT_SCHEDULE_TITLE_MAX} onChange={(event) => set({ title: event.target.value })} {...invalid('title', errorIds.title)} />
          {err('title', errorIds.title)}
        </div>

        <fieldset className="schedule-field">
          <legend className="schedule-label">{text('fieldTask')}</legend>
          <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldTask')}>
            {TASKS.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={form.taskType === value} className={form.taskType === value ? 'active' : undefined} onClick={() => set({ taskType: value, ...(value === 'message' && form.deliveryMode === 'record_only' ? { deliveryMode: 'primary_admin' as const } : {}) })}>{text(label)}</button>)}
          </div>
          <p className="schedule-hint">{text(TASKS.find(([value]) => value === form.taskType)![2])}</p>
        </fieldset>

        {form.taskType === 'summary' && <div className="schedule-field">
          <label htmlFor={ids.focus} className="schedule-label">{text('fieldFocus')}</label>
          <input name="focus" autoComplete="off" id={ids.focus} value={form.focus} onChange={(event) => set({ focus: event.target.value })} {...invalid('focus', errorIds.focus)} />
          {err('focus', errorIds.focus)}
        </div>}
        {form.taskType === 'keyword_digest' && <KeywordInput text={text} keywords={form.keywords} onChange={(keywords) => set({ keywords })} error={visible.keywords} errorId={errorIds.keywords} pending={pendingKeyword} onPending={setPendingKeyword} />}

        {isMessage && <div className="schedule-field">
          <label htmlFor={ids.messageText} className="schedule-label">{text('fieldMessageText')}</label>
          <textarea name="message" autoComplete="off" id={ids.messageText} value={form.messageText} onChange={(event) => set({ messageText: event.target.value })} {...invalid('messageText', errorIds.messageText)} />
          <p className="schedule-hint">{text('messageHelp')}</p>
          <p className={messageLength > AGENT_SCHEDULE_MESSAGE_MAX ? 'schedule-hint schedule-error' : 'schedule-hint'} aria-live={messageLength > AGENT_SCHEDULE_MESSAGE_MAX ? 'polite' : undefined}>{text('messageCounter', { arg0: messageLength, arg1: AGENT_SCHEDULE_MESSAGE_MAX })}</p>
          {err('messageText', errorIds.messageText)}
        </div>}

        {!isMessage && <ChatCombobox api={api} text={text} label={text('fieldTargets')} purpose="read" selected={form.targets} max={AGENT_SCHEDULE_MAX_TARGETS} onChange={(targets) => set({ targets })} error={visible.targets} errorId={errorIds.targets} hint={form.taskType === 'custom' ? text('targetsOptionalHint') : undefined} />}

        {!isMessage && <div className="schedule-field">
          <label htmlFor={ids.prompt} className="schedule-label">{form.taskType === 'custom' ? text('fieldPromptCustom') : text('fieldPromptExtra')}</label>
          <textarea name="prompt" autoComplete="off" id={ids.prompt} value={form.prompt} onChange={(event) => set({ prompt: event.target.value })} {...invalid('prompt', errorIds.prompt)} />
          <p className={promptLength > AGENT_SCHEDULE_PROMPT_MAX ? 'schedule-hint schedule-error' : 'schedule-hint'} aria-live={promptLength > AGENT_SCHEDULE_PROMPT_MAX ? 'polite' : undefined}>{text('promptCounter', { arg0: promptLength, arg1: AGENT_SCHEDULE_PROMPT_MAX })}</p>
          {err('prompt', errorIds.prompt)}
        </div>}

        <fieldset className="schedule-field">
          <legend className="schedule-label">{text('fieldRecurrence')}</legend>
          <div className="schedule-line">
            <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldRecurrence')}>
              {KINDS.map((kind) => <React.Fragment key={kind}>{choose(form.kind === kind, KIND_KEYS[kind], () => set({ kind }))}</React.Fragment>)}
            </div>
            <div className="schedule-inputs">
              {form.kind === 'once' && <>
                <input name="once-date" autoComplete="off" type="date" aria-label={text('fieldDate')} value={onceDate} onChange={(event) => set({ onceAt: `${event.target.value}T${onceTime}` })} {...invalid('recurrence', errorIds.recurrence)} />
                <input name="once-time" autoComplete="off" type="time" aria-label={text('fieldTime')} value={onceTime} onChange={(event) => set({ onceAt: `${onceDate}T${event.target.value}` })} {...invalid('recurrence', errorIds.recurrence)} />
              </>}
              {form.kind === 'weekly' && <div className="schedule-days" role="group" aria-label={text('fieldDays')}>{DAY_KEYS.map((key, day) => <button key={key} type="button" aria-pressed={form.days.includes(day)} className={form.days.includes(day) ? 'active' : undefined}
                onClick={() => set({ days: form.days.includes(day) ? form.days.filter((item) => item !== day) : [...form.days, day].sort((a, b) => a - b) })}>{text(key)}</button>)}</div>}
              {(form.kind === 'daily' || form.kind === 'weekly') && <input name="time" autoComplete="off" type="time" aria-label={text('fieldTime')} value={form.time} onChange={(event) => set({ time: event.target.value })} {...invalid('recurrence', errorIds.recurrence)} />}
              {form.kind === 'interval' && <><input name="every-minutes" autoComplete="off" type="number" className="schedule-number" inputMode="numeric" min={5} aria-label={text('fieldEveryMinutes')} value={form.everyMinutes} onChange={(event) => set({ everyMinutes: event.target.value })} {...invalid('recurrence', errorIds.recurrence)} /><span className="schedule-hint">{text('minutesSuffix')}</span></>}
              {form.kind === 'cron' && <input name="cron" value={form.cron} spellCheck={false} autoComplete="off" aria-label={text('fieldCron')} className="schedule-mono" onChange={(event) => set({ cron: event.target.value })} {...invalid('recurrence', errorIds.recurrence)} />}
            </div>
          </div>
          {err('recurrence', errorIds.recurrence)}
          <p className="schedule-hint" aria-live="polite">{nextLine}{next && form.jitterMinutes > 0 ? text('nextPreviewJitter', { arg0: form.jitterMinutes }) : ''}</p>
          <div className="schedule-settings">
            <label htmlFor={ids.jitter} className="schedule-label">{text('fieldJitter')}</label>
            <select name="jitter-minutes" id={ids.jitter} value={form.jitterMinutes} onChange={(event) => set({ jitterMinutes: Number(event.target.value) })}>
              {Array.from({ length: AGENT_SCHEDULE_JITTER_MAX_MINUTES + 1 }, (_, minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? text('jitterNone') : text('jitterUpTo', { arg0: minutes })}</option>)}
            </select>
          </div>
        </fieldset>

        {showsWindow && <fieldset className="schedule-field">
          <legend className="schedule-label">{text('fieldWindow')}</legend>
          <div className="schedule-line">
            <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldWindow')}>
              {choose(form.windowMode === 'since_last_run', 'windowSinceLastRun', () => set({ windowMode: 'since_last_run' }))}
              {choose(form.windowMode === 'lookback', 'windowLookback', () => set({ windowMode: 'lookback' }))}
            </div>
            {form.windowMode === 'lookback' && <div className="schedule-inputs"><input name="lookback-minutes" autoComplete="off" type="number" className="schedule-number" inputMode="numeric" min={5} aria-label={text('fieldLookback')} value={form.lookbackMinutes} onChange={(event) => set({ lookbackMinutes: event.target.value })} {...invalid('window', errorIds.window)} /><span className="schedule-hint">{text('minutesSuffix')}</span></div>}
          </div>
          {err('window', errorIds.window)}
        </fieldset>}

        <fieldset className="schedule-field">
          <legend className="schedule-label">{text('fieldDelivery')}</legend>
          <div className="segmented schedule-segmented" role="radiogroup" aria-label={text('fieldDelivery')}>
            {choose(form.deliveryMode === 'primary_admin', 'deliveryOptionPrimaryAdmin', () => set({ deliveryMode: 'primary_admin' }))}
            {!isMessage && choose(form.deliveryMode === 'record_only', 'deliveryOptionRecordOnly', () => set({ deliveryMode: 'record_only' }))}
            {choose(form.deliveryMode === 'line_target', 'deliveryOptionLine', () => set({ deliveryMode: 'line_target' }))}
          </div>
          {form.deliveryMode === 'line_target' && <ChatCombobox api={api} text={text} label={text('fieldDeliveryTarget')} purpose="delivery" selected={form.deliveryTarget ? [form.deliveryTarget] : []} max={1}
            onChange={(targets) => set({ deliveryTarget: targets[0] ? toSendTarget(targets[0]) : null })} error={visible.delivery} errorId={errorIds.delivery} />}
        </fieldset>

        <div className="schedule-settings">
          {!isMessage && <><label htmlFor={ids.provider} className="schedule-label">{text('fieldProvider')}</label>
            <select name="provider" id={ids.provider} value={form.provider} onChange={(event) => set({ provider: event.target.value as 'codex' | 'claude' })}>{providerOptions.map((provider) => <option key={provider} value={provider}>{provider === 'claude' ? 'Claude' : 'Codex'}</option>)}</select></>}
          <span className="schedule-label" id={ids.enabled}>{text('fieldEnabled')}</span>
          <button type="button" role="switch" aria-checked={form.enabled} aria-labelledby={ids.enabled} className="schedule-switch" onClick={() => set({ enabled: !form.enabled })}><span className="schedule-switch-thumb" /></button>
        </div>

        {history}
        </div>
        <div role="alert" aria-live="assertive" className="schedule-error schedule-server-error">{serverError}</div>
        <div className="modal-actions schedule-footer">
          {onDelete && schedule && <button type="button" className="schedule-delete schedule-delete-left" aria-label={text('removeSchedule', { arg0: schedule.title })} onClick={(event) => onDelete(event.currentTarget)} disabled={saving}>{text('remove')}</button>}
          <button type="button" onClick={onClose} disabled={saving}>{text('cancel')}</button>
          <button type="submit" className="primary" disabled={saving}>{saving ? text('saving') : text('save')}</button>
        </div>
      </form>
    </section>
  </div>;
}
