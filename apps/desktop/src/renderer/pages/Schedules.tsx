import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_SCHEDULE_DEFAULT_TIMEZONE, AGENT_SCHEDULE_MAX_ENABLED, type AgentSchedule, type AgentScheduleCreateInput, type AgentScheduleRun, type AgentScheduleRunOutcome, type ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { scheduleTextFor, type ScheduleCopyKey } from '../../desktop-schedule-copy.js';
import { shortWall, wallDisplay } from '../scheduleForm.js';
import { describeLlmRules } from '../scheduleRules.js';
import { ScheduleForm, type ScheduleFormResult } from './ScheduleForm.js';

const OUTCOME_KEYS: Record<AgentScheduleRunOutcome, ScheduleCopyKey> = {
  submitting: 'outcomeSubmitting', submitted: 'outcomeSubmitted', missed: 'outcomeMissed', skipped_overlap: 'outcomeSkippedOverlap', failed: 'outcomeFailed',
  sent: 'outcomeSent', send_failed: 'outcomeSendFailed', send_unknown: 'outcomeSendUnknown', no_messages: 'outcomeNoMessages',
};
const TASK_KEYS = { custom: 'taskCustom', summary: 'taskSummary', keyword_digest: 'taskKeywordDigest', message: 'taskMessage', new_messages: 'taskNewMessages' } as const satisfies Record<AgentSchedule['task']['type'], ScheduleCopyKey>;
const EXECUTION_KEYS = { program: 'kindProgram', agent: 'kindAgent' } as const satisfies Record<AgentSchedule['execution'], ScheduleCopyKey>;
const DAY_KEYS = ['day0', 'day1', 'day2', 'day3', 'day4', 'day5', 'day6'] as const;
const ERROR_KEYS: Record<string, ScheduleCopyKey> = {
  SCHEDULE_LIMIT: 'errLimit', SCHEDULE_NO_FUTURE_TIME: 'errNoFutureTime', SCHEDULE_NOT_FOUND: 'errNotFound', SCHEDULE_INVALID: 'errInvalid', SCHEDULE_INVALID_TARGET: 'errInvalidTarget',
};
const RELOAD_DEBOUNCE_MS = 150;
const RUNS_LIMIT = 5;

type Text = (key: ScheduleCopyKey, values?: Record<string, unknown>) => string;
type Result = Awaited<ReturnType<DesktopApi['createAgentSchedule']>>;

export function describeRecurrence(schedule: AgentSchedule, text: Text): string {
  const recurrence = schedule.recurrence;
  switch (recurrence.kind) {
    case 'once': return text('recurrenceOnce', { arg0: wallDisplay(recurrence.at, schedule.timezone) });
    case 'daily': return text('recurrenceDaily', { arg0: recurrence.time });
    case 'weekly': return text('recurrenceWeekly', { arg0: [...recurrence.days].sort((a, b) => a - b).map((day) => text(DAY_KEYS[day]!)).join(text('listSeparator')), arg1: recurrence.time });
    case 'interval': return text('recurrenceInterval', { arg0: recurrence.everyMinutes });
    case 'cron': return text('recurrenceCron', { arg0: recurrence.expression });
  }
}

/** The single datetime of the list: the next fire when there is one, else the last fire (`past`), else a dash. */
export function describeRunAt(schedule: AgentSchedule, now: Date = new Date()): { text: string; past: boolean } {
  const zone = schedule.timezone === AGENT_SCHEDULE_DEFAULT_TIMEZONE ? '' : ` (${schedule.timezone})`;
  const short = (iso: string) => shortWall(iso, schedule.timezone, now) + zone;
  if (schedule.enabled && schedule.nextFireAt) return { text: short(schedule.nextFireAt), past: false };
  if (schedule.lastFireAt) return { text: short(schedule.lastFireAt), past: true };
  return { text: '—', past: false };
}

