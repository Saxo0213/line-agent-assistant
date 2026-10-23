import { generatedMessageText, useDesktopText, useExtraText, useSafeErrorText } from '../desktop-i18n.js';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_AGENT_STATUS_ICONS, DEFAULT_AUTORESPONDER_FALLBACK, MCP_TOOL_NAMES, normalizeAutoresponderTrigger, validateAutoresponderConfig, type AgentStatusIcons, type AutoResponderRule, type AutoResponderSettings, type ComponentHealth, type ConversationKey, type LineAccountSummary, type McpLocalClientKind, type McpLocalClientStatus, type McpServerStatus, type McpTokenSummary, type McpToolName, type ProviderStatus } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { isValidEmbeddedPassword } from '../../setup-protocol.js';
import { storeSettingsTab, type SettingsTabId } from '../settings-tab-storage.js';
import {AgentProviderAuthControl} from './AgentProviderAuthControl.js';
import { AgentPermissions } from './AgentPermissions.js';
import { LineLogin, type LineLoginView } from './LineLogin.js';
import { WorkRecords } from './WorkRecords.js';
import { AGENT_STATUS_MARKERS, AgentStatusMarker } from '../AgentStatusMarker.js';
import { translateSettings } from '../../locale.js';
import { localeFromState, useLocale } from '../locale-context.js';

const SHOW_MANUAL_MCP_TOKENS = false;
const EMPTY_PROVIDERS: ProviderStatus[] = [];
const EMPTY_ACCOUNTS: LineAccountSummary[] = [];

function splitDisplayPath(path: string): { start: string; middle: string; tail: string } {
  const separator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (separator < 0) return { start: '', middle: '', tail: path };

  let startEnd = 0;
  if (/^[a-z]:[\\/]/i.test(path)) startEnd = 3;
  else if (path.startsWith('\\\\')) {
    const serverEnd = path.indexOf('\\', 2);
    const shareEnd = serverEnd < 0 ? -1 : path.indexOf('\\', serverEnd + 1);
    startEnd = shareEnd < 0 ? path.length : shareEnd + 1;
  } else if (path.startsWith('/')) startEnd = 1;
  else startEnd = path.indexOf(path[separator]!) + 1;

  return {
    start: path.slice(0, startEnd),
    middle: path.slice(startEnd, separator + 1),
    tail: path.slice(separator + 1),
  };
}

