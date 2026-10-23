import { useSafeErrorText, useDesktopText } from '../desktop-i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import type { AgentApprovalDecision, PendingAgentApproval } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';

type Card = PendingAgentApproval & { busy?: boolean; error?: string | undefined };
const titleFor = (tool: string, text: ReturnType<typeof useDesktopText>) => tool === 'Bash' ? text('agentRequestsAShellCommand')
  : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) ? text('agentRequestsAFileWrite') : text('agentRequestsToolArg0', { arg0: tool });

export function AgentApprovalCards({ api }: { api: DesktopApi }) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const decisions: Array<{ label: string; value: AgentApprovalDecision }> = [
    { label: desktopText('allowOnce'), value: 'once' }, { label: desktopText('allowForThisSession'), value: 'session' },
    { label: desktopText('alwaysAllow'), value: 'always' }, { label: desktopText('deny'), value: 'deny' },
  ];
  const [cards, setCards] = useState<Card[]>([]);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycle = useRef(0);
  const mounted = useRef(false);
  const snapshotLoading = useRef(false);
  const terminalIds = useRef<Set<string> | null>(null);

  function showNotice(message: string) {
    if (!mounted.current) return;
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => { setNotice(''); noticeTimer.current = null; }, 5000);
  }

  useEffect(() => {
    let effectMounted = true;
    mounted.current = true;
    ++lifecycle.current;
    const seq = ++sequence.current;
    snapshotLoading.current = true;
    terminalIds.current = new Set<string>();
    const loadSnapshot = async () => {
      try {
        const pending = await api.listPendingAgentApprovals();
        if (!effectMounted || seq !== sequence.current) return;
        const terminalDuringLoad = terminalIds.current;
        setCards((current) => {
          const byId = new Map(current.map((card) => [card.approvalId, card]));
          for (const approval of pending) if (!terminalDuringLoad?.has(approval.approvalId) && !byId.has(approval.approvalId)) byId.set(approval.approvalId, approval);
          return [...byId.values()];
        });
      } catch { /* The live event stream remains usable if the initial snapshot fails. */ }
      finally {
        if (effectMounted && seq === sequence.current) { terminalIds.current = null; snapshotLoading.current = false; }
      }
    };
    void loadSnapshot();
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'agentApprovalRequested') { setNow(Date.now()); setCards((current) => current.some((card) => card.approvalId === event.approval.approvalId) ? current : [...current, event.approval]); }
      if (event.type === 'agentApprovalResolved') {
        if (snapshotLoading.current) terminalIds.current?.add(event.approvalId);
        setCards((current) => current.filter((card) => card.approvalId !== event.approvalId));
        if (event.outcome === 'timeout' || event.outcome === 'cancelled') {
          showNotice(event.outcome === 'timeout' ? desktopText('timedOutAutomaticallyDenied') : desktopText('jobStoppedApprovalCancelled'));
        }
      }
    });
    return () => { effectMounted = false; mounted.current = false; lifecycle.current += 1; sequence.current += 1; snapshotLoading.current = false; terminalIds.current = null; unsubscribe(); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = null; };
  }, [api]);

  useEffect(() => {
    if (!cards.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cards.length > 0]);

  async function decide(card: Card, decision: AgentApprovalDecision) {
    const lifecycleToken = lifecycle.current;
    setCards((current) => current.map((item) => item.approvalId === card.approvalId ? { ...item, busy: true, error: undefined } : item));
    try {
      const result = await api.decideAgentApproval(card.approvalId, decision);
      if (!mounted.current || lifecycle.current !== lifecycleToken) return;
      if (result.type === 'error') {
        setCards((current) => result.code === 'APPROVAL_NOT_PENDING'
          ? current.filter((item) => item.approvalId !== card.approvalId)
          : current.map((item) => item.approvalId === card.approvalId ? { ...item, busy: false, error: safeErrorText(result) } : item));
        if (result.code === 'APPROVAL_NOT_PENDING') {
          if (snapshotLoading.current) terminalIds.current?.add(card.approvalId);
          showNotice(desktopText('thisApprovalIsNoLongerValid'));
        }
      }
    } catch (error) {
      if (!mounted.current || lifecycle.current !== lifecycleToken) return;
      setCards((current) => current.map((item) => item.approvalId === card.approvalId ? { ...item, busy: false, error: safeErrorText(error) } : item));
    }
  }

  return <div className="agent-approval-list" aria-live="polite">
    {cards.map((card) => <section className="agent-approval-card" aria-label={desktopText('agentApprovalRequest')} key={card.approvalId}>
      <h3>{titleFor(card.tool, desktopText)}</h3><pre>{card.summary}</pre>
      <p className="agent-approval-countdown">{desktopText('remaining')}{Math.max(0, Math.ceil((new Date(card.deadline).getTime() - now) / 1000))} {desktopText('seconds')}</p>
      {!card.canRemember && <p>{desktopText('commandsOver2000CharactersCanOnlyBeAllowed')}</p>}
      {card.error && <p role="alert">{card.error}</p>}
      <div className="agent-approval-actions">{decisions.map(({ label, value }) => <button key={value} type="button" disabled={card.busy || (!card.canRemember && (value === 'session' || value === 'always'))} onClick={() => void decide(card, value)}>{label}</button>)}</div>
    </section>)}
    {notice && <p className="agent-approval-notice" role="status">{notice}</p>}
  </div>;
}
