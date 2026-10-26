import { generatedMessageText, desktopTextFor, type DesktopCopyKey } from './desktop-i18n.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_ROOM_ID, type AppSnapshot, type ConversationKey, type ConversationSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../preload/api.js';
import type { Locale } from '../locale.js';
import type { ManualSendFeedback } from './manual-send-feedback.js';
import { type LineLoginView } from './pages/LineLogin.js';
import { Conversations } from './pages/Conversations.js';
import { AgentRoom } from './pages/AgentRoom.js';
import { Search } from './pages/Search.js';
import { Jobs } from './pages/Jobs.js';
import { Settings } from './pages/Settings.js';
import { SetupWizard } from './pages/SetupWizard.js';
import { accountAvatarRefreshed, LineMediaImage } from './LineMediaImage.js';
import type { DatabaseSetupStatus } from '../setup-protocol.js';
import { readStoredSettingsTab, storeSettingsTab, type SettingsTabId } from './settings-tab-storage.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';
import { LocalePreferenceSchema, type LocalePreference, type LocaleSnapshot } from '../locale.js';

export type Page = 'conversations' | 'assistant' | 'search' | 'jobs' | 'settings';
const LAST_PAGE_KEY = 'linejs.lastPage';
const readStoredPage = (): string | null => {
  try { return window.localStorage.getItem(LAST_PAGE_KEY); } catch { return null; }
};
// 帳號 now lives in Settings: nothing stored, an invalid value, or the retired 'accounts' page all open Settings on 系統.
const readLastPage = (): Page => {
  const value = readStoredPage();
  return value && links.some((link) => link.id === value) ? value as Page : 'settings';
};
const readInitialSettingsTab = (): SettingsTabId => {
  const remembered = readStoredSettingsTab();
  if (remembered) return remembered;
  return 'system';
};
// An explicit open of a specific tab (a redirect, not a user click inside Settings) also becomes the remembered tab.
const openedTab = (tab: SettingsTabId): SettingsTabId => { storeSettingsTab(tab); return tab; };
const links: { id: Page; key: 'chats' | 'assistant' | 'agentNavigation' | 'search' | 'jobs' | 'settings' }[] = [
  { id: 'conversations', key: 'chats' }, { id: 'assistant', key: 'agentNavigation' }, { id: 'search', key: 'search' },
  { id: 'jobs', key: 'jobs' }, { id: 'settings', key: 'settings' },
];
const empty: AppSnapshot = { control: { epoch: 0, activeAccountId: null, phase: 'idle', targetAccountId: null }, defaultProvider: 'claude', components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] };
export const keyOf = (key: ConversationKey): string => JSON.stringify([key.accountId, key.chatType, key.chatId]);
export const conversationKey = (conversation: ConversationSummary): ConversationKey => ({ accountId: conversation.accountId, chatType: conversation.chatType, chatId: conversation.chatId });
export function visibleRoleAccounts(accounts: readonly AppSnapshot['accounts'][number][]): AppSnapshot['accounts'] {
  return accounts.filter((account) => account.productRole === 'AGENT' || account.productRole === 'PRIMARY_ADMIN');
}
/**
 * The one shared Agent room: a fixed first chat entry that is independent of the selected LINE account.
 * Its stable room key (AGENT_ROOM_ID) identifies it for selection and per-room provider memory.
 */
export const agentRoomConversation = (defaultProvider: AppSnapshot['defaultProvider'], locale: Parameters<typeof desktopTextFor>[0] = 'en'): ConversationSummary => ({
  accountId: AGENT_ROOM_ID, chatType: 'direct', chatId: AGENT_ROOM_ID, title: desktopTextFor(locale, 'agentRoom'), agentEnabled: true,
  defaultProvider, unreadCount: 0, localOnly: true,
});

/** The account's first LINE chat in the list's default (latest-activity) order, same tie-breaks as the list; undefined when it has none. */
export function firstDisplayedConversation(conversations: readonly ConversationSummary[], accountId: string): ConversationSummary | undefined {
  return conversations
    .filter((conversation) => conversation.accountId === accountId && !conversation.localOnly)
    .sort((left, right) => (Date.parse(right.latestMessageAt ?? '') || 0) - (Date.parse(left.latestMessageAt ?? '') || 0)
      || left.accountId.localeCompare(right.accountId) || left.chatType.localeCompare(right.chatType) || left.chatId.localeCompare(right.chatId))[0];
}

