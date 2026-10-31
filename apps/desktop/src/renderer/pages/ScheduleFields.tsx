import React, { useEffect, useId, useRef, useState } from 'react';
import type { AgentScheduleTarget, AgentScheduleTargetOption } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { ScheduleCopyKey } from '../../desktop-schedule-copy.js';
import { ChatTypeIcon } from '../ChatTypeIcon.js';
import { AGENT_SCHEDULE_KEYWORDS_MAX, AGENT_SCHEDULE_KEYWORD_MAX, targetKeyOf, type FormError } from '../scheduleForm.js';

/** Field components shared by the schedule form and the new_messages rules editor (kept apart so the two files do not import each other). */
export type Text = (key: ScheduleCopyKey, values?: Record<string, unknown>) => string;

export function TargetLabel({ target, text }: { target: AgentScheduleTargetOption | AgentScheduleTarget; text: Text }) {
  const role = 'role' in target ? target.role : undefined;
  return <>
    {target.chatType && <ChatTypeIcon chatType={target.chatType} />}<span>{target.title || target.chatId}</span>
    {role === 'primary_admin' && <span className="badge schedule-admin-badge">{text('adminBadge')}</span>}
  </>;
}

/** Chat search box: nothing is requested or listed until something is typed, then a dropdown offers the matches. */
export function ChatCombobox({ api, text, label, purpose, selected, max, onChange, error, errorId, hint }: {
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

export function KeywordInput({ text, keywords, onChange, error, errorId, pending, onPending, label, commitOnBlur }: {
  text: Text; label?: string | undefined; commitOnBlur?: boolean | undefined; keywords: string[]; onChange: (keywords: string[]) => void; error?: FormError | undefined; errorId: string; pending: string; onPending: (value: string) => void;
}) {
  const inputId = useId();
  const add = () => {
    const keyword = pending.trim().slice(0, AGENT_SCHEDULE_KEYWORD_MAX);
    if (!keyword) return;
    if (!keywords.includes(keyword) && keywords.length < AGENT_SCHEDULE_KEYWORDS_MAX) onChange([...keywords, keyword]);
    onPending('');
  };
  return <div className="schedule-field">
    <label htmlFor={inputId} className="schedule-label">{label ?? text('fieldKeywords')}</label>
    <p className="schedule-hint">{text('keywordsCount', { arg0: keywords.length, arg1: AGENT_SCHEDULE_KEYWORDS_MAX })}</p>
    {keywords.length > 0 && <ul className="schedule-chips">{keywords.map((keyword) => <li key={keyword} className="schedule-chip"><span>{keyword}</span>
      <button type="button" aria-label={text('keywordRemove', { arg0: keyword })} onClick={() => onChange(keywords.filter((item) => item !== keyword))}>×</button></li>)}</ul>}
    <div className="schedule-inline">
      <input name="keyword" autoComplete="off" id={inputId} value={pending} maxLength={AGENT_SCHEDULE_KEYWORD_MAX} placeholder={text('keywordInput')} aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined}
        onChange={(event) => onPending(event.target.value)} onBlur={commitOnBlur ? add : undefined}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <button type="button" onClick={add}>{text('keywordAdd')}</button>
    </div>
    {error && <p id={errorId} role="alert" className="schedule-error">{text(error.key, error.values)}</p>}
  </div>;
}
