import { generatedMessageText, useSafeErrorText, useLocaleFormatters, useDesktopText } from '../desktop-i18n.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_PERMISSIONS } from '@line-agent/contracts';
import type { AgentExecutionLevel, AgentExecutionPolicy, AgentPermissionsView, AgentPermissionId, AgentPermissionRule, AgentToolAllowlistEntry, EligibleChat, IpcResult, LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';

type Effect = 'ALLOW' | 'DENY';
type Choice = Effect | 'INHERIT';
type Message = { kind: 'notice' | 'error'; text: string };

// Catalog IDs are authorization data; labels and descriptions are desktop-owned copy.
const PERMISSION_COPY = {
  'records.query_current_chat': 'permissionCurrentChat',
  'records.query_all_chats': 'permissionAllChats',
  'chat_folder.read': 'permissionFolderRead',
  'chat_folder.write': 'permissionFolderWrite',
  'agent.local_tools': 'permissionLocalTools',
} as const satisfies Record<AgentPermissionId, string>;

const levelOrder: AgentExecutionLevel[] = ['read_only', 'workspace_write', 'trust', 'full'];

function executionLevels(text: ReturnType<typeof useDesktopText>): Array<{ value: AgentExecutionLevel; label: string; description: string }> {
  return [
    { value: 'read_only', label: text('readOnly'), description: text('claudeReadWorkspaceFilesAndQueryLineChatsNo') },
    { value: 'workspace_write', label: text('workspaceWrite'), description: text('claudeReadAndWriteWorkspaceFilesShellCommandsShow') },
    { value: 'trust', label: text('trusted'), description: text('claudeWorkspaceWritePlusWebToolsWebfetchWebsearchShell') },
    { value: 'full', label: text('fullAccessDefault'), description: text('claudeRunAllToolsAndCommandsWithoutAskingIncluding') },
  ];
}
function errorOf(result: IpcResult, safeErrorText: ReturnType<typeof useSafeErrorText>): { code: string; message: string } | null {
  return result.type === 'error' ? { code: result.code, message: safeErrorText(result) } : null;
}

function Segmented<V extends string>({ label, value, disabled, options, onSelect }: {
  label: string;
  value: V;
  disabled: boolean;
  options: Array<{ value: V; text: string; disabled?: boolean; title?: string; tone: 'deny' | 'inherit' | 'allow' }>;
  onSelect: (value: V) => void;
}) {
  return <div className="perm-segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
      className={`perm-seg perm-seg-${option.tone}${value === option.value ? ' active' : ''}`} title={option.title}
      disabled={disabled || option.disabled} onClick={() => { if (value !== option.value) onSelect(option.value); }}>{option.text}</button>)}
  </div>;
}