export function App({ api = window.lineAgent }: { api?: DesktopApi }) {
  const [localeData, setLocaleData] = useState<Omit<LocaleState, 'retry' | 'retryRestart' | 'restartNow' | 'restartLater' | 'setPreference'>>({ status: 'loading', effectiveLocale: null, preference: null, busy: false, error: null, restartChoice: false, restartPending: false });
  const locale = localeData.effectiveLocale ?? 'en';
  const localizedText = desktopTextFor as (locale: Locale, key: DesktopCopyKey, ...args: [Record<string, unknown>?]) => string;
  const t = (key: DesktopCopyKey, values?: Record<string, unknown>) => values ? localizedText(locale, key, values) : localizedText(locale, key);
  const localeRequest = useRef(0);
  const localeSaveInFlight = useRef(false);
  const localeRestartInFlight = useRef(false);
  const startupLocaleRead = useRef<Promise<LocaleSnapshot> | null>(null);
  const loadLocale = useCallback(async (startup = false) => {
    const request = ++localeRequest.current;
    setLocaleData((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const value = await (startup
        ? (startupLocaleRead.current ??= api.getLocale())
        : api.getLocale());
      if (localeRequest.current !== request) return;
      setLocaleData((current) => ({ ...current, status: 'loaded', effectiveLocale: value.effectiveLocale, preference: value.preference, busy: false, error: null }));
    } catch {
      if (localeRequest.current === request) setLocaleData((current) => ({ ...current, status: 'error', busy: false, error: 'load' }));
    }
  }, [api]);
  const restartForLocale = useCallback(async () => {
    if (localeRestartInFlight.current) return;
    localeRestartInFlight.current = true;
    setLocaleData((current) => ({ ...current, busy: true, error: null }));
    try { await api.restartApplication(); }
    catch { setLocaleData((current) => ({ ...current, busy: false, error: 'restart', restartPending: true, restartChoice: false })); }
    finally { localeRestartInFlight.current = false; }
  }, [api]);
  const setLocalePreference = useCallback(async (candidate: LocalePreference) => {
    const parsed = LocalePreferenceSchema.safeParse(candidate);
    if (!parsed.success || localeData.status !== 'loaded' || localeData.busy || localeSaveInFlight.current || parsed.data === localeData.preference) return;
    const preference = parsed.data;
    localeSaveInFlight.current = true;
    setLocaleData((current) => ({ ...current, busy: true, error: null }));
    try {
      const saved: LocaleSnapshot = await api.setLocale(preference);
      setLocaleData((current) => ({ ...current, preference: saved.preference, busy: false, error: null, restartPending: true, restartChoice: true }));
    } catch {
      setLocaleData((current) => ({ ...current, busy: false, error: 'save' }));
    } finally {
      localeSaveInFlight.current = false;
    }
  }, [api, localeData.busy, localeData.preference, localeData.status]);
  const localeState = useMemo<LocaleState>(() => ({
    ...localeData,
    retry: () => { void loadLocale(); },
    retryRestart: () => { void restartForLocale(); },
    restartNow: () => { setLocaleData((current) => ({ ...current, restartChoice: false })); void restartForLocale(); },
    restartLater: () => { setLocaleData((current) => ({ ...current, restartChoice: false })); },
    setPreference: (preference) => { void setLocalePreference(preference); },
  }), [loadLocale, localeData, restartForLocale, setLocalePreference]);
  useEffect(() => {
    void loadLocale(true);
    return () => { localeRequest.current++; };
  }, [loadLocale]);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(empty);
  const [page, setPage] = useState<Page>(readLastPage);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId>(readInitialSettingsTab);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewAccountId, setViewAccountId] = useState<string | null>(null);
  const [conversationAccountOverrideId, setConversationAccountOverrideId] = useState<string | null>(null);
  const [allAccountsSearchScope, setAllAccountsSearchScope] = useState(false);
  const [searchAccountId, setSearchAccountId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [messageRevisions, setMessageRevisions] = useState<Record<string, number>>({});
  const [sendFeedback, setSendFeedback] = useState<ManualSendFeedback[]>([]);
  const sendFeedbackRef = useRef<ManualSendFeedback[]>([]);
  const pendingSubmitRoutes = useRef(new Set<string>());
  const [lineLogin, setLineLogin] = useState<LineLoginView | null>(null);
  const [setupStatus, setSetupStatus] = useState<DatabaseSetupStatus | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const openConversationRef = useRef<ConversationKey | null>(null);
  const completedImportAccounts = useRef(new Set<string>());
  const railAccounts = visibleRoleAccounts(snapshot.accounts);
  const active = railAccounts.find((account) => account.mode === 'ACTIVE_CONTROL');
  const fallbackAccountId = active?.accountId ?? railAccounts[0]?.accountId ?? null;
  const viewedAccountId = page === 'search' && allAccountsSearchScope ? null : railAccounts.some((account) => account.accountId === viewAccountId)
    ? viewAccountId : fallbackAccountId;
  const searchScopeAccountId = allAccountsSearchScope ? null : snapshot.accounts.some((account) => account.accountId === searchAccountId)
    ? searchAccountId : viewedAccountId;
  const conversationAccountId = snapshot.accounts.some((account) => account.accountId === conversationAccountOverrideId)
    ? conversationAccountOverrideId : railAccounts.some((account) => account.accountId === viewAccountId) ? viewAccountId : fallbackAccountId;
  const agentRoom = agentRoomConversation(snapshot.defaultProvider, locale);
  // The chat list only shows LINE chats; the shared Agent room is the 助理 page.
  const viewedConversations = snapshot.conversations
    .filter((conversation) => conversation.accountId === conversationAccountId && !conversation.localOnly);
  const viewedSnapshot = { ...snapshot, conversations: viewedConversations };
  const chosen = viewedConversations.find((conversation) => keyOf(conversation) === selected) ?? viewedConversations[0];
  openConversationRef.current = chosen ? conversationKey(chosen) : null;

  useEffect(() => {
    const completed = snapshot.accounts.filter((account) => account.externalImportProgress?.stage === 'complete'
      && !completedImportAccounts.current.has(account.accountId));
    if (completed.length === 0) return;
    for (const account of completed) completedImportAccounts.current.add(account.accountId);
    if (!chosen || !completed.some((account) => account.accountId === chosen.accountId)) return;
    const key = keyOf(chosen);
    setMessageRevisions((current) => {
      const next = { ...current, [key]: (current[key] ?? 0) + 1 };
      const keys = Object.keys(next);
      if (keys.length > 500) delete next[keys.find((item) => item !== key)!];
      return next;
    });
  }, [snapshot.accounts, chosen]);

  useEffect(() => {
    let live = true;
    void api.getDatabaseSetupStatus().then(async (databaseSetup) => {
      if (!live) return;
      setSetupStatus(databaseSetup);
      if (!databaseSetup.configured) return;
      const next = await api.getSnapshot();
      if (!live) return;
      setSnapshot(next);
      if (next.components.some((component) => component.name === 'database' && component.status !== 'ready')) { setSettingsInitialTab(openedTab('system')); setPage('settings'); }
      else if (next.accounts.length === 0) { setSettingsInitialTab(openedTab('system')); setPage('settings'); }
    }).catch(() => { if (live) { setError(t('unableToLoadSystemStatusCheckSettingsAndReconnect')); setSettingsInitialTab(openedTab('system')); setPage('settings'); } });
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    try { window.localStorage.setItem(LAST_PAGE_KEY, page); } catch { /* Storage can be disabled; navigation still works. */ }
  }, [page]);

  useEffect(() => {
    let live = true;
    const remove = api.onSnapshot((next) => {
      if (!live) return;
      setSnapshot(next);
    });
    return () => { live = false; remove(); };
  }, [api]);

  useEffect(() => {
    const remove = api.onEvent((event) => {
      if (event.type === 'snapshotChanged') setSnapshot(event.snapshot);
      if (event.type === 'lineAvatarRefreshed') accountAvatarRefreshed(event.accountId, event.ownMid);
      if (event.type === 'controlChanged') setSnapshot((current) => ({ ...current, control: event.control }));
      if (event.type === 'messageStored') {
        setSnapshot((current) => {
          const key = keyOf(event.key);
          const index = current.conversations.findIndex((item) => keyOf(item) === key);
          const conversations = index < 0
            ? [...current.conversations, event.conversation]
            : current.conversations.map((item, itemIndex) => itemIndex === index ? event.conversation : item);
          return { ...current, conversations };
        });
        setMessageRevisions((current) => {
          const key = keyOf(event.key); const next = { ...current, [key]: (current[key] ?? 0) + 1 };
          const keys = Object.keys(next); if (keys.length > 500) delete next[keys.find((item) => item !== key)!];
          return next;
        });
      }
      if (event.type === 'externalMonitorRoundComplete') {
        void api.getSnapshot().then(setSnapshot).catch(() => undefined);
        const openConversation = openConversationRef.current;
        if (openConversation?.accountId === event.accountId) {
          const key = keyOf(openConversation);
          setMessageRevisions((current) => {
            const next = { ...current, [key]: (current[key] ?? 0) + 1 };
            const keys = Object.keys(next);
            if (keys.length > 500) delete next[keys.find((item) => item !== key)!];
            return next;
          });
        }
      }
      if (event.type === 'lineLoginState') setLineLogin((current) => {
        if (event.state === 'connecting') return { accountId: event.accountId, loginAttemptId: event.loginAttemptId,
          state: 'connecting', message: event.message };
        if (event.loginAttemptId === null) {
          if (event.state !== 'reauth_required' && event.state !== 'disconnected') return current;
          if (current && current.accountId !== event.accountId) return current;
          return { accountId: event.accountId, loginAttemptId: null, state: event.state, message: event.message };
        }
        if (current && (current.accountId !== event.accountId || current.loginAttemptId !== event.loginAttemptId)) return current;
        return { accountId: event.accountId, loginAttemptId: null, state: event.state, message: event.message };
      });
      if (event.type === 'lineQr') setLineLogin((current) => current?.state === 'connecting' && current.accountId === event.accountId && current.loginAttemptId === event.loginAttemptId
        ? { ...current, imageDataUrl: event.imageDataUrl } : current);
      if (event.type === 'linePin') setLineLogin((current) => current?.state === 'connecting' && current.accountId === event.accountId && current.loginAttemptId === event.loginAttemptId
        ? { ...current, pin: event.pin } : current);
    });
    return remove;
  }, [api]);

  useEffect(() => { if (page !== 'conversations') heading.current?.focus(); }, [page]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setPage('search'); }
      if (event.key === 'F6' && page === 'conversations') { event.preventDefault(); const ids = ['account-rail', 'conversation-list', 'timeline', 'composer']; const current = ids.findIndex((id) => id === document.activeElement?.id); document.getElementById(ids[(current + 1) % ids.length]!)?.focus(); }
      if (event.altKey && /^[1-4]$/.test(event.key)) { event.preventDefault(); setPage(links[Number(event.key) - 1]!.id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [page]);

  if (!setupStatus) return <LocaleProvider value={localeState}><div className="setup-shell"><p role="status">{t('checkingFirstLaunchSetup')}</p></div></LocaleProvider>;
  if (!setupStatus.configured) return <LocaleProvider value={localeState}><SetupWizard api={api} defaultAttachmentRoot={setupStatus.attachmentRoot ?? ''} defaultAgentWorkspace={setupStatus.agentWorkspace ?? ''} /></LocaleProvider>;
  const coreReady = snapshot.components.filter((component) => component.name === 'database' || component.name === 'lineWorker').every((component) => component.status === 'ready') && snapshot.components.length > 0;
  const lineWorker = snapshot.components.find((component) => component.name === 'lineWorker');
  const awaitingLineLogin = snapshot.accounts.every((account) => account.status !== 'connected') && lineWorker?.status === 'stopped';
  return <LocaleProvider value={localeState}><div className="app-shell">
    <a className="skip-link" href="#conversation-list">{t('skipToChatList')}</a><a className="skip-link" href="#timeline">{t('skipToMessages')}</a><a className="skip-link" href="#composer">{t('skipToComposer')}</a>
    
    <div className="app-body">
      <aside className="sidebar" id="account-rail" tabIndex={-1} aria-label={t('accountsAndNavigation')}>
        <div className="accounts">{railAccounts.map((account) => <div className={`account-item route-${account.mode}${viewedAccountId === account.accountId ? ' selected' : ''}`} key={account.accountId}>
          <button className="account-view" data-account-id={account.accountId} aria-label={t('viewArg0Arg1', { arg0: account.displayName, arg1: account.hasPrimaryAdmin === true ? t('administratorLinked') : '' })} aria-pressed={viewedAccountId === account.accountId} onClick={() => { const first = firstDisplayedConversation(snapshot.conversations, account.accountId); setAllAccountsSearchScope(false); setSearchAccountId(account.accountId); setConversationAccountOverrideId(null); setViewAccountId(account.accountId); setSelected(first ? keyOf(first) : null); setPage(page === 'assistant' ? 'assistant' : 'conversations'); }}><span className="account-avatar-wrap" aria-hidden="true"><LineMediaImage api={api} enabled={account.avatarAvailable === true} target={{ type: 'account', accountId: account.accountId }} fallbackKind="person" className="account-avatar" />{account.hasPrimaryAdmin === true && <span className="admin-crown">♛</span>}</span></button>
        </div>)}</div>
      <nav aria-label={t('mainNavigation')}>{links.map((link) => { const label = t(link.key); return <React.Fragment key={link.id}>{link.id === 'search' && <div className="nav-divider" aria-hidden="true" />}<button className={page === link.id ? 'nav-item selected' : 'nav-item'} onClick={() => { if (link.id === 'settings' && page !== 'settings') setSettingsInitialTab(readStoredSettingsTab() ?? settingsInitialTab); if (link.id === 'search' && !allAccountsSearchScope && searchAccountId === null) setSearchAccountId(viewedAccountId); if (link.id === 'conversations') setConversationAccountOverrideId(null); setPage(link.id); }} title={label} aria-label={label} aria-current={page === link.id ? 'page' : undefined}><span className="nav-short" aria-hidden="true">{label}</span></button></React.Fragment>; })}</nav>
      </aside>
      <main className="main-region">
        {error && <div className="error-banner" role="alert">{generatedMessageText(error)}<button onClick={() => setError('')}>{t('close')}</button></div>}
        {page === 'conversations' && <Conversations api={api} snapshot={viewedSnapshot} conversation={chosen ?? null} selected={selected} onSelect={setSelected} account={snapshot.accounts.find((entry) => entry.accountId === conversationAccountId) ?? null} coreReady={coreReady} showCoreWarning={!coreReady && !awaitingLineLogin} messageRevisions={messageRevisions} sendFeedback={sendFeedback} sendFeedbackRef={sendFeedbackRef} setSendFeedback={setSendFeedback} pendingSubmitRoutes={pendingSubmitRoutes} snapshotToken={snapshot} />}
        {page === 'assistant' && <section className="chat-panel assistant-page" id="active-chat-panel" aria-label={t('assistant')}><AgentRoom api={api} conversation={agentRoom} jobs={snapshot.jobs} providers={snapshot.providers} /></section>}
        {page === 'search' && <Search api={api} accounts={snapshot.accounts} conversations={snapshot.conversations} accountScopeId={searchScopeAccountId} onAccountScopeChange={(accountId) => { setAllAccountsSearchScope(accountId === null); setSearchAccountId(accountId); if (accountId !== null && railAccounts.some((account) => account.accountId === accountId)) setViewAccountId(accountId); }} onOpen={(key) => { setAllAccountsSearchScope(false); setConversationAccountOverrideId(key.accountId); setSelected(keyOf(key)); setPage('conversations'); }} headingRef={heading} />}
        {page === 'jobs' && <Jobs api={api} jobs={snapshot.jobs} headingRef={heading} onNotice={setToast} />}
        {page === 'settings' && <Settings api={api} defaultProvider={snapshot.defaultProvider} providers={snapshot.providers} accounts={snapshot.accounts} components={snapshot.components} initialTab={settingsInitialTab} live={lineLogin} headingRef={heading} onNotice={setToast} onOpenWorkConversation={(key) => { setAllAccountsSearchScope(false); setConversationAccountOverrideId(null); setViewAccountId(key.accountId); setSelected(keyOf(key)); setPage('conversations'); }} />}
      </main>
    </div>
    {toast && <div role="status" className="system-toast">{generatedMessageText(toast)}</div>}
  </div></LocaleProvider>;
}
