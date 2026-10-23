import { safeErrorTextFor, desktopTextFor, extraTextFor, useDesktopLocale, useDesktopText } from '../desktop-i18n.js';
import type { Locale } from '../../locale.js';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AGENT_ATTACHMENT_LIMITS, type AgentAttachmentSummary, type AgentEvent, type AgentJobSummary, type AgentProvider, type ConversationKey, type ConversationSummary, type ProviderStatus } from '@line-agent/contracts';
import { ComposerStatus, useComposerStatus } from './ComposerStatus.js';
import { AgentLevelMenu } from './AgentLevelMenu.js';
import type { DesktopApi } from '../../preload/api.js';
import { MarkdownText } from './MarkdownText.js';
import { readAgentProvider, writeAgentProvider } from '../agentProviderMemory.js';
import { AgentApprovalCards } from './AgentApprovalCards.js';
import { AvatarPlaceholder } from '../LineMediaImage.js';
import { formatMessageTime } from './Conversations.js';

const providerName = (provider: AgentProvider) => provider === 'codex' ? 'Codex' : 'Claude';

export function mergeAgentEventStreams(history: AgentEvent[], existing: AgentEvent[]) {
  const encodedHistory = history.map((event) => JSON.stringify(event));
  const encodedExisting = existing.map((event) => JSON.stringify(event));
  const containsSequence = (whole: string[], part: string[]) => part.length <= whole.length
    && Array.from({ length: whole.length - part.length + 1 }, (_, start) => start)
      .some((start) => part.every((event, index) => whole[start + index] === event));
  if (containsSequence(encodedHistory, encodedExisting)) return history;
  if (containsSequence(encodedExisting, encodedHistory)) return existing;
  let commonPrefix = 0;
  while (commonPrefix < encodedHistory.length && commonPrefix < encodedExisting.length && encodedHistory[commonPrefix] === encodedExisting[commonPrefix]) commonPrefix += 1;
  if (commonPrefix === encodedExisting.length) return history;
  if (commonPrefix === encodedHistory.length) return existing;
  for (let overlap = Math.min(encodedHistory.length, encodedExisting.length); overlap > 0; overlap -= 1) {
    const historyStart = encodedHistory.length - overlap;
    if (encodedHistory.slice(historyStart).every((event, index) => event === encodedExisting[index])) {
      return [...history, ...existing.slice(overlap)];
    }
  }
  return [...history, ...existing.slice(commonPrefix)];
}

function providerStatus(locale: Locale, status: ProviderStatus | undefined) {
  if (!status || status.status === 'not_installed') return desktopTextFor(locale, 'notInstalled');
  if (status.status === 'unknown') return desktopTextFor(locale, 'checkedAtRuntime');
  if (status.status === 'logged_out') return desktopTextFor(locale, 'notLoggedIn');
  if (status.status === 'error') return desktopTextFor(locale, 'currentlyUnavailable');
  return desktopTextFor(locale, 'available');
}

/** Latest LINEJS MCP state reported by Main for the job, if any. */
export function mcpStatusLabel(events: AgentEvent[], locale: Locale = 'en'): string | null {
  const latest = [...events].reverse().find((event) => event.type === 'mcp_status');
  return latest?.type === 'mcp_status' ? extraTextFor(locale, latest.status === 'available' ? 'toolsAvailable' : latest.status === 'configured' ? 'toolsConfigured' : 'toolsNotLoaded') : null;
}

