import { generatedMessageText, useSafeErrorText, useLocaleFormatters, useDesktopText } from '../desktop-i18n.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentExecutionLevel, AgentExecutionPolicy, AgentToolAllowlistEntry, LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { AgentWhitelistPermissions, errorOf, type PermissionMessage as Message } from './AgentWhitelistPermissions.js';

const levelOrder: AgentExecutionLevel[] = ['read_only', 'workspace_write', 'trust', 'full'];

function executionLevels(text: ReturnType<typeof useDesktopText>): Array<{ value: AgentExecutionLevel; label: string; description: string }> {
  return [
    { value: 'read_only', label: text('readOnly'), description: text('claudeReadWorkspaceFilesAndQueryLineChatsNo') },
    { value: 'workspace_write', label: text('workspaceWrite'), description: text('claudeReadAndWriteWorkspaceFilesShellCommandsShow') },
    { value: 'trust', label: text('trusted'), description: text('claudeWorkspaceWritePlusWebToolsWebfetchWebsearchShell') },
    { value: 'full', label: text('fullAccessDefault'), description: text('claudeRunAllToolsAndCommandsWithoutAskingIncluding') },
  ];
}

export function AgentPermissions({ api, accounts }: { api: DesktopApi; accounts: LineAccountSummary[] }) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const { formatDate } = useLocaleFormatters();
  const conflictMessage = () => desktopText('settingsChangedElsewhereAndHaveBeenReloaded77');
  const EXECUTION_LEVELS = executionLevels(desktopText);
  const defaultAccount = accounts.find((account) => account.productRole === 'AGENT');
  const accountId = defaultAccount?.accountId ?? '';
  const [executionMessage, setExecutionMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [executionPolicy, setExecutionPolicy] = useState<AgentExecutionPolicy | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState('180');
  const [timeoutActionDraft, setTimeoutActionDraft] = useState<'ALLOW' | 'DENY'>('DENY');
  const [timeoutError, setTimeoutError] = useState('');
  const [allowlist, setAllowlist] = useState<AgentToolAllowlistEntry[]>([]);
  const [allowlistMessage, setAllowlistMessage] = useState<Message | null>(null);
  const [allowlistDialogOpen, setAllowlistDialogOpen] = useState(false);
  const allowlistOpenRef = useRef<HTMLButtonElement>(null);
  const allowlistCloseRef = useRef<HTMLButtonElement>(null);
  const allowlistDialogRef = useRef<HTMLElement>(null);
  const allowlistFocusAfterMutation = useRef(false);
  const allowlistDialogWasOpen = useRef(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const policyMutationRef = useRef(false);
  const policyReloadPending = useRef(false);
  const policySeq = useRef(0);
  const allowlistSeq = useRef(0);

  const loadPolicy = useCallback(async (): Promise<boolean> => {
    const seq = ++policySeq.current;
    setPolicyLoading(true);
    try {
      const policy = await api.getAgentExecutionPolicy();
      if (seq !== policySeq.current) return false;
      setExecutionPolicy(policy);
      setTimeoutDraft(String(policy.approvalTimeoutSeconds));
      setTimeoutActionDraft(policy.timeoutAction);
      return true;
    } catch (error) {
      if (seq === policySeq.current) setExecutionMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToLoadAgentExecutionPermissions')) });
      return false;
    } finally { if (seq === policySeq.current) setPolicyLoading(false); }
  }, [api, desktopText, safeErrorText]);

  const loadAllowlist = useCallback(async (): Promise<boolean> => {
    const seq = ++allowlistSeq.current;
    try {
      const entries = await api.listAgentToolAllowlist();
      if (seq !== allowlistSeq.current) return false;
      setAllowlist(entries);
      setAllowlistMessage(null);
      return true;
    } catch (error) {
      if (seq === allowlistSeq.current) setAllowlistMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToLoadPermanentlyAllowedTools')) });
      return false;
    }
  }, [api, desktopText, safeErrorText]);

  useEffect(() => { void loadPolicy(); void loadAllowlist(); }, [loadPolicy, loadAllowlist]);

  useEffect(() => {
    if (allowlistDialogOpen) {
      allowlistDialogWasOpen.current = true;
      allowlistCloseRef.current?.focus();
    } else if (allowlistDialogWasOpen.current) {
      allowlistDialogWasOpen.current = false;
      allowlistOpenRef.current?.focus();
    }
  }, [allowlistDialogOpen]);

  useEffect(() => {
    if (!allowlistDialogOpen || !allowlistFocusAfterMutation.current) return;
    allowlistFocusAfterMutation.current = false;
    const nextRemove = allowlistDialogRef.current?.querySelector<HTMLButtonElement>(desktopText('buttonAriaLabelRemovePermanentlyAllowed'));
    (nextRemove ?? allowlistCloseRef.current)?.focus();
  }, [allowlist, allowlistDialogOpen, allowlistMessage]);

  useEffect(() => {
    if (!allowlistDialogOpen) return;
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setAllowlistDialogOpen(false); return; }
      if (event.key !== 'Tab') return;
      const dialog = allowlistDialogRef.current;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', containFocus);
    return () => document.removeEventListener('keydown', containFocus);
  }, [allowlistDialogOpen]);

  useEffect(() => {
    if (typeof api.onEvent !== 'function') return;
    return api.onEvent((event) => {
      if (event.type !== 'agentExecutionPolicyChanged') return;
      if (policyMutationRef.current) policyReloadPending.current = true;
      else void loadPolicy();
    });
  }, [api, loadPolicy]);

  async function saveExecutionLevel(level: AgentExecutionLevel) {
    if (!executionPolicy || level === executionPolicy.level || policyMutationRef.current) return;
    const target = EXECUTION_LEVELS.find((option) => option.value === level)!;
    if (levelOrder.indexOf(level) > levelOrder.indexOf(executionPolicy.level)
      && !window.confirm(desktopText('allowBroaderAgentPermissionsNNArg0', { arg0: target.description }))) return;
    const previous = executionPolicy;
    policyMutationRef.current = true; setPolicySaving(true); setExecutionMessage(null);
    try {
      const result = await api.setAgentExecutionPolicy({ level, approvalTimeoutSeconds: previous.approvalTimeoutSeconds, timeoutAction: previous.timeoutAction, expectedVersion: previous.version });
      const failure = errorOf(result, safeErrorText);
      if (failure?.code === 'PERMISSION_VERSION_CONFLICT') {
        if (await loadPolicy()) setExecutionMessage({ kind: 'notice', text: desktopText('settingsChangedElsewhereAndHaveBeenReloaded') });
      } else if (failure) {
        setExecutionMessage({ kind: 'error', text: safeErrorText(failure) });
      } else {
        await loadPolicy();
      }
    } catch (error) {
      setExecutionMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToUpdateExecutionLevel')) });
    } finally { policyMutationRef.current = false; setPolicySaving(false); if (policyReloadPending.current) { policyReloadPending.current = false; void loadPolicy(); } }
  }

  async function saveApprovalTimeout() {
    if (!executionPolicy || policyMutationRef.current) return;
    const seconds = Number(timeoutDraft);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) { setTimeoutError(desktopText('enterAWholeNumberFrom10To900')); return; }
    const current = executionPolicy;
    policyMutationRef.current = true; setPolicySaving(true); setExecutionMessage(null); setTimeoutError('');
    try {
      const result = await api.setAgentExecutionPolicy({ level: current.level, approvalTimeoutSeconds: seconds, timeoutAction: timeoutActionDraft, expectedVersion: current.version });
      const failure = errorOf(result, safeErrorText);
      if (failure?.code === 'PERMISSION_VERSION_CONFLICT') { if (await loadPolicy()) setExecutionMessage({ kind: 'notice', text: conflictMessage() }); }
      else if (failure) setExecutionMessage({ kind: 'error', text: safeErrorText(failure) });
      else await loadPolicy();
    } catch (error) { setExecutionMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToSaveApprovalTimeout')) }); }
    finally { policyMutationRef.current = false; setPolicySaving(false); if (policyReloadPending.current) { policyReloadPending.current = false; void loadPolicy(); } }
  }

  async function changeAllowlist(id: string | null) {
    const key = id ?? 'allowlist-clear';
    if (saving.has(key)) return;
    if (id === null && !window.confirm(desktopText('clearAllPermanentlyAllowedTools'))) return;
    markSaving(key, true); setAllowlistMessage(null);
    try {
      const result = id === null ? await api.clearAgentToolAllowlist() : await api.removeAgentToolAllowlistEntry(id);
      const failure = errorOf(result, safeErrorText);
      if (failure) setAllowlistMessage({ kind: 'error', text: safeErrorText(failure) });
      else {
        allowlistFocusAfterMutation.current = true;
        if (await loadAllowlist()) setAllowlistMessage({ kind: 'notice', text: id === null ? desktopText('permanentlyAllowedEntriesCleared') : desktopText('permanentlyAllowedEntryRemoved') });
      }
    } catch (error) {
      setAllowlistMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToUpdatePermanentlyAllowedTools')) });
    } finally { markSaving(key, false); }
  }

  function markSaving(key: string, on: boolean) {
    setSaving((current) => { const next = new Set(current); if (on) next.add(key); else next.delete(key); return next; });
  }

  const executionMessageSlot = <div className="perm-message-slot">{executionMessage && <div className={executionMessage.kind === 'error' ? 'error-banner' : 'inline-notice'} role={executionMessage.kind === 'error' ? 'alert' : 'status'}>{generatedMessageText(executionMessage.text)}</div>}</div>;

  const timeoutSeconds = Number(timeoutDraft);
  const timeoutDraftValid = Number.isInteger(timeoutSeconds) && timeoutSeconds >= 10 && timeoutSeconds <= 900;
  const timeoutDraftChanged = Boolean(executionPolicy && (
    timeoutSeconds !== executionPolicy.approvalTimeoutSeconds || timeoutActionDraft !== executionPolicy.timeoutAction
  ));

  return <div className="perm-card-stack">
    <section className="panel perm-settings perm-execution-card" aria-labelledby="agent-execution-title" aria-busy={policyLoading || policySaving}>
      {executionMessageSlot}
      <h2 className="perm-card-title" id="agent-execution-title">{desktopText('agentExecutionPermissions')}</h2>
      <fieldset className="perm-list perm-execution-levels" role="radiogroup" aria-label={desktopText('agentExecutionPermissionOptions')} disabled={!executionPolicy || policyLoading || policySaving} aria-busy={policyLoading || policySaving}>
        {EXECUTION_LEVELS.map((option) => <label className="perm-row perm-execution-option" key={option.value}>
          <input type="radio" name="agent-execution-level" aria-label={option.label} aria-describedby={`agent-level-description-${option.value}`} value={option.value} checked={executionPolicy?.level === option.value} onChange={() => void saveExecutionLevel(option.value)} />
          <span className="perm-row-copy"><strong>{option.label}</strong><small id={`agent-level-description-${option.value}`}>{option.description}</small></span>
        </label>)}
      </fieldset>
      <div className="perm-timeout"><label htmlFor="agent-approval-timeout">{desktopText('approvalTimeoutSeconds')}</label><input id="agent-approval-timeout" type="number" min={10} max={900} step={1} value={timeoutDraft} disabled={!executionPolicy || policyLoading || policySaving} onChange={(event) => { setTimeoutDraft(event.target.value); setTimeoutError(''); }} />
        <label htmlFor="agent-approval-timeout-action">{desktopText('onTimeout')}</label><select id="agent-approval-timeout-action" aria-label={desktopText('onTimeout')} value={timeoutActionDraft} disabled={!executionPolicy || policyLoading || policySaving} onChange={(event) => setTimeoutActionDraft(event.target.value as 'ALLOW' | 'DENY')}>
          <option value="ALLOW">{desktopText('automaticallyAllow')}</option><option value="DENY">{desktopText('automaticallyDeny')}</option></select>
        <button type="button" disabled={!executionPolicy || policyLoading || policySaving || !timeoutDraftValid || !timeoutDraftChanged} onClick={() => void saveApprovalTimeout()}>{desktopText('save')}</button>
        <button type="button" ref={allowlistOpenRef} className="perm-allowlist-open" aria-haspopup="dialog" onClick={() => setAllowlistDialogOpen(true)}>{desktopText('alwaysAllow')}</button></div>
      {timeoutError && <p role="alert">{timeoutError}</p>}
      {allowlistDialogOpen && <div className="perm-dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setAllowlistDialogOpen(false); }}>
        <section ref={allowlistDialogRef} className="panel perm-allowlist-dialog" role="dialog" aria-modal="true" aria-labelledby="perm-allowlist-title" tabIndex={-1}>
          <div className="perm-allowlist-dialog-header"><h3 id="perm-allowlist-title">{desktopText('alwaysAllow')}</h3><button type="button" ref={allowlistCloseRef} aria-label={desktopText('closePermanentlyAllowedTools')} onClick={() => setAllowlistDialogOpen(false)}>×</button></div>
          {allowlistMessage && <div className={allowlistMessage.kind === 'error' ? 'error-banner' : 'inline-notice'} role={allowlistMessage.kind === 'error' ? 'alert' : 'status'}>{generatedMessageText(allowlistMessage.text)}</div>}
          {allowlist.length === 0 ? <p className="empty">{desktopText('noPermanentlyAllowedEntriesYet')}</p> : <ul className="perm-list" aria-label={desktopText('alwaysAllow')}>
        {allowlist.map((entry) => <li className="perm-row" key={entry.id}>
          <div className="perm-row-copy"><strong>{entry.kind === 'tool' ? desktopText('tool') : desktopText('command')}</strong>{entry.kind === 'bash_command' ? <code className="perm-command">{entry.value}</code> : <span>{entry.value}</span>}<small><time dateTime={entry.createdAt}>{formatDate(new Date(entry.createdAt))}</time></small></div>
          <button type="button" aria-label={desktopText('removePermanentlyAllowedArg0Arg1', { arg0: entry.kind === 'tool' ? desktopText('tool') : desktopText('command'), arg1: entry.value })} disabled={saving.size > 0 || policyLoading || policySaving} onClick={() => void changeAllowlist(entry.id)}>{desktopText('delete')}</button>
        </li>)}
          </ul>}
          <button type="button" disabled={allowlist.length === 0 || saving.size > 0 || policyLoading || policySaving} onClick={() => void changeAllowlist(null)}>{desktopText('clearAll')}</button>
        </section>
      </div>}
    </section>

    <AgentWhitelistPermissions api={api} accountId={accountId} />
  </div>;
}