export function Settings({ api, headingRef, defaultProvider = 'claude', providers = EMPTY_PROVIDERS, accounts = EMPTY_ACCOUNTS, components = [], initialTab = 'system', live = null, onOpenWorkConversation = () => undefined, onNotice }: { api: DesktopApi; headingRef: React.RefObject<HTMLHeadingElement | null>; defaultProvider?: 'codex' | 'claude'; providers?: ProviderStatus[]; accounts?: LineAccountSummary[]; components?: ComponentHealth[]; initialTab?: SettingsTabId; live?: LineLoginView | null; onOpenWorkConversation?: (key: ConversationKey) => void; onNotice?: (message: string) => void }) {
  const [tab, setTabState] = useState<SettingsTabId>(initialTab);
  // Only the user's own tab choices are remembered; the app's default and redirects are stored by App.
  const setTab = (next: SettingsTabId) => { setTabState(next); storeSettingsTab(next); };
  // The app can redirect here after Settings has already mounted.
  useEffect(() => { setTabState(initialTab); }, [initialTab]);
  const [attachmentAttemptLimit, setAttachmentAttemptLimit] = useState(3);
  const [agentStatusIcons, setAgentStatusIcons] = useState<AgentStatusIcons>({ ...DEFAULT_AGENT_STATUS_ICONS });
  const [conversationSettingsBusy, setConversationSettingsBusy] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [provider, setProvider] = useState<'codex' | 'claude'>(defaultProvider);
  const [providerDirty, setProviderDirty] = useState(false);
  const [localStatus, setLocalStatus] = useState('');
  const setStatus = (message: string) => { setLocalStatus(message); if (message) onNotice?.(message); };
  const localeState = useLocale();
  const locale = localeFromState(localeState);
  const desktopText = useDesktopText();
  const safeErrorText = useSafeErrorText();
  const extraText = useExtraText();
  const localePreference = localeState.preference;
  const localeReadState = localeState.status;
  const localeText = (key: Parameters<typeof translateSettings>[1]) => translateSettings(locale, key);
  const agentStatusLabel: Record<ProviderStatus['status'], string> = { unknown: desktopText('checkedAtRuntime'), logged_in: desktopText('loggedIn'), logged_out: desktopText('notLoggedIn'), not_installed: desktopText('notInstalled'), error: desktopText('unavailable') };
  const MCP_TOOL_LABEL: Record<McpToolName, string> = {
    list_targets: desktopText('listChats'), query_target_messages: desktopText('queryChatMessages'), query_target_messages_by_time: desktopText('queryMessagesByTime'),
  };
  const MCP_TOOL_DESCRIPTION: Record<McpToolName, string> = {
    list_targets: desktopText('listLineConversationsAndParticipantsInAuthorizedAccounts'), query_target_messages: desktopText('searchSelectedAccountsHistoryByTargetNameChatidOr'), query_target_messages_by_time: desktopText('searchSelectedAccountsHistoryWithinAFromToTime'),
  };
  const MCP_ACCOUNT_ROLE_LABEL: Record<NonNullable<LineAccountSummary['productRole']>, string> = {
    AGENT: desktopText('agentAccount'), PRIMARY_ADMIN: desktopText('administratorAccount'),
  };
  const AGENT_STATUS_ROWS: Array<{ key: keyof AgentStatusIcons; label: string }> = [
    { key: 'queued', label: desktopText('queued') }, { key: 'running', label: desktopText('running') }, { key: 'completed', label: desktopText('completed') },
    { key: 'failed', label: desktopText('failed') }, { key: 'cancelled', label: desktopText('cancelled') }, { key: 'interrupted', label: desktopText('interrupted') },
  ];
  const agentStatusNote = (key: keyof AgentStatusIcons): string => {
    switch (key) {
      case 'queued': return desktopText('lineReactionAmazing');
      case 'running': return desktopText('alternating');
      case 'completed': return desktopText('lineReactionLove');
      case 'failed': return desktopText('lineReactionSad');
      case 'cancelled': return desktopText('lineReactionFun');
      case 'interrupted': return desktopText('lineReactionOmg');
    }
  };
  const [attachmentRoot, setAttachmentRoot] = useState('');
  const [attachmentRootBusy, setAttachmentRootBusy] = useState(false);
  const [databaseConfigured, setDatabaseConfigured] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const databaseHealth = components.find((item) => item.name === 'database');
  const databaseStatusText = databaseHealth
    ? databaseHealth.status === 'ready' ? desktopText('connected') : (databaseHealth.status === 'degraded' ? desktopText('connectionError') : desktopText('disconnected'))
    : databaseConfigured ? desktopText('unableToVerifyConnection') : desktopText('notConfigured');
  const agentAccountConnected = accounts.some((account) => account.productRole === 'AGENT' && account.status === 'connected');
  const [connectionInfo, setConnectionInfo] = useState<{ url: string; password: string } | null>(null);
  const [connectionInfoError, setConnectionInfoError] = useState('');
  // The password lives in renderer state only while the modal is open.
  async function showConnectionInfo() {
    setConnectionInfoError('');
    try { const info = await api.getEmbeddedConnectionInfo(); setConnectionInfo({ url: info.url, password: info.password }); }
    catch (error) { setConnectionInfoError(safeErrorText(error, desktopText('unableToReadConnectionInformation'))); setConnectionInfo({ url: '', password: '' }); }
  }
  const [passwordDialog, setPasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordPhase, setPasswordPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const [passwordError, setPasswordError] = useState<{ text: string; code?: string } | null>(null);
  function closePasswordDialog() { setPasswordDialog(false); setNewPassword(''); setConfirmPassword(''); setPasswordError(null); setPasswordPhase('idle'); }
  async function submitPasswordChange() {
    if (!isValidEmbeddedPassword(newPassword)) { setPasswordError({ text: desktopText('passwordMustContain8128Characters') }); return; }
    if (newPassword !== confirmPassword) { setPasswordError({ text: desktopText('passwordsDoNotMatch') }); return; }
    setPasswordError(null); setPasswordPhase('busy');
    try { await api.changeEmbeddedPassword(newPassword); }
    catch (error) {
      const candidate = (error as { errorCode?: unknown })?.errorCode;
      const code = typeof candidate === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(candidate) ? candidate : undefined;
      setPasswordPhase('idle'); setPasswordError({ text: desktopText('unableToChangePassword'), ...(code ? { code } : {}) }); return;
    }
    setNewPassword(''); setConfirmPassword(''); setPasswordPhase('done');
    try { await api.restartApplication(); }
    catch { setPasswordPhase('idle'); setPasswordError({ text: desktopText('unableToChangePassword') }); }
  }
  function copyText(text: string) { void navigator.clipboard?.writeText(text).catch(() => undefined); }
  async function changeAttachmentRoot() {
    if (attachmentRootBusy || typeof api.prepareAttachmentRootChange !== 'function' || typeof api.moveAttachmentRoot !== 'function') return;
    setAttachmentRootBusy(true); setStatus('');
    try {
      const selection = await api.prepareAttachmentRootChange();
      if (!selection) return;
      if (!window.confirm(desktopText('moveExistingAttachmentsToThisFolderNNArg0', { arg0: selection.path }))) return;
      const moved = await api.moveAttachmentRoot(selection.id);
      setAttachmentRoot(moved.path);
      setStatus(desktopText('attachmentsMovedRestarting'));
      if (moved.sourceRetained) window.alert(desktopText('attachmentsMovedToTheNewLocationTheOldFolder', { arg0: attachmentRoot }));
      await api.restartApplication();
    } catch (error) {
      const message = safeErrorText(error, desktopText('unableToChangeAttachmentFolder'));
      if ((error as { restartRequired?: unknown })?.restartRequired === true) {
        window.alert(desktopText('arg0NNtheAppWillRestartToRestoreThe', { arg0: message }));
        try { await api.restartApplication(); } catch { setStatus(desktopText('arg0RestartTheAppToRestoreService', { arg0: message })); }
      } else setStatus(message);
    }
    finally { setAttachmentRootBusy(false); }
  }
  async function openAttachmentRoot() {
    if (typeof api.openAttachmentRoot !== 'function') return;
    try { await api.openAttachmentRoot(); }
    catch (error) { setStatus(safeErrorText(error, desktopText('unableToOpenAttachmentFolder'))); }
  }
  const settingsContentRef = useRef<HTMLDivElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const localeChoiceDialogRef = useRef<HTMLElement>(null);
  const localeChoiceOpenerRef = useRef<HTMLElement | null>(null);
  const localeChoiceWasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = localeState.restartChoice === true;
    const wasOpen = localeChoiceWasOpenRef.current;
    localeChoiceWasOpenRef.current = isOpen;
    if (isOpen) {
      localeChoiceDialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); localeState.restartLater?.(); return; }
        if (event.key !== 'Tab') return;
        const focusable = localeChoiceDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
        const first = focusable?.[0]; const last = focusable?.[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !localeChoiceDialogRef.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !localeChoiceDialogRef.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      };
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }
    if (wasOpen && localeChoiceOpenerRef.current) {
      localeChoiceOpenerRef.current.focus();
      localeChoiceOpenerRef.current = null;
    }
  }, [localeState.restartChoice, localeState.restartLater]);
  useLayoutEffect(() => { if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0; }, [tab]);
  const [agentSaving, setAgentSaving] = useState(false);
  const [autoVersion, setAutoVersion] = useState(0);
  const [autoDisplayName, setAutoDisplayName] = useState('Agent');
  const [autoFallback, setAutoFallback] = useState(DEFAULT_AUTORESPONDER_FALLBACK);
  const [autoRules, setAutoRules] = useState<AutoResponderRule[]>([]);
  const [autoRuleDialog, setAutoRuleDialog] = useState<{ mode: 'add' | 'edit' | 'recovery' | 'recreate' | 'fallback'; sourceTrigger?: string; rule: AutoResponderRule; duplicateTrigger?: string } | null>(null);
  const autoRuleIsFallbackRef = useRef(false);
  autoRuleIsFallbackRef.current = autoRuleDialog?.mode === 'fallback';
  const [autoRuleError, setAutoRuleError] = useState('');
  const autoRuleTriggerRef = useRef<HTMLInputElement>(null);
  const autoRuleReplyRef = useRef<HTMLTextAreaElement>(null);
  const autoRuleDialogRef = useRef<HTMLElement>(null);
  const autoRuleOpenerRef = useRef<HTMLElement | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoSettingsLoaded, setAutoSettingsLoaded] = useState(false);
  const autoSaveRequestRef = useRef(0);
  const autoSaveEpochRef = useRef(0);
  const autoSaveInProgressRef = useRef(false);
  const autoSettingsReady = autoSettingsLoaded;
  useEffect(() => {
    const isOpen = autoRuleDialog !== null;
    if (isOpen) {
      (autoRuleIsFallbackRef.current ? autoRuleReplyRef.current : autoRuleTriggerRef.current)?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); if (!autoSaveInProgressRef.current) closeAutoRuleDialog(); return; }
        if (event.key !== 'Tab') return;
        const focusable = autoRuleDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
        if (!focusable?.length) return;
        const ordered = [...focusable].sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const first = ordered[0]; const last = ordered[ordered.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !autoRuleDialogRef.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !autoRuleDialogRef.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      };
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    } else if (autoRuleOpenerRef.current) {
      autoRuleOpenerRef.current?.focus();
      autoRuleOpenerRef.current = null;
    }
  }, [autoRuleDialog !== null]);
  const closeAutoRuleDialog = useCallback(() => { setAutoRuleDialog(null); setAutoRuleError(''); }, []);
  function submitAutoRule(event: React.FormEvent) {
    event.preventDefault();
    if (autoSaving) return;
    applyAutoRule(false);
  }
  function applyAutoRule(confirmOverwrite: boolean) {
    if (!autoRuleDialog || autoSaving) return;
    if (autoRuleDialog.mode === 'recovery') return;
    const isFallback = autoRuleDialog.mode === 'fallback';
    const sourceIndex = autoRuleDialog.mode === 'edit'
      ? autoRules.findIndex((rule) => normalizeAutoresponderTrigger(rule.trigger) === autoRuleDialog.sourceTrigger)
      : -1;
    if (autoRuleDialog.mode === 'edit' && sourceIndex < 0) {
      const next = { ...autoRuleDialog, mode: 'recovery' as const };
      delete next.duplicateTrigger;
      setAutoRuleDialog(next);
      setAutoRuleError('');
      return;
    }
    const candidateFallback = isFallback ? autoRuleDialog.rule.reply : autoFallback;
    const candidateRule = isFallback ? null : { ...autoRuleDialog.rule, trigger: normalizeAutoresponderTrigger(autoRuleDialog.rule.trigger) };
    const duplicateIndex = candidateRule ? autoRules.findIndex((rule, index) => index !== sourceIndex
      && normalizeAutoresponderTrigger(rule.trigger) === candidateRule.trigger) : -1;
    const duplicateTrigger = duplicateIndex >= 0 ? normalizeAutoresponderTrigger(autoRules[duplicateIndex]!.trigger) : undefined;
    const overwriteIndex = confirmOverwrite && duplicateIndex >= 0 && autoRuleDialog.duplicateTrigger === duplicateTrigger
      ? duplicateIndex : -1;
    if (duplicateIndex >= 0 && overwriteIndex < 0) {
      if (autoRuleDialog.duplicateTrigger !== duplicateTrigger) {
        const next = { ...autoRuleDialog };
        if (duplicateTrigger === undefined) delete next.duplicateTrigger;
        else next.duplicateTrigger = duplicateTrigger;
        setAutoRuleDialog(next);
        setAutoRuleError('');
      }
      return;
    }
    let next = isFallback ? autoRules : autoRuleDialog.mode !== 'edit'
      ? [...autoRules, candidateRule!]
      : autoRules.map((rule, index) => index === sourceIndex ? candidateRule! : rule);
    if (overwriteIndex >= 0 && candidateRule) {
      next = autoRules.map((rule, index) => index === overwriteIndex ? candidateRule : rule)
        .filter((_rule, index) => autoRuleDialog.mode !== 'edit' || index !== sourceIndex);
    }
    const validation = validateAutoresponderConfig({ displayName: autoDisplayName, fallback: candidateFallback, rules: next });
    if (validation) {
      setAutoRuleError(validation.includes('fallback') ? desktopText('defaultReplyCannotBeEmptyEnterAReplyMessage')
        : validation.includes('duplicate') ? desktopText('triggerAlreadyExistsChooseOverwriteOrCancel')
        : validation.includes('reserved') ? desktopText('thisTriggerIsReservedByTheSystem')
          : validation.includes('trigger') ? desktopText('enterATriggerWith1256Characters')
            : validation.includes('reply') ? desktopText('enterAReplyWith12000Characters') : desktopText('ruleDoesNotMeetTheRequirements'));
      return;
    }
    if (isFallback && autoRuleDialog.rule.reply === autoFallback) { closeAutoRuleDialog(); return; }
    if (!isFallback && JSON.stringify(next) === JSON.stringify(autoRules)) { closeAutoRuleDialog(); return; }
    void saveAutoResponder({ displayName: autoDisplayName, fallback: candidateFallback, rules: next }, true);
  }
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus | null>(null);
  const [mcpTokens, setMcpTokens] = useState<McpTokenSummary[]>([]);
  const [mcpLocalClients, setMcpLocalClients] = useState<McpLocalClientStatus[]>([]);
  const [mcpLocalScopes, setMcpLocalScopes] = useState<Record<McpLocalClientKind, string[] | null>>({ 'claude-desktop': null, codex: null });
  const accountIdsKey = accounts.map((account) => account.accountId).sort().join('\0');
  const [mcpLocalBusy, setMcpLocalBusy] = useState<McpLocalClientKind | null>(null);
  const [mcpRestartNotice, setMcpRestartNotice] = useState(false);
  const [mcpDeviceLabel, setMcpDeviceLabel] = useState('');
  const [mcpAccountScopes, setMcpAccountScopes] = useState<string[]>([]);
  const [mcpToolScopes, setMcpToolScopes] = useState<McpToolName[]>([]);
  const [mcpExpiresInHours, setMcpExpiresInHours] = useState(168);
  const [mcpExpirationMode, setMcpExpirationMode] = useState<'limited' | 'never'>('limited');
  const mcpLastValidHours = useRef(168);
  const [mcpPlaintextToken, setMcpPlaintextToken] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    const valid = new Set(accounts.map((account) => account.accountId));
    setMcpLocalScopes((current) => ({ ...current, 'claude-desktop': current['claude-desktop']?.filter((id) => valid.has(id)) ?? null,
      codex: current.codex?.filter((id) => valid.has(id)) ?? null }));
  }, [accountIdsKey]);

  useEffect(() => {
    if (!localStatus || onNotice) return;
    const timeout = window.setTimeout(() => setLocalStatus(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [localStatus, onNotice]);

  useEffect(() => {
    if (!providerDirty) setProvider(defaultProvider);
  }, [defaultProvider, providerDirty]);

  useEffect(() => {
    void api.getDatabaseSetupStatus().then((current) => {
      setAttachmentRoot(current.attachmentRoot ?? '');
      setWorkspace(current.agentWorkspace ?? '');
      const configured = Boolean(current.configured && current.connection);
      setDatabaseConfigured(configured);
      setEmbedded(Boolean(current.embedded));
    }).catch(() => {
      setDatabaseConfigured(false);
    });
  }, [api]);

  useEffect(() => {
    if (tab !== 'conversation' || typeof api.getAutoResponderSettings !== 'function') return;
    let current = true;
    const saveEpoch = autoSaveEpochRef.current;
    setAutoLoading(true);
    void api.getAutoResponderSettings().then((saved: AutoResponderSettings) => {
      if (!current) return;
      if (autoSaveInProgressRef.current || autoSaveEpochRef.current !== saveEpoch) {
        setAutoSettingsLoaded(true);
        return;
      }
      setAutoVersion(saved.version);
      setAutoDisplayName(saved.displayName); setAutoFallback(saved.fallback); setAutoRules(saved.rules);
      setAutoRuleDialog((current) => {
        if (!current) return null;
        const refreshed = { ...current };
        delete refreshed.duplicateTrigger;
        if (refreshed.mode === 'edit' && refreshed.sourceTrigger !== undefined
          && !saved.rules.some((rule) => normalizeAutoresponderTrigger(rule.trigger) === refreshed.sourceTrigger)) {
          refreshed.mode = 'recovery';
        }
        return refreshed;
      });
      setAutoSettingsLoaded(true);
    }).catch((error: unknown) => {
      if (current && !autoSaveInProgressRef.current && autoSaveEpochRef.current === saveEpoch) {
        setStatus(safeErrorText(error, desktopText('unableToLoadAutomaticReplies')));
      }
    })
      .finally(() => { if (current) setAutoLoading(false); });
    return () => { current = false; };
  }, [api, tab]);

  useEffect(() => {
    if (tab !== 'agent' || typeof api.mcpListTokens !== 'function' || typeof api.mcpGetStatus !== 'function') return;
    let current = true;
    const localStatus = typeof api.mcpLocalClientStatus === 'function' ? api.mcpLocalClientStatus() : Promise.resolve([]);
    void Promise.all([api.mcpGetStatus(), api.mcpListTokens(), localStatus]).then(([nextStatus, nextTokens, nextLocalClients]) => {
      if (!current) return;
      setMcpStatus(nextStatus);
      setMcpTokens(nextTokens);
      setMcpLocalClients(nextLocalClients);
    }).catch((error: unknown) => {
      if (current) setStatus(safeErrorText(error, desktopText('unableToLoadMcpSettings')));
    });
    return () => { current = false; };
  }, [api, tab]);

  async function setMcpLocalClient(client: McpLocalClientKind, action: 'connect' | 'disconnect') {
    if (mcpLocalBusy) return;
    setMcpLocalBusy(client); setStatus('');
    try {
      if (action === 'connect') {
        const selectedScopes = mcpLocalScopes[client] ?? accounts.map((account) => account.accountId);
        if (!selectedScopes.length) { setStatus(desktopText('selectAtLeastOneLineAccountScope')); return; }
        const status = await api.mcpLocalClientConnect(client, selectedScopes);
        setMcpLocalClients((current) => current.map((item) => item.client === client ? status : item));
        setMcpRestartNotice(true);
      } else {
        await api.mcpLocalClientDisconnect(client);
        setMcpLocalClients((current) => current.map((item) => item.client === client ? { ...item, connected: false, tokenId: null, accountScopes: [] } : item));
      }
      if (typeof api.mcpGetStatus === 'function') {
        try { setMcpStatus(await api.mcpGetStatus()); } catch { /* keep the previous badge */ }
      }
    } catch (error) {
      const code = error instanceof Error ? error.name : '';
      const messages: Record<string, string> = {
        LOCAL_MCP_CONFIG_CONFLICT: desktopText('codexSettingsContainAnUnmanagedLinejsMcpEntryCheck'),
        LOCAL_MCP_CONFIG_INVALID: desktopText('claudeDesktopSettingsAreNotValidJsonTheFile'),
        SERVICE_ERROR: desktopText('mcpServerOrConfigurationIsUnavailableCheckAppStatus'),
      };
      setStatus(messages[code] ?? desktopText('unableToUpdateLocalMcpConnectionSettingsCheckApp'));
    } finally { setMcpLocalBusy(null); }
  }

  useEffect(() => {
    if (tab !== 'conversation') return;
    let live = true;
    const load = () => { void api.getConversationSettings().then((saved) => { if (live) {
      setAttachmentAttemptLimit(saved.attachmentAutoAttemptLimit); setAgentStatusIcons(saved.agentStatusIcons);
    } }).catch((error: unknown) => { if (live) setStatus(safeErrorText(error, extraText('operationFailed'))); }); };
    load(); window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [api, tab]);

  async function chooseAgentWorkspace() {
    try { const selected = await api.chooseAgentWorkspace(); if (selected) setWorkspace(selected); }
    catch (error) { setStatus(safeErrorText(error, desktopText('unableToOpenFolderPicker'))); }
  }
  async function saveAgentSettings() {
    if (!workspace.trim() || agentSaving) return;
    setAgentSaving(true); setStatus('');
    try {
      const workspaceResult = await api.setWorkspace(workspace);
      if (!workspaceResult.ok) throw new Error(safeErrorText(workspaceResult));
      if (providerDirty) {
        const providerResult = await api.setDefaultAgent(provider);
        if (!providerResult.ok) throw new Error(safeErrorText(providerResult));
        setProviderDirty(false);
      }
      setStatus(desktopText('agentSettingsSaved'));
    } catch { setStatus(desktopText('unableToSaveAgentSettingsCheckAndRetry')); }
    finally { setAgentSaving(false); }
  }
  async function saveAutoResponder(input: Pick<AutoResponderSettings, 'displayName' | 'fallback' | 'rules'>, closeDialogOnSuccess = false) {
    if (!autoSettingsReady || autoSaving || typeof api.setAutoResponderSettings !== 'function') return;
    const saveRequest = ++autoSaveRequestRef.current;
    autoSaveEpochRef.current++;
    autoSaveInProgressRef.current = true;
    const isCurrentSave = () => autoSaveRequestRef.current === saveRequest;
    setAutoSaving(true); setStatus('');
    try {
      const result = await api.setAutoResponderSettings(autoVersion, input);
      if (!isCurrentSave()) return;
      if (result.type === 'error') {
        if (result.code === 'AUTORESPONDER_VERSION_CONFLICT') {
          const saved = await api.getAutoResponderSettings();
          if (!isCurrentSave()) return;
          setAutoVersion(saved.version);
          setAutoDisplayName(saved.displayName); setAutoFallback(saved.fallback); setAutoRules(saved.rules);
          setAutoRuleDialog((current) => {
            if (!current) return null;
            const refreshed = { ...current };
            delete refreshed.duplicateTrigger;
            if (refreshed.mode === 'edit' && refreshed.sourceTrigger !== undefined
              && !saved.rules.some((rule) => normalizeAutoresponderTrigger(rule.trigger) === refreshed.sourceTrigger)) {
              refreshed.mode = 'recovery';
            }
            return refreshed;
          });
          throw { code: 'AUTORESPONDER_VERSION_CONFLICT' };
        }
        throw new Error(safeErrorText(result));
      }
      if (result.type !== 'setAutoResponderSettings') throw new Error(desktopText('unexpectedAutomaticReplySettingsResponse'));
      const saved = await api.getAutoResponderSettings();
      if (!isCurrentSave()) return;
      setAutoVersion(saved.version);
      setAutoDisplayName(saved.displayName); setAutoFallback(saved.fallback); setAutoRules(saved.rules);
      if (closeDialogOnSuccess) closeAutoRuleDialog();
      setStatus(desktopText('automaticReplySettingsSaved'));
    } catch (error) {
      if (isCurrentSave()) {
        const message = safeErrorText(error, desktopText('unableToSaveAutomaticReplies'));
        if (closeDialogOnSuccess) setAutoRuleError(message);
        else setStatus(message);
      }
    }
    finally {
      if (autoSaveRequestRef.current === saveRequest) {
        autoSaveInProgressRef.current = false;
        autoSaveEpochRef.current++;
        setAutoSaving(false);
      }
    }
  }
  async function issueMcpToken() {
    if (!mcpDeviceLabel.trim() || mcpBusy || typeof api.mcpIssueToken !== 'function') return;
    const scopes = mcpAccountScopes;
    if (scopes.length === 0 || mcpToolScopes.length === 0) return;
    setMcpBusy(true); setStatus('');
    try {
      const issued = await api.mcpIssueToken({
        deviceLabel: mcpDeviceLabel.trim(),
        accountScopes: scopes,
        toolScopes: mcpToolScopes,
        expiration: mcpExpirationMode === 'never' ? { mode: 'never' } : { mode: 'limited', hours: mcpExpiresInHours },
      });
      setMcpPlaintextToken(issued.plaintextToken);
      setMcpDeviceLabel('');
      setMcpTokens((current) => [issued.token, ...current]);
    } catch (error) { setStatus(safeErrorText(error, desktopText('unableToIssueMcpToken'))); }
    finally { setMcpBusy(false); }
  }
  async function revokeMcpToken(tokenId: string) {
    if (mcpBusy || typeof api.mcpRevokeToken !== 'function') return;
    setMcpBusy(true); setStatus('');
    try {
      await api.mcpRevokeToken(tokenId);
      setMcpTokens((current) => current.map((item) => item.tokenId === tokenId ? { ...item, state: 'REVOKED', revokedAt: new Date().toISOString() } : item));
    } catch (error) { setStatus(safeErrorText(error, desktopText('unableToRevokeMcpToken'))); }
    finally { setMcpBusy(false); }
  }

  const displayAttachmentPath = splitDisplayPath(attachmentRoot || desktopText('notConfigured'));

  return <div className="page settings-page"><div ref={settingsContentRef} className="settings-content" aria-hidden={connectionInfo !== null || passwordDialog || localeState.restartChoice}><header className="page-header"><div><span className="eyebrow">{extraText('preferences')}</span><div className="page-title-row"><h1 tabIndex={-1} ref={headingRef}>{desktopText('settings')}</h1><p>{desktopText('manageTheDatabaseAttachmentsAndAgents')}</p></div></div></header>
    <div className="settings-tabs" role="tablist" aria-label={desktopText('settingsCategories')}>
      <button role="tab" aria-selected={tab === 'system'} className={tab === 'system' ? 'active' : ''} onClick={() => setTab('system')}>{desktopText('system')}</button>
      <button role="tab" aria-selected={tab === 'conversation'} className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>{desktopText('conversations')}</button>
      <button role="tab" aria-selected={tab === 'agent'} className={tab === 'agent' ? 'active' : ''} onClick={() => setTab('agent')}>{desktopText('assistant')}</button>
      <button role="tab" aria-selected={tab === 'help'} className={tab === 'help' ? 'active' : ''} onClick={() => setTab('help')}>{desktopText('commands')}</button>
      <button role="tab" aria-selected={tab === 'work'} className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>{desktopText('records')}</button>
      <button role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>{desktopText('about')}</button>
    </div>
    <div className="settings-panel-scroll" ref={panelScrollRef}>
    {tab === 'system' ? <div role="tabpanel" className="settings-card-stack"><LineLogin api={api} accounts={accounts} live={live} embedded {...(onNotice ? { onNotice } : {})} />
      <section className="panel database-settings database-summary"><div className="panel-top"><div><h2>{desktopText('databaseAndAttachments')}</h2><p>{desktopText('viewCurrentDatabaseAndAttachmentStorageLocations')}</p></div></div>
      <div className="system-location-rows">
        <div className="system-location-row"><label>{desktopText('database')}</label><div className="system-location-field"><span className="system-location-value">{databaseStatusText}</span>{embedded && <div className="button-row"><button onClick={() => void showConnectionInfo()}>{desktopText('showPassword')}</button><button onClick={() => setPasswordDialog(true)}>{desktopText('changePassword')}</button></div>}</div></div>
        <div className="system-location-row"><label>{desktopText('attachmentFolder')}</label><div className="system-location-field"><span className="system-location-value system-location-path" title={attachmentRoot || undefined} aria-label={attachmentRoot || desktopText('notConfigured')}><span className="system-location-path-start">{displayAttachmentPath.start}</span><span className="system-location-path-middle">{displayAttachmentPath.middle}</span><span className="system-location-path-tail">{displayAttachmentPath.tail}</span></span><div className="button-row"><button disabled={attachmentRootBusy || !attachmentRoot || !databaseConfigured} onClick={() => void changeAttachmentRoot()}>{attachmentRootBusy ? desktopText('processing160') : desktopText('changeLocation')}</button><button disabled={!attachmentRoot || !databaseConfigured} onClick={() => void openAttachmentRoot()}>{desktopText('openLocation')}</button></div></div></div>
      </div>
    </section><section className="panel locale-settings"><div className="panel-top"><div><h2>{localeText('systemTitle')}</h2></div></div>
      <div className="system-location-rows"><div className="system-location-row"><label htmlFor="system-language">{localeText('language')}</label><div className="system-location-field">
        {localeReadState === 'loading' && <p role="status">{localeText('loading')}</p>}
        {localeReadState === 'error' && <p role="alert">{localeText('loadFailed')} <button type="button" onClick={localeState.retry}>{localeText('retry')}</button></p>}
        {localeState.error === 'save' && <p role="alert">{localeText('saveFailed')}</p>}
        {localeState.error === 'restart' && <p role="alert">{localeText('restartNeeded')} <button type="button" onClick={localeState.retryRestart}>{localeText('retry')}</button></p>}
        {localeState.restartPending && !localeState.restartChoice && localeState.error !== 'restart' && <p role="status">{localeText('restartNeeded')} <button type="button" disabled={localeState.busy} onClick={localeState.retryRestart}>{localeText('restartNow')}</button></p>}
        {localeReadState === 'loaded' && <>
        <select id="system-language" aria-label={localeText('language')} value={localePreference ?? ''} disabled={localeState.busy || localeReadState !== 'loaded'} onChange={(event) => { localeChoiceOpenerRef.current = event.currentTarget; localeState.setPreference(event.target.value as NonNullable<typeof localePreference>); }}>
          <option value="automatic">{localeText('automatic')}</option>
          <option value="en">{localeText('english')}</option>
          <option value="zh-TW">{localeText('traditionalChinese')}</option>
          <option value="ja">{localeText('japanese')}</option>
          <option value="ko">{localeText('korean')}</option>
        </select><span className="system-location-value" aria-live="polite">{localeText('effectiveLanguage')}: {locale === 'en' ? 'English' : locale === 'zh-TW' ? '繁體中文' : locale === 'ja' ? '日本語' : '한국어'}</span>
        </>}
      </div></div></div>
    </section></div>
      : tab === 'conversation' ? <div role="tabpanel" className="settings-card-stack"><section className="panel conversation-settings">
      <div className="panel-top"><div><h2>{desktopText('conversations')}</h2></div><button className="primary"
        disabled={conversationSettingsBusy || !Number.isInteger(attachmentAttemptLimit) || attachmentAttemptLimit < 3 || attachmentAttemptLimit > 10}
        onClick={() => {
          setConversationSettingsBusy(true); setStatus('');
          void api.setConversationSettings({ attachmentAutoAttemptLimit: attachmentAttemptLimit, showAgentStatusMarkers: true, agentStatusIcons })
            .then((saved) => {
              setAttachmentAttemptLimit(saved.attachmentAutoAttemptLimit);
              setAgentStatusIcons(saved.agentStatusIcons); setStatus(desktopText('conversationSettingsSaved'));
            })
            .catch(async (error: unknown) => {
              setStatus(safeErrorText(error, desktopText('unableToSaveConversationSettings')));
              try {
                const saved = await api.getConversationSettings();
                setAttachmentAttemptLimit(saved.attachmentAutoAttemptLimit);
                setAgentStatusIcons(saved.agentStatusIcons);
              } catch { /* Retain the draft if reconciliation also fails. */ }
            }).finally(() => setConversationSettingsBusy(false));
        }}>{desktopText('save')}</button></div>
      <label>{desktopText('automaticAttachmentDownloadAttempts')}<input aria-label={desktopText('automaticAttachmentDownloadAttempts')} type="number" min={3} max={10} step={1} value={attachmentAttemptLimit} onChange={(event) => setAttachmentAttemptLimit(Number(event.target.value))} /></label>
      <fieldset className="agent-status-icon-settings">
        <legend>{desktopText('statusIcons')}</legend>
        <p>{desktopText('eachStatusUsesAFixedLineReactionOnThe')}</p>
        <div className="agent-status-icon-grid">
        {AGENT_STATUS_ROWS.map(({ key, label }) => <div className="agent-status-icon-row" key={key}>
          <span className="agent-status-icon-label">{label}</span>
          <AgentStatusMarker status={key} preview previewName={AGENT_STATUS_MARKERS[key].rotation ? desktopText('arg0PreviewAlternatingArg1', { arg0: label, arg1: AGENT_STATUS_MARKERS[key].rotation!.join('、') }) : desktopText('arg0Preview', { arg0: label })} />
          <span className="agent-status-icon-note">{agentStatusNote(key)}</span>
        </div>)}
        </div>
      </fieldset>
    </section>
      <section className="panel autoresponder-settings">
        <div className="panel-top"><h2>{desktopText('automaticReplies')}{!agentAccountConnected && <span>{desktopText('assistantNotLoggedIn')}</span>}</h2>
          <div className="autoresponder-header-actions"><button disabled={!autoSettingsReady || autoLoading || autoSaving || autoRules.length >= 50} onClick={(event) => { autoRuleOpenerRef.current = event.currentTarget; setAutoRuleError(''); setAutoRuleDialog({ mode: 'add', rule: { trigger: '', reply: '' } }); }}>{desktopText('addRule')}</button></div></div>
        {autoLoading && !autoSettingsReady && <p role="status">{desktopText('loadingAutomaticReplies')}</p>}
        {!autoSettingsReady && !autoLoading && <p role="status">{desktopText('automaticRepliesHaveNotLoaded')}</p>}
        <div className="agent-setting-section"><h3>{desktopText('triggersAndReplyMessages')}</h3>
          <div className="autoresponder-rule-table" role="table" aria-label={desktopText('automaticReplyRules')}><div className="autoresponder-rule-row autoresponder-rule-header" role="row"><span role="columnheader">{desktopText('trigger')}</span><span role="columnheader">{desktopText('replyMessage')}</span><span className="sr-only" role="columnheader">{desktopText('action')}</span></div>
            <div className="autoresponder-rule-row" role="row"><span role="cell">{desktopText('defaultReply')}</span><span role="cell">{autoFallback}</span><span className="autoresponder-rule-actions" role="cell"><button className="autoresponder-delete-placeholder" aria-label={desktopText('defaultReplyCannotBeDeleted')} disabled tabIndex={-1}></button><button aria-label={desktopText('editDefaultReply')} disabled={!autoSettingsReady || autoSaving || autoLoading} onClick={(event) => { autoRuleOpenerRef.current = event.currentTarget; setAutoRuleError(''); setAutoRuleDialog({ mode: 'fallback', rule: { trigger: '', reply: autoFallback } }); }}>{desktopText('edit')}</button></span></div>
            {autoRules.map((rule, index) => <div className="autoresponder-rule-row" role="row" key={`${index}-${autoVersion}`}><span role="cell">{rule.trigger}</span><span role="cell">{rule.reply}</span><span className="autoresponder-rule-actions" role="cell"><button disabled={autoSaving || autoLoading} aria-label={desktopText('deleteRuleArg0', { arg0: index + 1 })} onClick={() => void saveAutoResponder({ displayName: autoDisplayName, fallback: autoFallback, rules: autoRules.filter((_item, row) => row !== index) })}>{desktopText('delete')}</button><button disabled={autoSaving || autoLoading} aria-label={desktopText('editRuleArg0', { arg0: index + 1 })} onClick={(event) => { autoRuleOpenerRef.current = event.currentTarget; setAutoRuleError(''); setAutoRuleDialog({ mode: 'edit', sourceTrigger: normalizeAutoresponderTrigger(rule.trigger), rule: { ...rule } }); }}>{desktopText('edit')}</button></span></div>)}
          </div>
        </div>
        {autoRuleDialog && <div className="modal-scrim" onMouseDown={(event) => { if (!autoSaveInProgressRef.current && event.target === event.currentTarget) closeAutoRuleDialog(); }}><section ref={autoRuleDialogRef} className="modal autoresponder-rule-dialog" role="dialog" aria-modal="true" aria-labelledby="autoresponder-rule-dialog-title"><form onSubmit={submitAutoRule}>
          <h3 id="autoresponder-rule-dialog-title">{autoRuleDialog.mode === 'fallback' ? desktopText('editDefaultReply') : autoRuleDialog.mode === 'recovery' ? desktopText('ruleNoLongerExists') : autoRuleDialog.mode === 'add' || autoRuleDialog.mode === 'recreate' ? desktopText('addRule') : desktopText('editRule')}</h3>
          {autoRuleDialog.mode === 'recovery' && <p role="status">{desktopText('thisRuleWasDeletedElsewhereYourEditsAreKept')}</p>}
          <label>{autoRuleDialog.mode === 'fallback' ? desktopText('replyType') : desktopText('trigger')}<input ref={autoRuleTriggerRef} value={autoRuleDialog.mode === 'fallback' ? desktopText('defaultReply') : autoRuleDialog.rule.trigger} disabled={autoRuleDialog.mode === 'fallback' || autoSaving} maxLength={256} onChange={(event) => { const next = { ...autoRuleDialog, rule: { ...autoRuleDialog.rule, trigger: event.target.value } }; delete next.duplicateTrigger; setAutoRuleDialog(next); }} /></label>
          <label>{desktopText('replyMessage')}<textarea ref={autoRuleReplyRef} value={autoRuleDialog.rule.reply} disabled={autoSaving} maxLength={2000} onChange={(event) => { const next = { ...autoRuleDialog, rule: { ...autoRuleDialog.rule, reply: event.target.value } }; delete next.duplicateTrigger; setAutoRuleDialog(next); }} /></label>
          {autoRuleError && <p role="alert">{generatedMessageText(autoRuleError)}</p>}
          {autoRuleDialog.duplicateTrigger !== undefined && <p role="status">{desktopText('aRuleAlreadyUsesTheTrigger')}{autoRules.find((rule) => normalizeAutoresponderTrigger(rule.trigger) === autoRuleDialog.duplicateTrigger)?.trigger}{desktopText('overwritingWillKeepOneRule')}</p>}
          <div className="modal-actions"><button type="button" disabled={autoSaving} onClick={closeAutoRuleDialog}>{desktopText('cancel')}</button>{autoRuleDialog.mode === 'recovery' && <button type="button" disabled={autoSaving} onClick={() => setAutoRuleDialog({ ...autoRuleDialog, mode: 'recreate' })}>{desktopText('addAsNewRule')}</button>}{autoRuleDialog.duplicateTrigger !== undefined && <button type="button" disabled={autoSaving} onClick={() => applyAutoRule(true)}>{desktopText('overwrite')}</button>}<button className="primary" type="submit" disabled={autoSaving || autoRuleDialog.mode === 'recovery'}>{autoSaving ? desktopText('saving') : desktopText('confirm')}</button></div>
        </form></section></div>}
      </section>
    </div>
      : tab === 'work' ? <div role="tabpanel"><WorkRecords api={api} onOpen={onOpenWorkConversation} headingRef={headingRef} /></div>
      : tab === 'agent' ? <div role="tabpanel" className="agent-settings">
      <div className="cards secondary-settings"><section className="panel agent-basics"><div className="panel-top"><h2>{desktopText('agentSettings')}</h2><div className="agent-basics-actions"><label>{desktopText('defaultAgent')}<select aria-label={desktopText('defaultAgent')} value={provider} onChange={(event) => { setProvider(event.target.value as 'codex' | 'claude'); setProviderDirty(true); }}><option value="claude">Claude</option><option value="codex">Codex</option></select></label><button className="primary" disabled={!workspace.trim() || agentSaving} onClick={() => void saveAgentSettings()}>{agentSaving ? desktopText('saving') : desktopText('save')}</button></div></div><div className="agent-login-row">{[...providers].sort((a, b) => (a.provider === b.provider ? 0 : a.provider === 'codex' ? -1 : 1)).map((item) => <section className="agent-login-panel" key={item.provider}><div className="panel-top"><h3>{item.provider === 'codex' ? 'Codex' : 'Claude'}</h3><span className="badge">{agentStatusLabel[item.status]}</span></div><AgentProviderAuthControl api={api} providerStatus={item} onStatus={setStatus} /></section>)}</div><div className="agent-setting-section agent-workspace-row"><label htmlFor="agent-workspace-path">{desktopText('workspace')}</label><div className="path-picker"><input id="agent-workspace-path" aria-label={desktopText('agentWorkspace')} value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder={desktopText('forExampleDProjectsWorkspace')} /><button onClick={() => void chooseAgentWorkspace()}>{desktopText('chooseFolder')}</button></div></div>
        </section></div>
      {typeof api.mcpListTokens === 'function' && <section className="panel mcp-settings">
        <div className="panel-top"><h2>{desktopText('mcpServerAndExternalAgentAuthorization')}</h2>
          {mcpStatus && <span className="badge">{mcpStatus.running ? desktopText('runningArg0ActiveTokens', { arg0: mcpStatus.activeTokenCount }) : desktopText('notStarted')}</span>}</div>
        {mcpStatus?.endpoint && <p>{extraText('mcpEndpoint')} <code>{mcpStatus.endpoint}</code></p>}
        {typeof api.mcpLocalClientStatus === 'function' && <div className="mcp-local-client-cards">
          {(['claude-desktop', 'codex'] as const).map((client) => {
            const status = mcpLocalClients.find((item) => item.client === client);
            const title = client === 'claude-desktop' ? 'Claude Desktop' : 'Codex';
            const selectedScopes = mcpLocalScopes[client] ?? accounts.map((account) => account.accountId);
            return <section className="mcp-local-client-card" key={client} aria-label={desktopText('arg0McpConnection', { arg0: title })}>
              <div className="panel-top"><h3>{title}</h3><span className="badge">{!status ? desktopText('loading') : !status.installed ? desktopText('notInstalled612') : status.connected ? desktopText('connected613') : desktopText('disconnected614')}</span></div>
              <fieldset className="mcp-local-scope-picker">
                <legend>{desktopText('accountScope')}</legend>
                {(['AGENT', 'PRIMARY_ADMIN'] as const).map((role) => {
                  const account = accounts.find((item) => item.productRole === role);
                  const label = MCP_ACCOUNT_ROLE_LABEL[role];
                  return <label key={`${client}-${role}`}>
                    <input type="checkbox" aria-label={`${title} ${label}${account ? '' : desktopText('notAddedYet')}`} checked={account ? selectedScopes.includes(account.accountId) : false} disabled={mcpLocalBusy !== null || !account}
                      onChange={(event) => account && setMcpLocalScopes((current) => { const selected = current[client] ?? accounts.map((item) => item.accountId); return { ...current, [client]: event.target.checked ? [...selected, account.accountId] : selected.filter((id) => id !== account.accountId) }; })} />
                    {label}
                  </label>;
                })}
                {accounts.filter((account) => account.productRole == null).map((account) => <label key={`${client}-${account.accountId}`}>
                  <input type="checkbox" aria-label={`${title} ${account.displayName || account.accountId}`} checked={selectedScopes.includes(account.accountId)} disabled={mcpLocalBusy !== null}
                    onChange={(event) => setMcpLocalScopes((current) => { const selected = current[client] ?? accounts.map((item) => item.accountId); return { ...current, [client]: event.target.checked ? [...selected, account.accountId] : selected.filter((id) => id !== account.accountId) }; })} />
                  {account.displayName || account.accountId}
                </label>)}
                {accounts.length === 0 && <small>{desktopText('noLineAccountsAvailable')}</small>}
              </fieldset>
              <div className="mcp-local-client-actions">
                <button className="primary" disabled={!status?.installed || !selectedScopes.length || mcpLocalBusy !== null || !mcpStatus?.running}
                  onClick={() => void setMcpLocalClient(client, 'connect')}>{status?.connected ? desktopText('reconnect') : desktopText('connect')}</button>
                {status?.connected && <button disabled={mcpLocalBusy !== null} onClick={() => void setMcpLocalClient(client, 'disconnect')}>{desktopText('disconnect')}</button>}
              </div>
            </section>;
          })}
        </div>}
        {mcpRestartNotice && typeof api.mcpLocalClientStatus === 'function' && <p className="mcp-local-restart-note">{desktopText('restartClaudeDesktopCodexToApply')}</p>}
        {SHOW_MANUAL_MCP_TOKENS && <>
        <div className="settings-grid mcp-token-controls">
          <label>{desktopText('deviceAgentName')}<input value={mcpDeviceLabel} maxLength={120} placeholder={desktopText('forExampleAnalystMacbook')} onChange={(event) => setMcpDeviceLabel(event.target.value)} /></label>
          <fieldset><legend>{desktopText('tokenExpiration')}</legend>
            <label><input type="radio" name="mcp-expiration" checked={mcpExpirationMode === 'limited'} disabled={mcpBusy} onChange={() => { setMcpExpirationMode('limited'); setMcpExpiresInHours(mcpLastValidHours.current); }} />{desktopText('limitedDuration')}</label>
            <label><input type="radio" name="mcp-expiration" checked={mcpExpirationMode === 'never'} disabled={mcpBusy} onChange={() => setMcpExpirationMode('never')} />{desktopText('noExpiration')}</label>
          </fieldset>
          {mcpExpirationMode === 'limited' && <label>{desktopText('durationHours')}<input type="number" min="1" max="8760" value={mcpExpiresInHours} onChange={(event) => {
            const hours = Number(event.target.value);
            setMcpExpiresInHours(hours);
            if (Number.isInteger(hours) && hours >= 1 && hours <= 8760) mcpLastValidHours.current = hours;
          }} /></label>}
          <button className="primary" disabled={mcpBusy || !mcpDeviceLabel.trim() || mcpAccountScopes.length === 0 || mcpToolScopes.length === 0} onClick={() => void issueMcpToken()}>{desktopText('issueMcpToken')}</button>
        </div>
        <fieldset className="agent-setting-section mcp-scope-options">
          <legend>{desktopText('accountGrants')}</legend>
          <p className="mcp-scope-description" id="mcp-account-scope-description">{desktopText('chooseTheLineAccountsThisTokenCanAccessAll')}</p>
          {accounts.map((account) => {
            const label = account.productRole ? MCP_ACCOUNT_ROLE_LABEL[account.productRole] : desktopText('lineAccount');
            return <label className="mcp-scope-choice" key={account.accountId}>
              <input type="checkbox" aria-label={label} checked={mcpAccountScopes.includes(account.accountId)} disabled={mcpBusy} aria-describedby="mcp-account-scope-description"
                onChange={(event) => setMcpAccountScopes((current) => event.target.checked
                  ? [...current, account.accountId]
                  : current.filter((id) => id !== account.accountId))} />
              <span className="mcp-scope-copy"><strong>{label}</strong></span>
            </label>;
          })}
          {accounts.length === 0 && <p>{desktopText('noLineAccountsAvailableToAuthorize')}</p>}
        </fieldset>
        <fieldset className="agent-setting-section mcp-scope-options">
          <legend>{desktopText('toolGrants')}</legend>
          <p className="mcp-scope-description" id="mcp-tool-scope-description">{desktopText('chooseTheToolsThisTokenCanUseEachOperation')}</p>
          {MCP_TOOL_NAMES.map((tool) => <label className="mcp-scope-choice" key={tool}>
            <input type="checkbox" aria-label={MCP_TOOL_LABEL[tool]} aria-describedby={`mcp-tool-description-${tool} mcp-tool-scope-description`} checked={mcpToolScopes.includes(tool)} disabled={mcpBusy}
              onChange={(event) => setMcpToolScopes((current) => event.target.checked
                ? [...current, tool]
                : current.filter((name) => name !== tool))} />
            <span className="mcp-scope-copy"><strong>{MCP_TOOL_LABEL[tool]}</strong><small id={`mcp-tool-description-${tool}`}>{MCP_TOOL_DESCRIPTION[tool]}</small></span>
          </label>)}
        </fieldset>
        {mcpPlaintextToken && <div className="inline-notice" role="status"><strong>{desktopText('copyThisOneTimeTokenNowItCannotBe')}</strong> <code>{mcpPlaintextToken}</code></div>}
        {mcpTokens.length > 0 && <div className="mcp-token-list">{mcpTokens.map((item) => <div key={item.tokenId} className="autoresponder-rule">
          <div><strong>{item.deviceLabel}</strong> <span className="badge">{extraText(item.state === 'ACTIVE' ? 'active' : 'revoked')}</span> <small>{extraText('accounts')} {item.accountScopes.join(', ')}</small> <small>{desktopText('expires')}{item.expiresAt === null ? desktopText('noExpiration') : new Date(item.expiresAt).toLocaleString(locale)}</small></div>
          {item.state === 'ACTIVE' && <button onClick={() => void revokeMcpToken(item.tokenId)}>{desktopText('revokeToken')}{item.deviceLabel})</button>}
        </div>)}</div>}
        </>}
      </section>}
      <AgentPermissions api={api} accounts={accounts} />
    </div> : tab === 'help' ? <section role="tabpanel" className="panel conversation-help">
      <div className="panel-top"><div><h2>{desktopText('conversationCommands')}</h2><p>{desktopText('viewAgentPromptsAndLineUserAuthorizationCommands')}</p></div></div>
      <div className="conversation-help-table-wrap"><table aria-label={desktopText('conversationCommandList')}>
        <thead><tr><th scope="col">{desktopText('commandPrompt')}</th><th scope="col">{desktopText('purpose')}</th><th scope="col">{desktopText('description')}</th></tr></thead>
        <tbody>
          <tr><th scope="row"><code>{desktopText('agentCodexPrompt')}</code></th><td>{desktopText('useCodex')}</td><td>{desktopText('useCodexForThisPromptOnlyFollowTheCommand')}</td></tr>
          <tr><th scope="row"><code>{desktopText('agentClaudePrompt')}</code></th><td>{desktopText('useClaude')}</td><td>{desktopText('useClaudeForThisPromptOnlyFollowTheCommand')}</td></tr>
          <tr><th scope="row"><code>/stop</code></th><td>{desktopText('stopJob')}</td><td>{desktopText('stopTheCurrentAgentJob')}</td></tr>
          <tr><th scope="row"><code>/new</code></th><td>{desktopText('newConversation')}</td><td>{desktopText('startANewAgentConversation')}</td></tr>
          <tr><th scope="row"><code>/status</code></th><td>{desktopText('viewStatus')}</td><td>{desktopText('checkTheCurrentAgentJobStatus')}</td></tr>
          <tr><th scope="row"><code>/adduser</code>{locale === 'zh-TW' && <>、<code>/新增使用者</code></>}</th><td>{desktopText('userAuthorization')}</td><td>{desktopText('addUsersToTheAgentAccessAllowlistInDirect')}</td></tr>
        </tbody>
      </table></div>
    </section> : <section role="tabpanel" className="panel about-settings">
      <h2>LINE Agent Assistant</h2>
      <p>{desktopText('version')}{__APP_VERSION__}</p>
      <div>
        <h3>{desktopText('unofficialApplication')}</h3>
        <p>{desktopText('lineAgentAssistantIsAnIndependentlyDevelopedThirdParty')}</p>
      </div>
    </section>}
    </div>
    </div>
    {localeState.restartChoice && <div className="modal-scrim"><section ref={localeChoiceDialogRef} className="modal locale-restart-dialog" role="alertdialog" aria-modal="true" aria-label={localeText('restartChoice')}><p>{localeText('restartChoice')}</p><div className="modal-actions"><button type="button" disabled={localeState.busy} onClick={() => localeState.restartLater?.()}>{localeText('restartLater')}</button><button type="button" className="primary" disabled={localeState.busy} onClick={() => localeState.restartNow?.()}>{localeText('restartNow')}</button></div></section></div>}
    {!onNotice && localStatus && <div role="status" className="system-toast">{generatedMessageText(localStatus)}</div>}
    {connectionInfo && <div className="database-modal-scrim">
      <div className="panel database-settings database-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-info-title">
        <div className="panel-top database-dialog-header"><div><h2 id="connection-info-title">{desktopText('connectionInformation')}</h2><p>{desktopText('useThisInformationWithToolsSuchAsPgadmin')}</p></div>
          <button type="button" aria-label={desktopText('closeConnectionInformation')} onClick={() => { setConnectionInfo(null); setConnectionInfoError(''); }}>×</button></div>
        {connectionInfoError ? <p role="alert">{generatedMessageText(connectionInfoError)}</p> : <>
          <div className="connection-info-field"><span>{desktopText('connectionString')}</span><div className="path-picker"><span className="connection-info-value" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>{connectionInfo.url}</span><button onClick={() => copyText(connectionInfo.url)}>{desktopText('copy')}</button></div></div>
          <div className="connection-info-field"><span>{desktopText('password')}</span><div className="path-picker"><span className="connection-info-value" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>{connectionInfo.password}</span><button onClick={() => copyText(connectionInfo.password)}>{desktopText('copy')}</button></div></div></>}
      </div>
    </div>}
    {passwordDialog && <div className="database-modal-scrim">
      <div className="panel database-settings database-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div className="panel-top database-dialog-header"><div><h2 id="change-password-title">{desktopText('changePassword')}</h2></div></div>
        <label>{desktopText('newPassword')}<input type="password" value={newPassword} autoComplete="new-password" disabled={passwordPhase !== 'idle'} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label>{desktopText('confirmNewPassword')}<input type="password" value={confirmPassword} autoComplete="new-password" disabled={passwordPhase !== 'idle'} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        {passwordPhase === 'busy' && <p role="status">{desktopText('changing')}</p>}
        {passwordPhase === 'done' && <p role="status">{desktopText('passwordChangedRestarting')}</p>}
        {passwordError && <p role="alert">{generatedMessageText(passwordError.text)}{passwordError.code && <><br />{desktopText('errorCode')}<span>{passwordError.code}</span></>}</p>}
        <div className="button-row"><button type="button" disabled={passwordPhase !== 'idle'} onClick={closePasswordDialog}>{desktopText('cancel')}</button>
          <button type="button" className="primary" disabled={passwordPhase !== 'idle'} onClick={() => void submitPasswordChange()}>{desktopText('change')}</button></div>
      </div>
    </div>}
  </div>;
}