export function formatAttachmentSize(bytes: number, locale: Locale = 'en'): string {
  const number = (value: number, fraction = 0) => new Intl.NumberFormat(locale, { minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(value);
  if (bytes < 1024) return `${number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}

interface ComposerAttachment { id: string; file: File; name: string; size: number; image: boolean; previewUrl?: string }

const MB = 1024 * 1024;
const limitText = (locale: Locale) => ({
  count: desktopTextFor(locale, 'upToArg0Files', { arg0: AGENT_ATTACHMENT_LIMITS.maxFiles }),
  file: desktopTextFor(locale, 'maximumArg0MbPerFile', { arg0: AGENT_ATTACHMENT_LIMITS.maxFileBytes / MB }),
  total: desktopTextFor(locale, 'maximumArg0MbInAttachments', { arg0: AGENT_ATTACHMENT_LIMITS.maxTotalBytes / MB }),
});

function readPreview(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    } catch { resolve(undefined); }
  });
}

async function readBytes(file: File, locale: Locale): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error(desktopTextFor(locale, 'unableToReadFile')));
    reader.readAsArrayBuffer(file);
  });
}

/** Files carried by a paste or drop event; a clipboard item without a name (a screenshot) is still a file. */
function eventFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const direct = Array.from(data.files ?? []);
  if (direct.length > 0) return direct;
  return Array.from(data.items ?? []).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

function AttachmentChips({ items, onRemove }: { items: ReadonlyArray<AgentAttachmentSummary & { previewUrl?: string; id?: string }>; onRemove?: (id: string) => void }) {
  const desktopText = useDesktopText();
  const locale = useDesktopLocale();
  if (items.length === 0) return null;
  return <ul className={`attachment-chips${onRemove ? '' : ' readonly'}`} aria-label={onRemove ? desktopText('pendingAttachments') : desktopText('attachments')}>
    {items.map((item, index) => <li className="attachment-chip" key={item.id ?? `${item.name}-${index}`}>
      <span className="attachment-chip-thumb" aria-hidden="true">{item.previewUrl ? <img src={item.previewUrl} alt="" /> : item.kind === 'image' ? desktopText('image149') : desktopText('file')}</span>
      <span className="attachment-chip-meta"><strong title={item.name}>{item.name}</strong><small>{formatAttachmentSize(item.size, locale)}</small></span>
      {onRemove && item.id && <button type="button" className="attachment-chip-remove" aria-label={desktopText('removeArg0', { arg0: item.name })} title={desktopText('removeAttachment')} onClick={() => onRemove(item.id!)}>×</button>}
    </li>)}
  </ul>;
}

/** Backend prose is diagnostic data, never a translation source. */
export function describeSubmitFailure(code: string | undefined, _message: string | undefined, locale: Locale = 'en'): string {
  return safeErrorTextFor(locale, { code }, desktopTextFor(locale, 'agentCouldNotAcceptThisJobTryAgainLater'));
}

function agentReply(locale: Locale, job: AgentJobSummary, events: AgentEvent[]): { text: string; failed: boolean; markdown?: boolean } {
  const completed = [...events].reverse().find((event) => event.type === 'completed');
  if (completed?.type === 'completed') return { text: completed.finalText, failed: false, markdown: true };
  const failure = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'failed' }> => event.type === 'failed');
  if (failure) {
    return { text: safeErrorTextFor(locale, failure, desktopTextFor(locale, 'agentCouldNotCompleteThisJob')), failed: true };
  }
  if (job.status === 'failed') return { text: desktopTextFor(locale, 'agentCouldNotCompleteThisJob'), failed: true };
  if (events.some((event) => event.type === 'cancelled') || job.status === 'cancelled') return { text: desktopTextFor(locale, 'jobCancelled'), failed: false };
  const streamed = events.filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta').map((event) => event.text).join('');
  if (streamed) return { text: streamed, failed: false, markdown: true };
  if (job.status === 'interrupted') return { text: desktopTextFor(locale, 'jobInterrupted'), failed: false };
  return { text: desktopTextFor(locale, 'processing160'), failed: false };
}

export function AgentRoom({ api, conversation, jobs, providers }: {
  api: DesktopApi;
  conversation: ConversationSummary;
  jobs: AgentJobSummary[];
  providers: ProviderStatus[];
}) {
  const locale = useDesktopLocale();
  const desktopText = useDesktopText();
  // The shared Agent room has one stable key (AGENT_ROOM_ID) and belongs to no LINE account;
  // its provider memory is the single account-independent entry `linejs.agentProvider.v1:agent-room`.
  const route: ConversationKey = { accountId: conversation.accountId, chatType: conversation.chatType, chatId: conversation.chatId };
  const routeKey = JSON.stringify([route.accountId, route.chatType, route.chatId]);
  const [provider, setProvider] = useState<AgentProvider>(() => readAgentProvider(route) ?? conversation.defaultProvider);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachmentCounter = useRef(0);
  const clipboardCounter = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const { message: status, setError, setWarning, setNotice, clear: clearStatus } = useComposerStatus();
  const [pendingJobs, setPendingJobs] = useState<AgentJobSummary[]>([]);
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const draftRevision = useRef(0);
  const providerPicked = useRef(false);
  const resetContext = useRef({ routeKey, defaultProvider: conversation.defaultProvider });
  const activeRoute = useRef(routeKey);
  const routeVersion = useRef(0);
  if (activeRoute.current !== routeKey) { activeRoute.current = routeKey; routeVersion.current += 1; }

  useEffect(() => {
    const previous = resetContext.current;
    if (previous.routeKey === routeKey && previous.defaultProvider === conversation.defaultProvider) return;
    resetContext.current = { routeKey, defaultProvider: conversation.defaultProvider };
    // A snapshot refresh may change the default provider; it must not wipe the room
    // state or override the user's explicit Agent selection. Only a route change resets.
    if (previous.routeKey === routeKey) {
      if (!providerPicked.current) setProvider(readAgentProvider(route) ?? conversation.defaultProvider);
      return;
    }
    providerPicked.current = false;
    setProvider(readAgentProvider(route) ?? conversation.defaultProvider);
    setDraft('');
    attachmentsRef.current = [];
    setAttachments([]);
    clearStatus();
    setPendingJobs([]);
    setEvents({});
    setSending(false);
  }, [routeKey, conversation.defaultProvider]);

  const roomJobs = useMemo(() => {
    // Room jobs are the account-less ones; every account sees the same history.
    // LINE jobs appear only when Main stamped them `line_admin_direct` (the shared admin-direct chat); the renderer never decides sharing itself.
    const matching = jobs.filter((job) => job.accountId === null || job.origin === 'line_admin_direct');
    const known = new Set(matching.map((job) => job.jobId));
    return [...matching, ...pendingJobs.filter((job) => !known.has(job.jobId))].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [jobs, pendingJobs, routeKey]);
  const jobSignature = roomJobs.map((job) => job.jobId).join('|');

  // Keep the newest content visible: always on entering a route and after a successful submit,
  // otherwise only while the reader is already within 40px of the bottom.
  const timelineRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const scrolledRoute = useRef('');
  useLayoutEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    if (scrolledRoute.current !== routeKey) { scrolledRoute.current = routeKey; nearBottom.current = true; }
    if (nearBottom.current) node.scrollTop = node.scrollHeight;
  }, [routeKey, roomJobs, events]);

  useEffect(() => {
    let live = true;
    void Promise.all(roomJobs.map(async (job) => [job.jobId, await api.getAgentRoomJobEvents(job.jobId)] as const)).then((loaded) => {
      if (live) setEvents((current) => {
        const next = { ...current };
        for (const [jobId, history] of loaded) next[jobId] = mergeAgentEventStreams(history, current[jobId] ?? []);
        return next;
      });
    }).catch(() => { if (live) setWarning(desktopText('someAgentConversationsAreTemporarilyUnavailable')); });
    return () => { live = false; };
  }, [api, routeKey, jobSignature]);

  useEffect(() => api.onEvent((event) => {
    if (event.type !== 'agentEvent' || !roomJobs.some((job) => job.jobId === event.jobId)) return;
    setEvents((current) => ({ ...current, [event.jobId]: [...(current[event.jobId] ?? []), event.event] }));
    if (event.event.type === 'failed' && event.event.code === 'AUTH_REQUIRED') {
      const failedJob = roomJobs.find((job) => job.jobId === event.jobId);
      if (failedJob) setWarning(desktopText('arg0CliRequiresLoginGoToSettingsAgentLog', { arg0: providerName(failedJob.provider) }));
    }
  }), [api, jobSignature]);

  const selectedStatus = providers.find((item) => item.provider === provider);
  const canSubmit = (selectedStatus?.status === 'logged_in' || selectedStatus?.status === 'unknown');
  const statusText = providerStatus(locale, selectedStatus);

  function openAgentLink(url: string) {
    void api.openExternalUrl(url).then((result) => {
      if (result.type !== 'openExternalUrl') setError(result.type === 'error' ? safeErrorTextFor(locale, result) : desktopText('unableToOpenLink'));
    }).catch((cause) => setError(safeErrorTextFor(locale, cause, desktopText('unableToOpenLink'))));
  }

  function setAttachmentList(next: ComposerAttachment[]) {
    attachmentsRef.current = next;
    setAttachments(next);
  }

  /** Adds as many files as fit the limits; the first limit hit is explained, the rest of the draft is untouched. */
  function addFiles(incoming: File[]) {
    if (incoming.length === 0 || sending) return;
    const accepted: ComposerAttachment[] = [];
    let total = attachmentsRef.current.reduce((sum, item) => sum + item.size, 0);
    let count = attachmentsRef.current.length;
    let problem: string | null = null;
    for (const file of incoming) {
      const limits = limitText(locale);
      if (count >= AGENT_ATTACHMENT_LIMITS.maxFiles) { problem = limits.count; continue; }
      if (file.size > AGENT_ATTACHMENT_LIMITS.maxFileBytes) { problem = limits.file; continue; }
      if (total + file.size > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) { problem = limits.total; continue; }
      const name = file.name || `clipboard-${clipboardCounter.current += 1}.${(file.type.startsWith('image/') ? file.type.slice(6).split(/[+;]/)[0] : '') || 'bin'}`;
      attachmentCounter.current += 1;
      accepted.push({ id: `attachment-${attachmentCounter.current}`, file, name, size: file.size, image: file.type.startsWith('image/') });
      count += 1;
      total += file.size;
    }
    if (accepted.length > 0) {
      setAttachmentList([...attachmentsRef.current, ...accepted]);
      for (const item of accepted) {
        if (!item.image) continue;
        void readPreview(item.file).then((previewUrl) => {
          if (!previewUrl) return;
          setAttachmentList(attachmentsRef.current.map((current) => current.id === item.id ? { ...current, previewUrl } : current));
        });
      }
    }
    if (problem) setError(problem);
  }

  function removeAttachment(id: string) {
    setAttachmentList(attachmentsRef.current.filter((item) => item.id !== id));
  }

  async function submit() {
    const prompt = draft.trim();
    const submittedFiles = attachmentsRef.current;
    if ((!prompt && submittedFiles.length === 0) || sending || !canSubmit) return;
    const submittedRevision = draftRevision.current;
    const submittedRoute = routeKey;
    const submittedVersion = routeVersion.current;
    setSending(true);
    clearStatus();
    try {
      const uploads = await Promise.all(submittedFiles.map(async (item) => ({ name: item.name, bytes: await readBytes(item.file, locale) })));
      const result = await api.submitAgentRoomPrompt({ provider, prompt, ...(uploads.length > 0 ? { attachments: uploads } : {}) });
      if (activeRoute.current !== submittedRoute || routeVersion.current !== submittedVersion) return;
      if (!result.ok) {
        if (result.code === 'AUTH_REQUIRED') {
          setWarning(desktopText('arg0CliRequiresLoginGoToSettingsAgentLog', { arg0: providerName(provider) }));
          return;
        }
        const reason = describeSubmitFailure(result.code, safeErrorTextFor(locale, result), locale);
        setError(reason);
        return;
      }
      if (result.type !== 'submitAgentRoomPrompt') throw new Error(desktopText('agentDidNotAcceptThisJob'));
      nearBottom.current = true;
      setPendingJobs((current) => [...current, { accountId: null, chatType: null, chatId: null, origin: 'agent_room', provider, prompt: prompt || desktopText('pleaseSeeTheAttachments'), jobId: result.jobId, status: 'queued', createdAt: new Date().toISOString(),
        ...(submittedFiles.length > 0 ? { attachments: submittedFiles.map((item): AgentAttachmentSummary => ({ name: item.name, size: item.size, kind: item.image ? 'image' : 'file' })) } : {}) }]);
      if (draftRevision.current === submittedRevision) setDraft('');
      const sent = new Set(submittedFiles.map((item) => item.id));
      setAttachmentList(attachmentsRef.current.filter((item) => !sent.has(item.id)));
      setNotice(desktopText('sentToArg0', { arg0: providerName(provider) }));
    } catch (cause) {
      if (activeRoute.current !== submittedRoute || routeVersion.current !== submittedVersion) return;
      const reason = describeSubmitFailure(undefined, cause instanceof Error ? cause.message : undefined, locale);
      setError(reason);
    } finally {
      if (activeRoute.current === submittedRoute && routeVersion.current === submittedVersion) setSending(false);
    }
  }

  return <>
    <header className="chat-header agent-room-header" data-testid="address-plate">
      <div><h2>{desktopText('agentRoom')}</h2></div>
    </header>
    <div className="timeline agent-timeline" id="timeline" tabIndex={-1} ref={timelineRef} onScroll={(event) => {
      nearBottom.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight <= 40;
    }}>
      {!roomJobs.length && <p className="empty">{desktopText('startAConversationWith')}{providerName(provider)} {desktopText('message')}</p>}
      <div className="timeline-content">
      {roomJobs.map((job, index) => {
        const reply = agentReply(locale, job, events[job.jobId] ?? []);
        const mcpStatus = mcpStatusLabel(events[job.jobId] ?? [], locale);
        const previous = roomJobs[index - 1];
        const dateChanged = !previous || new Date(previous.createdAt).toDateString() !== new Date(job.createdAt).toDateString();
        const time = formatMessageTime(job.createdAt, locale);
        const fromLine = job.origin === 'line_admin_direct';
        // Every job is an own message followed by an incoming reply, so each side always starts a new run (with its tail).
        return <React.Fragment key={job.jobId}>
          {dateChanged && <div className="date-separator">{new Date(job.createdAt).toLocaleDateString(locale)}</div>}
          <div className={`message-row outbound agent-room-row run-start${fromLine ? ' line-admin-direct' : ''}`} data-message-date={job.createdAt}>
            {fromLine && <span className="line-direct-tag" data-testid="line-direct-tag">{desktopText('lineDirectMessages')}</span>}
            <time className="message-time" dateTime={job.createdAt}>{time}</time>
            <article className="message outbound bubble-tail"><div className="message-text">{job.prompt}</div>{job.attachments?.length ? <AttachmentChips items={job.attachments} /> : null}</article>
          </div>
          <div className="message-row inbound agent-room-row has-inbound-identity has-sender-name run-start" data-message-date={job.createdAt}>
            <div className="message-identity"><AvatarPlaceholder kind="person" className="sender-avatar" /><span className="message-sender-name">{providerName(job.provider)}{mcpStatus && <span className="badge" data-testid="mcp-status">{mcpStatus}</span>}</span></div>
            <article className="message inbound bubble-tail">{reply.markdown ? <MarkdownText text={reply.text} onOpenUrl={openAgentLink} /> : <div className={reply.failed ? 'message-text agent-failure' : 'message-text'}>{reply.text}</div>}</article>
            <time className="message-time" dateTime={job.createdAt}>{time}</time>
          </div>
        </React.Fragment>;
      })}
      </div>
    </div>
    <AgentApprovalCards api={api} />
    <div className={`composer agent-composer${dragging ? ' dragging-attachment' : ''}`} id="composer" tabIndex={-1} data-testid="agent-composer"
      onDragEnter={(event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={(event) => {
        const dropped = eventFiles(event.dataTransfer);
        setDragging(false);
        if (dropped.length === 0) return;
        event.preventDefault();
        addFiles(dropped);
      }}>
      <AttachmentChips items={attachments.map((item) => ({ id: item.id, name: item.name, size: item.size, kind: item.image ? 'image' : 'file', ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) }))} onRemove={removeAttachment} />
      <label className="sr-only" htmlFor="agent-room-draft">{desktopText('agentMessage')}</label>
      <textarea id="agent-room-draft" aria-label={desktopText('agentMessage')} value={draft} onChange={(event) => { draftRevision.current += 1; setDraft(event.target.value); }}
        onPaste={(event) => {
          // Only clipboard files are taken over; a text-only paste keeps the browser default.
          const pasted = eventFiles(event.clipboardData);
          if (pasted.length === 0) return;
          event.preventDefault();
          addFiles(pasted);
        }}
        onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void submit(); } }} placeholder={desktopText('enterAMessageForArg0', { arg0: providerName(provider) })} />
      <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="agent-room-file-input"
        onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <div className="composer-actions"><span className="composer-actions-hint">{desktopText('ctrlEnterToSendEnterForANewLine')}</span><ComposerStatus message={status} onDismiss={clearStatus} />
        {!canSubmit && <span className="agent-provider-warning" role="status">{providerName(provider)}：{statusText}</span>}
        <select className="agent-provider-select" aria-label="Agent" title={`${providerName(provider)}：${statusText}`} value={provider} onChange={(event) => { providerPicked.current = true; const next = event.target.value as AgentProvider; setProvider(next); writeAgentProvider(route, next); }}>
          <option value="codex">Codex</option><option value="claude">Claude</option>
        </select>
        <AgentLevelMenu api={api} sending={sending} />
        <button type="button" className="attach-button" aria-label={desktopText('attachFiles')} title={desktopText('attachFiles')} disabled={sending} onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
        </button>
        <button className="primary" disabled={!canSubmit || (!draft.trim() && attachments.length === 0) || sending} onClick={() => void submit()}>{sending ? desktopText('sending') : desktopText('send')}</button></div>
    </div>
  </>;
}