export function AgentPermissions({ api, accounts }: { api: DesktopApi; accounts: LineAccountSummary[] }) {
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const { formatDate } = useLocaleFormatters();
  const EFFECT_LABEL: Record<Effect, string> = { ALLOW: desktopText('allow'), DENY: desktopText('deny') };
  const conflictMessage = () => desktopText('settingsChangedElsewhereAndHaveBeenReloaded77');
  const EXECUTION_LEVELS = executionLevels(desktopText);
  const defaultAccount = accounts.find((account) => account.productRole === 'AGENT');
  const accountId = defaultAccount?.accountId ?? '';
  const [view, setView] = useState<AgentPermissionsView | null>(null);
  const [globalDefaults, setGlobalDefaults] = useState<AgentPermissionsView['defaults']>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [executionMessage, setExecutionMessage] = useState<Message | null>(null);
  const [subjectMid, setSubjectMid] = useState('');
  const [scopeMode, setScopeMode] = useState<'group' | 'direct'>('group');
  const [groupKey, setGroupKey] = useState('');
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [revoking, setRevoking] = useState(false);
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
  const requestSeq = useRef(0);
  const revokePendingRef = useRef(false);
  const defaultsSeq = useRef(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;

  const load = useCallback(async (id: string): Promise<AgentPermissionsView | null> => {
    // A load for an account that is no longer selected must not touch state or cancel the current account's load.
    if (id !== accountRef.current) return null;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await api.getAgentPermissions(id);
      if (seq !== requestSeq.current) return null;
      setView(next);
      setGlobalDefaults(next.defaults);
      const nextUsers = next.subjects.filter((s): s is Extract<typeof s, { kind: 'USER' }> => s.kind === 'USER');
      setSubjectMid((current) => current && nextUsers.some((user) => user.mid === current) ? current : nextUsers[0]?.mid ?? '');
      return next;
    } catch (error) {
      if (seq === requestSeq.current) setMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToReadPermissions')) });
      return null;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, desktopText, safeErrorText]);

  const loadGlobalDefaults = useCallback(async (): Promise<boolean> => {
    const seq = ++defaultsSeq.current;
    try {
      const next = await api.getAgentPermissionDefaults();
      if (seq !== defaultsSeq.current) return false;
      setGlobalDefaults(next.rules);
      return true;
    } catch (error) {
      if (seq === defaultsSeq.current) setMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToLoadDefaultsForFutureAgentAccounts')) });
      return false;
    }
  }, [api, desktopText, safeErrorText]);

  useEffect(() => {
    if (!accountId) {
      setView(null);
      void loadGlobalDefaults();
      return () => { defaultsSeq.current += 1; };
    }
    setView(null); setSubjectMid(''); setMessage(null); setSaving(new Set());
    void load(accountId);
    return () => { requestSeq.current += 1; };
  }, [accountId, load, loadGlobalDefaults]);

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

  /** Returns true when the action succeeded for a still-selected account; stale-account results are dropped. */
  async function handleResult(id: string, result: IpcResult): Promise<boolean> {
    if (id !== accountRef.current) return false;
    const failure = errorOf(result, safeErrorText);
    if (!failure) return true;
    if (failure.code === 'PERMISSION_VERSION_CONFLICT') {
      if (await load(id)) setMessage({ kind: 'notice', text: conflictMessage() });
    } else {
      setMessage({ kind: 'error', text: safeErrorText(failure) });
    }
    return false;
  }

  async function savePermission(permission: string, effect: Choice, expectedVersion: number) {
    const useFutureDefault = !accountId && !selectedUser && eligibleUsers.length === 0;
    if (!useFutureDefault && (!selectedUser || !scope)) return;
    const key = `perm:${permission}`;
    const id = accountId;
    markSaving(key, true); setMessage(null);
    try {
      if (useFutureDefault) {
        const result = await api.setAgentPermissionDefault({ permission: permission as AgentPermissionRule['permission'], effect, expectedVersion });
        const failure = errorOf(result, safeErrorText);
        if (failure) {
          if (failure.code === 'PERMISSION_VERSION_CONFLICT') {
            if (await loadGlobalDefaults()) setMessage({ kind: 'notice', text: conflictMessage() });
          } else setMessage({ kind: 'error', text: safeErrorText(failure) });
        } else {
          if (await loadGlobalDefaults()) setMessage({ kind: 'notice', text: desktopText('defaultsForFutureAgentAccountsSaved') });
          if (id) await load(id);
        }
        return;
      }
      const subject = { kind: 'USER' as const, mid: subjectMid };
      const result = await api.setAgentPermission({ accountId: id, subject, ...scope!,
        permission: permission as AgentPermissionRule['permission'], effect, expectedVersion });
      if (await handleResult(id, result)) await load(id);
    } catch (error) {
      if (id === accountRef.current) setMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToSave')) });
    } finally { markSaving(key, false); }
  }

  async function revokeSelectedUser() {
    if (!selectedUser || !accountId || revokePendingRef.current) return;
    const targetMid = selectedUser.mid;
    const scopes = [
      ...(selectedUser.grantScope === 'ACCOUNT' ? [desktopText('allAccountsIncludingDirectChats')] : []),
      ...selectedUser.chatScopes.map((chat) => view?.eligibleChats.find((item) => item.chatType === chat.chatType && item.chatId === chat.chatId)?.title || chat.chatId),
    ];
    const scopeText = scopes.length ? scopes.join('、') : desktopText('currentSelection');
    if (!window.confirm(desktopText('revokeAllAgentAccessForArg0NNscopeArg1', { arg0: selectedUser.displayName || selectedUser.mid, arg1: scopeText }))) return;
    const id = accountId;
    revokePendingRef.current = true;
    setRevoking(true);
    setMessage(null);
    try {
      const result = await api.revokeAgentWhitelistUser(id, selectedUser.mid);
      const failure = errorOf(result, safeErrorText);
      if (failure) {
        setMessage({ kind: 'error', text: safeErrorText(failure) });
        return;
      }
      const refreshed = await load(id);
      if (!refreshed || id !== accountRef.current) return;
      if (refreshed.subjects.some((subject) => subject.kind === 'USER' && subject.mid === targetMid)) {
        setMessage({ kind: 'error', text: desktopText('someGrantsRemainActiveAccessHasNotBeenFully') });
      } else {
        setMessage({ kind: 'notice', text: desktopText('userAccessRevokedArg0', { arg0: scopeText }) });
      }
    } catch (error) {
      if (id === accountRef.current) setMessage({ kind: 'error', text: safeErrorText(error, desktopText('unableToRevokeAgentAccess')) });
    } finally { revokePendingRef.current = false; setRevoking(false); }
  }

  const messageSlot = <div className="perm-message-slot">{message && <div className={message.kind === 'error' ? 'error-banner' : 'inline-notice'} role={message.kind === 'error' ? 'alert' : 'status'}>{generatedMessageText(message.text)}</div>}</div>;
  const executionMessageSlot = <div className="perm-message-slot">{executionMessage && <div className={executionMessage.kind === 'error' ? 'error-banner' : 'inline-notice'} role={executionMessage.kind === 'error' ? 'alert' : 'status'}>{generatedMessageText(executionMessage.text)}</div>}</div>;

  const users = view?.subjects.filter((s): s is Extract<typeof s, { kind: 'USER' }> => s.kind === 'USER') ?? [];
  const rules = view?.rules ?? [];
  const groupChats = (view?.eligibleChats ?? []).filter((chat) => chat.chatType === 'group' || chat.chatType === 'room');
  const selectedGroup = groupChats.find((chat) => `${chat.chatType}:${chat.chatId}` === groupKey) ?? groupChats[0];
  const scope = scopeMode === 'direct' && subjectMid
    ? { chatType: 'direct' as const, chatId: subjectMid }
    : selectedGroup ? { chatType: selectedGroup.chatType, chatId: selectedGroup.chatId } : null;
  const eligibleUsers = scopeMode === 'direct'
    ? users.filter((user) => user.grantScope === 'ACCOUNT')
    : users.filter((user) => user.grantScope === 'ACCOUNT' || user.chatScopes.some((chat) => chat.chatType === selectedGroup?.chatType && chat.chatId === selectedGroup?.chatId));
  const selectedUser = eligibleUsers.find((user) => user.mid === subjectMid) ?? null;
  const catalog = view?.catalog ?? AGENT_PERMISSIONS;
  const timeoutSeconds = Number(timeoutDraft);
  const timeoutDraftValid = Number.isInteger(timeoutSeconds) && timeoutSeconds >= 10 && timeoutSeconds <= 900;
  const timeoutDraftChanged = Boolean(executionPolicy && (
    timeoutSeconds !== executionPolicy.approvalTimeoutSeconds || timeoutActionDraft !== executionPolicy.timeoutAction
  ));
  useEffect(() => {
    if (selectedGroup && groupKey !== `${selectedGroup.chatType}:${selectedGroup.chatId}`) setGroupKey(`${selectedGroup.chatType}:${selectedGroup.chatId}`);
  }, [selectedGroup, groupKey]);
  useEffect(() => {
    if (subjectMid && !eligibleUsers.some((user) => user.mid === subjectMid)) setSubjectMid('');
  }, [eligibleUsers, subjectMid]);
  const ruleOf = (permission: string, mid: string, chatType: string | null, chatId: string | null): AgentPermissionRule | undefined =>
    rules.find((rule) => rule.permission === permission && rule.subject.kind === 'USER' && rule.subject.mid === mid && rule.chatType === chatType && rule.chatId === chatId);
  const globalDefaultOf = (permission: string) => globalDefaults.find((item) => item.permission === permission);
  const fallbackEffect = (permission: string): Effect => {
    const userRule = rules.find((rule) => rule.permission === permission && rule.subject.kind === 'USER' && rule.subject.mid === subjectMid && rule.chatType === null);
    const everyoneRule = rules.find((rule) => rule.permission === permission && rule.subject.kind === 'EVERYONE');
    return userRule?.effect ?? everyoneRule?.effect ?? globalDefaultOf(permission)?.effect ?? catalog.find((entry) => entry.id === permission)?.defaultEffect ?? 'DENY';
  };

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

    <section className="panel perm-settings perm-whitelist-card" aria-labelledby="whitelist-settings-title" aria-busy={loading}>
      <div className="perm-whitelist-header">
        <h2 className="perm-card-title" id="whitelist-settings-title">{desktopText('allowlistPermissions')}</h2>
        <div className="perm-scope-mode" role="radiogroup" aria-label={desktopText('chatScope')}>
          <button type="button" role="radio" aria-checked={scopeMode === 'group'} className={`perm-subject${scopeMode === 'group' ? ' active' : ''}`} onClick={() => setScopeMode('group')}>{desktopText('group')}</button>
          <button type="button" role="radio" aria-checked={scopeMode === 'direct'} className={`perm-subject${scopeMode === 'direct' ? ' active' : ''}`} onClick={() => setScopeMode('direct')}>{desktopText('direct')}</button>
        </div>
      </div>
      {messageSlot}
      <div className="perm-scope-selectors">
        {scopeMode === 'group' && <label className="perm-scope-field">{desktopText('group')}<select aria-label={desktopText('group')} value={selectedGroup ? `${selectedGroup.chatType}:${selectedGroup.chatId}` : ''} disabled={groupChats.length === 0}
          onChange={(event) => { setGroupKey(event.target.value); setSubjectMid(''); }}>
          {groupChats.length === 0 && <option value="">{desktopText('noGroups')}</option>}
          {groupChats.map((chat) => <option key={`${chat.chatType}:${chat.chatId}`} value={`${chat.chatType}:${chat.chatId}`}>{chat.title || chat.chatId}</option>)}
        </select></label>}
        <label className="perm-scope-field">{desktopText('account')}<select aria-label={desktopText('account')} value={selectedUser?.mid ?? ''} disabled={eligibleUsers.length === 0}
          onChange={(event) => setSubjectMid(event.target.value)}>
          <option value="" disabled>{desktopText('selectAnAllowlistedUser')}</option>
          {eligibleUsers.map((user) => <option key={user.mid} value={user.mid}>{user.displayName || user.mid}</option>)}
        </select></label>
        <button type="button" className="perm-revoke-button" disabled={!selectedUser || loading || saving.size > 0 || revoking} onClick={() => void revokeSelectedUser()}>{desktopText('revoke')}</button>
      </div>
      <ul className="perm-list" aria-label={selectedUser ? desktopText('permissionsForArg0', { arg0: selectedUser.displayName }) : desktopText('allowlistPermissions126')}>
        {catalog.map((entry) => {
          const copyKey = PERMISSION_COPY[entry.id];
          const label = desktopText(copyKey);
          const description = desktopText(`${copyKey}Description`);
          const futureDefault = !accountId && !selectedUser && eligibleUsers.length === 0 ? globalDefaultOf(entry.id) : undefined;
          const rule = selectedUser && scope ? ruleOf(entry.id, selectedUser.mid, scope.chatType, scope.chatId) : undefined;
          const inherited = fallbackEffect(entry.id);
          const value: Choice = rule?.effect ?? futureDefault?.effect ?? 'INHERIT';
          const inheritText = selectedUser ? desktopText('inheritArg0', { arg0: EFFECT_LABEL[inherited] }) : desktopText('useSystemDefaultArg0', { arg0: EFFECT_LABEL[catalog.find((item) => item.id === entry.id)?.defaultEffect ?? 'DENY'] });
          return <li className="perm-row" key={entry.id}>
            <div className="perm-row-copy"><strong>{label}</strong><small>{description}</small></div>
            <Segmented label={label} value={value} disabled={(!selectedUser && (!!accountId || eligibleUsers.length > 0)) || (selectedUser && !scope) || saving.has(`perm:${entry.id}`)} onSelect={(next) => void savePermission(entry.id, next, rule?.version ?? futureDefault?.version ?? 0)}
              options={[{ value: 'DENY', text: desktopText('deny129'), tone: 'deny' }, { value: 'INHERIT', text: inheritText, tone: 'inherit' }, { value: 'ALLOW', text: desktopText('allow130'), tone: 'allow' }]} />
          </li>;
        })}
      </ul>
    </section>
  </div>;
}