export function Schedules({ api, defaultProvider, providers, headingRef, onNotice }: {
  api: DesktopApi; defaultProvider: 'codex' | 'claude'; providers?: readonly ProviderStatus[]; headingRef: React.RefObject<HTMLHeadingElement | null>; onNotice?: (message: string) => void;
}) {
  const locale = useDesktopLocale();
  const text: Text = useCallback((key, values) => scheduleTextFor(locale, key, values), [locale]);
  const [schedules, setSchedules] = useState<AgentSchedule[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<{ scheduleId: string; rows: AgentScheduleRun[] | null; failed: boolean } | null>(null);
  const [editing, setEditing] = useState<AgentSchedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AgentSchedule | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [replyView, setReplyView] = useState<{ content: string } | null>(null);
  const [busyReplies, setBusyReplies] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const loadToken = useRef(0);
  const runsToken = useRef(0);
  const expandedRef = useRef<string | null>(null);
  const reloadTimer = useRef<number | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  expandedRef.current = expanded;
  const notify = (message: string) => { if (onNotice) onNotice(message); else setNotice(message); };

  const loadRuns = useCallback(async (scheduleId: string) => {
    const token = ++runsToken.current;
    try {
      const rows = await api.listAgentScheduleRuns(scheduleId, RUNS_LIMIT);
      if (runsToken.current === token) setRuns({ scheduleId, rows, failed: false });
    } catch {
      if (runsToken.current === token) setRuns({ scheduleId, rows: null, failed: true });
    }
  }, [api]);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    try {
      const rows = await api.listAgentSchedules();
      if (loadToken.current !== token) return;
      setSchedules(rows); setLoadFailed(false);
      const open = expandedRef.current;
      if (open) { if (rows.some((row) => row.scheduleId === open)) void loadRuns(open); else { setExpanded(null); setRuns(null); } }
    } catch {
      if (loadToken.current === token) setLoadFailed(true);
    }
  }, [api, loadRuns]);

  useEffect(() => {
    void load();
    const remove = api.onEvent((event) => {
      if (event.type !== 'agentSchedulesChanged') return;
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; void load(); }, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      loadToken.current++; runsToken.current++;
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      if (typeof remove === 'function') remove();
    };
  }, [api, load]);

  useEffect(() => { if (deleting) deleteCancel.current?.focus(); }, [deleting]);
  const replyClose = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (replyView) replyClose.current?.focus(); }, [replyView]);

  const restoreFocus = () => { const element = trigger.current; window.setTimeout(() => element?.focus(), 0); };
  const openEditor = (target: AgentSchedule | 'new', element: HTMLElement) => {
    trigger.current = element; setEditing(target);
    if (target !== 'new') { setExpanded(target.scheduleId); setRuns(null); void loadRuns(target.scheduleId); }
  };
  const closeEditor = () => { setEditing(null); setExpanded(null); setRuns(null); runsToken.current++; restoreFocus(); };

  const errorMessage = (result: Result, fallback: ScheduleCopyKey): string => {
    if (result.type !== 'error') return '';
    const key = ERROR_KEYS[result.code];
    return key ? text(key, { arg0: AGENT_SCHEDULE_MAX_ENABLED }) : text(fallback);
  };

  async function save(input: AgentScheduleCreateInput): Promise<ScheduleFormResult> {
    const target = editing;
    let result: Result;
    try {
      result = target && target !== 'new' ? await api.updateAgentSchedule(target.scheduleId, input) : await api.createAgentSchedule(input);
    } catch { return { ok: false, message: text('errSaveFailed') }; }
    if (result.type === 'error') return { ok: false, message: errorMessage(result, 'errSaveFailed') };
    setEditing(null); setExpanded(null); setRuns(null); runsToken.current++; restoreFocus();
    void load();
    return { ok: true };
  }

  async function confirmDelete() {
    const target = deleting;
    if (!target || busyIds.has(target.scheduleId)) return;
    setBusyIds((current) => new Set(current).add(target.scheduleId)); setDeleteError('');
    try {
      const result = await api.deleteAgentSchedule(target.scheduleId);
      if (result.type === 'error' && result.code !== 'SCHEDULE_NOT_FOUND') { setDeleteError(errorMessage(result, 'errDeleteFailed')); return; }
      setDeleting(null); setEditing(null); setExpanded(null); setRuns(null); restoreFocus();
      if (expandedRef.current === target.scheduleId) { setExpanded(null); setRuns(null); }
      void load();
    } catch { setDeleteError(text('errDeleteFailed')); }
    finally { setBusyIds((current) => { const next = new Set(current); next.delete(target.scheduleId); return next; }); }
  }

  const outcomeText = (outcome: AgentScheduleRunOutcome) => text(OUTCOME_KEYS[outcome]);
  const outcomeDot = (outcome: AgentScheduleRunOutcome) => outcome === 'submitted' || outcome === 'sent' ? 'ready' : outcome === 'failed' || outcome === 'send_failed' ? 'stopped' : '';

  /** The full reply of a run's job, read through the same job-events IPC the Jobs page uses. */
  async function openReply(run: AgentScheduleRun, element: HTMLElement) {
    if (!run.jobId || busyReplies.has(run.jobId)) return;
    const jobId = run.jobId;
    trigger.current = element;
    setBusyReplies((current) => new Set(current).add(jobId));
    try {
      const events = await api.getAgentRoomJobEvents(jobId);
      const completed = [...events].reverse().find((event) => event.type === 'completed');
      const failed = [...events].reverse().find((event) => event.type === 'failed');
      const streamed = events.filter((event) => event.type === 'text_delta').map((event) => event.type === 'text_delta' ? event.text : '').join('');
      setReplyView({ content: completed?.type === 'completed' ? completed.finalText : failed?.type === 'failed' ? failed.message : streamed || text('runReplyNone') });
    } catch { notify(text('runReplyLoadFailed')); }
    finally { setBusyReplies((current) => { const next = new Set(current); next.delete(jobId); return next; }); }
  }
  const timeTitle = (schedule: AgentSchedule) => [`${describeRecurrence(schedule, text)}${zoneSuffix(schedule)}`,
    schedule.enabled && schedule.nextFireAt ? `${text('nextRun')}: ${wallDisplay(schedule.nextFireAt, schedule.timezone)}` : '',
    schedule.lastFireAt ? `${text('lastRun')}: ${wallDisplay(schedule.lastFireAt, schedule.timezone)}` : ''].filter(Boolean).join(' · ');
  const deliveryText = (schedule: AgentSchedule) => schedule.delivery.mode === 'primary_admin' ? text('deliveryPrimaryAdmin')
    : schedule.delivery.mode === 'line_target' ? schedule.delivery.target.title || schedule.delivery.target.chatId : text('deliveryRecordOnlyShort');
  const zoneSuffix = (schedule: AgentSchedule) => schedule.timezone === AGENT_SCHEDULE_DEFAULT_TIMEZONE ? '' : ` (${schedule.timezone})`;
  const recentRuns = (schedule: AgentSchedule) => {
    const runsState = runs?.scheduleId === schedule.scheduleId ? runs : null;
    return <section className="schedule-field schedule-recent" aria-label={text('recentRunsTitle')}>
      <h3 className="schedule-label">{text('recentRunsTitle')}</h3>
      {runsState?.failed && <p className="schedule-error" role="alert">{text('runsLoadFailed')}</p>}
      {runsState?.rows && runsState.rows.length === 0 && <p className="schedule-hint">{text('recentRunsEmpty')}</p>}
      {runsState?.rows && runsState.rows.length > 0 && <ul className="schedule-run-list">{runsState.rows.map((run) => <li key={run.runId}>
        <time dateTime={run.scheduledFor}>{shortWall(run.scheduledFor, schedule.timezone)}</time><span aria-hidden="true">·</span><span>{outcomeText(run.outcome)}</span>
        {schedule.task.type !== 'message' && run.jobId && <><span aria-hidden="true">·</span><button type="button" className="schedule-link" disabled={busyReplies.has(run.jobId)} onClick={(event) => void openReply(run, event.currentTarget)}>{text('runViewReply')}</button></>}
      </li>)}</ul>}
    </section>;
  };

    return <div className="page jobs-page schedules-page">
    <header className="page-header compact"><div><span className="eyebrow">{text('eyebrow')}</span>
      <div className="page-title-row"><h1 tabIndex={-1} ref={headingRef}>{text('heading')}</h1><p>{text('intro')}</p></div></div>
      <button type="button" className="primary" onClick={(event) => openEditor('new', event.currentTarget)}>{text('newSchedule')}</button>
    </header>
    <div role="status" aria-live="polite" className="sr-only">{notice}</div>
    <div className="schedules-scroll">
      {schedules === null && !loadFailed && <p className="empty" role="status">{text('loading')}</p>}
      {loadFailed && <p className="schedule-error" role="alert">{text('loadFailed')} <button type="button" onClick={() => void load()}>{text('retry')}</button></p>}
      {schedules !== null && schedules.length === 0 && <div className="panel schedule-empty"><h2>{text('emptyTitle')}</h2><p>{text('emptyBody')}</p></div>}
      {schedules !== null && schedules.length > 0 && <div className="job-table-scroll schedule-table-scroll"><table className="job-table schedule-table" aria-label={text('listLabel')}>
        <colgroup><col /><col style={{ width: 96 }} /><col style={{ width: 120 }} /><col style={{ width: 96 }} /></colgroup>
        <thead><tr>
          <th scope="col">{text('colName')}</th><th scope="col">{text('colTime')}</th><th scope="col">{text('colTarget')}</th><th scope="col">{text('colStatus')}</th>
        </tr></thead>
        <tbody>{schedules.map((schedule) => {
          const runAt = describeRunAt(schedule);
          const delivery = deliveryText(schedule);
          const lastOutcome = schedule.enabled ? schedule.lastOutcome : null;
          const statusTitle = !schedule.enabled ? text('disabledBadge') : lastOutcome ? `${outcomeText(lastOutcome)}${schedule.lastFireAt ? ` · ${wallDisplay(schedule.lastFireAt, schedule.timezone)}` : ''}` : text('statusWaiting');
          const titles = new Map(schedule.targets.map((chat) => [chat.chatId, chat.title]));
          const llmWhen = schedule.execution === 'program' && schedule.mayUseLlm ? describeLlmRules(schedule.task, text, { chatTitle: (id) => titles.get(id) }) : '';
          return <tr key={schedule.scheduleId} className={schedule.enabled ? 'schedule-row-main' : 'schedule-row-main disabled'}
            onClick={(event) => { const button = event.currentTarget.querySelector<HTMLElement>('button.schedule-name-button'); if (button) openEditor(schedule, button); }}>
            <td><div className="schedule-title-line">
              <button type="button" className="schedule-name-button" title={schedule.title} aria-label={text('editSchedule', { arg0: schedule.title })}>{schedule.title}</button>
            </div>
            <div className="schedule-badge-line">
              <span className="badge">{text(TASK_KEYS[schedule.task.type])}</span>
              <span className="badge">{text(EXECUTION_KEYS[schedule.execution])}</span>
              {schedule.execution === 'program' && schedule.mayUseLlm && <span className="badge">{text('llmBadge')}</span>}
            </div>
            {llmWhen && <div className="schedule-sub-line" title={text('llmWhen', { arg0: llmWhen })}>{text('llmWhen', { arg0: llmWhen })}</div>}</td>
            <td className={runAt.past ? 'schedule-time-past' : undefined} title={timeTitle(schedule)}>{runAt.text}</td>
            <td title={delivery}>{delivery}</td>
            <td className="schedule-status" title={statusTitle}>{!schedule.enabled ? <span className="muted">{text('disabledBadge')}</span>
              : lastOutcome ? <span className="schedule-outcome"><span className={`status-dot ${outcomeDot(lastOutcome)}`.trim()} aria-hidden="true" />{outcomeText(lastOutcome)}</span>
                : <span className="muted">{text('statusWaiting')}</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>}
    </div>
    {editing && <ScheduleForm api={api} schedule={editing === 'new' ? null : editing} defaultProvider={defaultProvider} {...(providers ? { providers } : {})} onSubmit={save} onClose={closeEditor}
      {...(editing !== 'new' ? { onDelete: (element: HTMLElement) => { trigger.current = element; setDeleteError(''); setDeleting(editing); }, history: recentRuns(editing) } : {})} />}
    {replyView && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) { setReplyView(null); restoreFocus(); } }}>
      <div className="modal job-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-reply-title"
        onKeyDown={(event) => { if (event.key === 'Escape') { setReplyView(null); restoreFocus(); } }}>
        <div className="job-preview-header"><h2 id="schedule-reply-title">{text('runReplyTitle')}</h2>
          <button type="button" ref={replyClose} className="job-preview-close" aria-label={text('closePreview')} onClick={() => { setReplyView(null); restoreFocus(); }}><span aria-hidden="true">×</span></button></div>
        <div className="job-preview-content">{replyView.content}</div>
      </div>
    </div>}
    {deleting && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) { setDeleting(null); restoreFocus(); } }}>
      <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="schedule-delete-title" aria-describedby="schedule-delete-body"
        onKeyDown={(event) => { if (event.key === 'Escape') { setDeleting(null); restoreFocus(); } }}>
        <h2 id="schedule-delete-title">{text('deleteTitle')}</h2>
        <p id="schedule-delete-body">{text('deleteBody', { arg0: deleting.title })}</p>
        <p role="alert" className="schedule-error">{deleteError}</p>
        <div className="modal-actions">
          <button type="button" ref={deleteCancel} onClick={() => { setDeleting(null); restoreFocus(); }}>{text('cancel')}</button>
          <button type="button" className="primary schedule-danger" disabled={busyIds.has(deleting.scheduleId)} onClick={() => void confirmDelete()}>{text('remove')}</button>
        </div>
      </section>
    </div>}
  </div>;
}
