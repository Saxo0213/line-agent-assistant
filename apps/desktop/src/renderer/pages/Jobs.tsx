import { generatedMessageText, useDesktopLocale, useDesktopText, useExtraText, useSafeErrorText } from '../desktop-i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { AgentJobSearchQuery, AgentJobSummary, WritableConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { toWritableConversationKey } from '../writableChatRoute.js';

/** null: a shared Agent room job (no account); a key: a LINE job; undefined: a route that cannot be operated on. */
function jobWritableKey(job: AgentJobSummary): WritableConversationKey | null | undefined {
  if (job.accountId === null || job.chatType === null || job.chatId === null) return null;
  return toWritableConversationKey({ accountId: job.accountId, chatType: job.chatType, chatId: job.chatId }) ?? undefined;
}

export function Jobs({ api, jobs, headingRef, onNotice }: { api: DesktopApi; jobs: AgentJobSummary[]; headingRef: React.RefObject<HTMLHeadingElement | null>; onNotice?: (message: string) => void }) {
  const desktopText = useDesktopText();
  const extraText = useExtraText();
  const safeErrorText = useSafeErrorText();
  const locale = useDesktopLocale();
  const jobStatusLabel = (status: string) => {
    switch (status) {
      case 'queued': return desktopText('queued');
      case 'running': return desktopText('running');
      case 'completed': return desktopText('completed');
      case 'failed': return desktopText('failed');
      case 'cancelled': return desktopText('cancelled');
      case 'interrupted': return desktopText('interrupted');
      default: return desktopText('unknown');
    }
  };
  const [status, setStatus] = useState('');
  const notify = (message: string) => { if (onNotice) onNotice(message); else setStatus(message); };
  const [pendingReplies, setPendingReplies] = useState<Set<string>>(() => new Set());
  const pendingReplyIds = useRef(new Set<string>());
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const previewClose = useRef<HTMLButtonElement>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const [keyword, setKeyword] = useState('');
  const [searchPrompt, setSearchPrompt] = useState(true);
  const [searchReply, setSearchReply] = useState(true);
  const [provider, setProvider] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchRows, setSearchRows] = useState<AgentJobSummary[] | null>(null);
  const [appliedCriteria, setAppliedCriteria] = useState<Omit<AgentJobSearchQuery, 'cursor'> | null>(null);
  const [nextCursor, setNextCursor] = useState<AgentJobSearchQuery['cursor'] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [criteriaError, setCriteriaError] = useState('');
  const generation = useRef(0);

  useEffect(() => { if (preview) previewClose.current?.focus(); }, [preview]);

  function openPreview(title: string, content: string, trigger?: HTMLElement | null) {
    previewTrigger.current = trigger === undefined
      ? document.activeElement instanceof HTMLElement ? document.activeElement : null
      : trigger;
    setPreview({ title, content });
  }

  function closePreview() {
    setPreview(null);
    window.setTimeout(() => previewTrigger.current?.focus(), 0);
  }

  async function openFullReply(job: AgentJobSummary, trigger: HTMLButtonElement) {
    const writableKey = jobWritableKey(job);
    if (writableKey === undefined || pendingReplyIds.current.has(job.jobId)) return;
    pendingReplyIds.current.add(job.jobId);
    setPendingReplies(new Set(pendingReplyIds.current));
    try {
      const items = writableKey === null ? await api.getAgentRoomJobEvents(job.jobId) : await api.getJobEvents(writableKey, job.jobId);
      const completed = [...items].reverse().find((item) => item.type === 'completed');
      const failed = [...items].reverse().find((item) => item.type === 'failed');
      const streamed = items.filter((item) => item.type === 'text_delta').map((item) => item.text).join('');
      const summary = completed?.type === 'completed' ? completed.finalText
        : failed?.type === 'failed' ? safeErrorText(failed, desktopText('agentCouldNotCompleteThisJob'))
          : streamed || desktopText('noReplyAvailableYet');
      openPreview(desktopText('replyContent'), summary, trigger);
    } catch { notify(desktopText('unableToLoadAgentOutput')); }
    finally {
      pendingReplyIds.current.delete(job.jobId);
      setPendingReplies(new Set(pendingReplyIds.current));
    }
  }

  function replyPlaceholder(job: AgentJobSummary): string {
    switch (job.status) {
      case 'queued': return desktopText('waitingToRun');
      case 'running': return desktopText('running');
      case 'failed': return desktopText('jobFailedNoReplyAvailable');
      case 'cancelled': return desktopText('jobCancelledNoReplyAvailable');
      case 'interrupted': return desktopText('jobInterruptedNoReplyAvailable');
      case 'completed': return desktopText('noReplyYet');
    }
  }

  function localDayBoundary(date: string, addDays = 0): string | undefined {
    if (!date) return undefined;
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year!, month! - 1, day! + addDays).toISOString();
  }

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanKeyword = keyword.trim();
    if (cleanKeyword && !searchPrompt && !searchReply) { setCriteriaError(desktopText('selectJobMessagesOrCompletedRepliesToSearch')); return; }
    if (startDate && endDate && startDate > endDate) { setCriteriaError(desktopText('startDateCannotBeAfterEndDate')); return; }
    setCriteriaError('');
    setSearchError('');
    const requestGeneration = ++generation.current;
    setSearchLoading(true);
    const criteria: AgentJobSearchQuery = { ...(cleanKeyword ? { keyword: cleanKeyword } : {}), searchPrompt, searchReply,
      ...(provider ? { provider: provider as 'codex' | 'claude' } : {}), ...(jobStatus ? { status: jobStatus as AgentJobSearchQuery['status'] } : {}),
      ...(startDate ? { createdFrom: localDayBoundary(startDate)! } : {}), ...(endDate ? { createdToExclusive: localDayBoundary(endDate, 1)! } : {}), limit: 50 };
    try {
      const page = await api.searchAgentJobs(criteria);
      if (requestGeneration !== generation.current) return;
      setSearchRows(page.jobs);
      setAppliedCriteria(criteria);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (requestGeneration === generation.current) setSearchError(safeErrorText(error, desktopText('unableToSearchJobHistory')));
    } finally {
      if (requestGeneration === generation.current) setSearchLoading(false);
    }
  }

  async function loadMore() {
    if (!searchRows || !nextCursor || !appliedCriteria || searchLoading) return;
    const requestGeneration = generation.current;
    const cursor = nextCursor;
    setSearchLoading(true);
    setSearchError('');
    const criteria: AgentJobSearchQuery = { ...appliedCriteria, cursor };
    try {
      const page = await api.searchAgentJobs(criteria);
      if (requestGeneration !== generation.current || cursor !== nextCursor) return;
      setSearchRows((current) => current ? [...current, ...page.jobs] : current);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (requestGeneration === generation.current) setSearchError(safeErrorText(error, desktopText('unableToLoadMoreJobs')));
    } finally {
      if (requestGeneration === generation.current) setSearchLoading(false);
    }
  }

  function clearSearch() {
    generation.current += 1;
    setKeyword(''); setSearchPrompt(true); setSearchReply(true); setProvider(''); setJobStatus(''); setStartDate(''); setEndDate('');
    setSearchRows(null); setAppliedCriteria(null); setNextCursor(null); setSearchError(''); setCriteriaError(''); setSearchLoading(false);
  }

  const visibleJobs = searchRows ?? jobs;

  return <div className="page jobs-page"><header className="page-header compact"><div><span className="eyebrow">{extraText('agentQueue')}</span><div className="page-title-row"><h1 tabIndex={-1} ref={headingRef}>{desktopText('jobs')}</h1><p>{desktopText('viewStopOrRetryLocalAgentJobs')}</p></div></div></header>{!onNotice && status && <p role="status" className="system-toast">{generatedMessageText(status)}</p>}
    <form className="panel filter-grid jobs-search-card" aria-label={desktopText('searchJobs')} onSubmit={(event) => void submitSearch(event)}>
      <div className="search-row-main jobs-search-row-main"><label className="jobs-search-provider">{desktopText('assistant')}<select aria-label={desktopText('assistant')} value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">{desktopText('all')}</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label className="jobs-search-keyword">{desktopText('searchMessages')}<input aria-label={desktopText('searchMessages')} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={desktopText('searchJobMessagesOrCompletedReplies')} /></label>
        <div className="button-row"><button type="submit" className="primary">{desktopText('search')}</button><button type="button" onClick={clearSearch}>{desktopText('clear')}</button></div></div>
      <div className="search-row-filters">
        <label className="jobs-search-status">{desktopText('status')}<select aria-label={desktopText('jobStatus')} value={jobStatus} onChange={(event) => setJobStatus(event.target.value)}><option value="">{desktopText('all')}</option>{['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].map((item) => <option key={item} value={item}>{jobStatusLabel(item)}</option>)}</select></label>
        <label>{desktopText('startDate')}<input aria-label={desktopText('startDate')} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>{desktopText('endDate')}<input aria-label={desktopText('endDate')} type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label className="check jobs-search-scope"><input type="checkbox" aria-label={desktopText('searchJobMessages')} checked={searchPrompt} onChange={(event) => setSearchPrompt(event.target.checked)} />{desktopText('jobMessage')}</label>
        <label className="check"><input type="checkbox" aria-label={desktopText('searchCompletedReplies')} checked={searchReply} onChange={(event) => setSearchReply(event.target.checked)} />{desktopText('completedReply')}</label>
      </div>
      {criteriaError && <p role="alert" className="inline-notice">{generatedMessageText(criteriaError)}</p>}
      {searchError && <p role="alert" className="inline-notice">{desktopText('searchFailed')}{generatedMessageText(searchError)}</p>}
      {searchLoading && <p role="status">{desktopText('searchingJobs')}</p>}
    </form>
    <div className="jobs-results-scroll">{visibleJobs.length ? <div className="job-table-scroll"><table className="job-table" aria-label={desktopText('agentJobs')}><thead><tr><th scope="col">{desktopText('who')}</th><th scope="col">{desktopText('message333')}</th><th scope="col">{desktopText('replyPreview')}</th></tr></thead><tbody>{visibleJobs.map((job) => {
      const writableKey = jobWritableKey(job);
      const provider = job.provider === 'codex' ? 'Codex' : 'Claude';
      const createdAt = new Date(job.createdAt);
      const date = createdAt.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
      const time = createdAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
      return <tr key={job.jobId}><td><div className="job-who"><div className="job-provider-line"><strong>{provider}</strong>{' '}<span className="badge">({jobStatusLabel(job.status)})</span></div><span className="job-created-date">{date}</span><time className="job-created-time" dateTime={job.createdAt}>{time}</time></div></td><td><button className="job-summary-button job-message" aria-label={desktopText('readMessageArg0', { arg0: job.prompt })} title={job.prompt} onClick={() => openPreview(desktopText('messageContent'), job.prompt)}>{job.prompt}</button></td><td><div className="job-reply-summary"><div className="job-reply-layout"><div className={`job-reply-text${job.replyPreview ? '' : ' muted'}`}>{job.replyPreview || replyPlaceholder(job)}</div>{writableKey !== undefined && <button type="button" className="job-reply-open" aria-label={desktopText('viewFullReplyArg0', { arg0: provider })} title={desktopText('viewFullReply')} disabled={pendingReplies.has(job.jobId)} onClick={(event) => void openFullReply(job, event.currentTarget)}><Search size={16} aria-hidden="true" /></button>}</div><div className="button-row job-actions">{writableKey !== undefined && <>{job.status === 'running' && <button onClick={() => void (writableKey === null ? api.stopAgentRoomJob(job.jobId) : api.stopJob(writableKey, job.jobId)).then((result) => notify(result.ok ? desktopText('stopRequested') : safeErrorText(result))).catch((error: unknown) => notify(safeErrorText(error)))}>{desktopText('stop')}</button>}{['failed', 'interrupted'].includes(job.status) && <button onClick={() => void (writableKey === null ? api.retryAgentRoomJob(job.jobId) : api.retryJob(writableKey, job.jobId)).then((result) => notify(result.ok ? desktopText('retryRequested') : safeErrorText(result))).catch((error: unknown) => notify(safeErrorText(error)))}>{desktopText('retry')}</button>}</>}</div></div></td></tr>;
    })}</tbody></table></div> : <p className="empty">{searchRows ? desktopText('noMatchingJobs') : desktopText('noAgentJobsYet')}</p>}
    {searchRows && nextCursor && <div className="button-row"><button type="button" onClick={() => void loadMore()} disabled={searchLoading}>{desktopText('loadMore')}</button></div>}</div>
    {preview && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}><div className="modal job-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="job-preview-title" onKeyDown={(event) => { if (event.key === 'Escape') closePreview(); }}><div className="job-preview-header"><h2 id="job-preview-title">{generatedMessageText(preview.title)}</h2><button ref={previewClose} className="job-preview-close" aria-label={desktopText('closePreview')} onClick={closePreview}><span aria-hidden="true">×</span></button></div><div className="job-preview-content">{preview.content}</div></div></div>}
  </div>;
}
