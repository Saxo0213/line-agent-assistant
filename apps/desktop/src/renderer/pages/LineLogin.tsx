import { desktopTextFor, generatedMessageText, useDesktopLocale, useDesktopText, useExtraText, useSafeErrorText } from '../desktop-i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ChromeLtsmInstallResult, ChromeLtsmUnavailableStatus, IpcResult, LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { InlineBusy } from '../components/InlineBusy.js';
import { ProgressOverlay } from '../components/ProgressOverlay.js';

export type LineLoginView = { accountId: string; loginAttemptId: string | null; state: 'connecting' | 'connected' | 'disconnected' | 'degraded' | 'reauth_required'; message: string | null; imageDataUrl?: string; pin?: string };
type PendingAction = 'add' | 'restart' | 'login';
/** DESKTOPWIN is the default login method. CHROMEOS needs the LINE Chrome extension files. */
type LoginMethod = 'DESKTOPWIN' | 'CHROMEOS';
/** State of the dialog that explains why Chrome login cannot start. */
type ChromeSetup = { status: ChromeLtsmUnavailableStatus | null; ready: boolean; busy: boolean; notFound: boolean; error: string | null; retry: () => void };
type PendingTarget = string;
type PendingLogin = { target: PendingTarget; action: PendingAction };
const adminBindingErrorKeys = {
  AGENT_ACCOUNT_REQUIRED: 'logInToTheAgentAccountFirst', PRIMARY_ADMIN_ALREADY_BOUND: 'aPrimaryAdministratorIsAlreadyConfigured',
  EXTERNAL_IMPORT_BUSY: 'lineIsBeingReadTryAgainShortly', OFFICIAL_IDENTITY_UNAVAILABLE: 'unableToReadTheCurrentLineAccountOpenLine',
  OFFICIAL_IDENTITY_CHANGED: 'theCurrentLineAccountChangedTryAgain', ADMIN_SLOT_CONFLICT: 'theCurrentLineAccountCannotBeThePrimaryAdministrator',
} as const;
export const OFFICIAL_ACCOUNT_NOT_ACTIVE = desktopTextFor('en', 'theCurrentLineAccountIsNotThePrimaryAdministrator');
export const OFFICIAL_LINE_NOT_READY = desktopTextFor('en', 'openLineAndLogInToThePrimaryAdministrator');
export const OFFICIAL_DATABASES_BUSY = desktopTextFor('en', 'multipleLineDatabasesAreUpdatingTryAgainShortly');
export const LINE_WINDOW_AMBIGUOUS = desktopTextFor('en', 'multipleLineWindowsAreOpenCloseTheOtherWindows');
export const EXTERNAL_MONITOR_INTERRUPTED = desktopTextFor('en', 'externalMonitoringStoppedUnexpectedlyRestartExternalMonitoring');
const knownImportKeys = {
  external_monitor_authority_stale: 'externalMonitorAuthorityChanged',
  external_monitor_checkpoint_changed: 'externalMonitorCheckpointChanged',
  external_monitor_source_changed: 'externalMonitorSourceChanged',
  external_monitor_reader_startup_failed: 'externalMonitorReaderStartupFailed',
  external_monitor_reader_failed: 'externalMonitorReaderFailed',
  external_monitor_database_failed: 'externalMonitorDatabaseFailed',
  external_monitor_unknown: 'externalMonitorFailureUnknown',
  official_account_not_active: 'theCurrentLineAccountIsNotThePrimaryAdministrator',
  reader_source_identity_changed: 'theCurrentLineAccountIsNotThePrimaryAdministrator',
  process_missing: 'openLineAndLogInToThePrimaryAdministrator', key_unavailable: 'openLineAndLogInToThePrimaryAdministrator',
  reader_process_count_invalid: 'openLineAndLogInToThePrimaryAdministrator', candidate_ambiguous: 'multipleLineDatabasesAreUpdatingTryAgainShortly',
  line_window_ambiguous: 'multipleLineWindowsAreOpenCloseTheOtherWindows',
} as const;
const knownImportText = (locale: Parameters<typeof desktopTextFor>[0], code: string): string | undefined => {
  const key = Object.hasOwn(knownImportKeys, code) ? knownImportKeys[code as keyof typeof knownImportKeys] : undefined;
  return key ? desktopTextFor(locale, key) : undefined;
};
const stageText = (locale: Parameters<typeof desktopTextFor>[0], stage: 'checking_source' | 'closing_line_window' | 'copying_snapshot' | 'counting_rows') =>
  desktopTextFor(locale, ({ checking_source: 'checkingLineSource', closing_line_window: 'minimizingLineToTheSystemTray', copying_snapshot: 'preparingImport', counting_rows: 'countingMessages' } as const)[stage]);
const SAFE_ERROR_CODE =/^[a-z0-9_:.-]{1,120}$/;
const MACHINE_CODE =/^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)*$/;
/**
 * Reader codes select catalog copy. A bounded machine code may appear as secondary
 * diagnostic text; arbitrary backend prose is never displayed.
 */
export function describeExternalImportMessage(message: string, locale: Parameters<typeof desktopTextFor>[0] = 'en'): { text: string; code: string | null } {
  const trimmed = message.trim();
  if (!MACHINE_CODE.test(trimmed) || !SAFE_ERROR_CODE.test(trimmed)) return { text: desktopTextFor(locale, 'externalMonitoringStoppedUnexpectedlyRestartExternalMonitoring'), code: null };
  const code = trimmed.slice(trimmed.lastIndexOf(':') + 1);
  return { text: knownImportText(locale, code) ?? knownImportText(locale, trimmed) ?? desktopTextFor(locale, 'externalMonitoringStoppedUnexpectedlyRestartExternalMonitoring'), code: trimmed };
}
export function externalImportMessageText(message: string, locale: Parameters<typeof desktopTextFor>[0] = 'en'): string { return describeExternalImportMessage(message, locale).text; }
const importKey = (account: LineAccountSummary) => `${account.externalImportProgress?.stage ?? ''}|${account.externalImportProgress?.message ?? ''}`;
const maskMid = (mid: string) => `${mid.slice(0, 5)}…${mid.slice(-4)}`;
type Props = { api: DesktopApi; accounts: LineAccountSummary[]; headingRef?: React.RefObject<HTMLHeadingElement | null>; embedded?: boolean; live?: LineLoginView | null; onNotice?: (message: string) => void };

export function LineLogin({ api, accounts, headingRef, embedded = false, live = null, onNotice }: Props) {
  const desktopText = useDesktopText();
  const extraText = useExtraText();
  const safeErrorText = useSafeErrorText();
  const locale = useDesktopLocale();
  const adminBindingErrors = Object.fromEntries(Object.entries(adminBindingErrorKeys).map(([code, key]) => [code, desktopText(key)])) as Record<keyof typeof adminBindingErrorKeys, string>;
  const readingPhaseText = { locating: desktopText('findingLine'), reading_identity: desktopText('readingUserProfile') } as const;
  const importStageText = { checking_source: stageText(locale, 'checking_source'), closing_line_window: stageText(locale, 'closing_line_window'), copying_snapshot: stageText(locale, 'copying_snapshot'), counting_rows: stageText(locale, 'counting_rows') };
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [stoppingExternalImport, setStoppingExternalImport] = useState<string | null>(null);
  const [startingExternalImport, setStartingExternalImport] = useState<string | null>(null);
  const [bindingAdmin, setBindingAdmin] = useState(false);
  const [loggingOut, setLoggingOut] = useState<string | null>(null);
  const [refreshingAvatar, setRefreshingAvatar] = useState<string | null>(null);
  const [approvingSigner, setApprovingSigner] = useState(false);
  const [progress, setProgress] = useState<{ title: string; step: string; error?: string; errorCode?: string | null; confirmation?: string; accountId?: string;
    confirmationAction?: string;
    /** Show the login method choice in the confirmation. */ methodChoice?: boolean;
    /** After 確定: follow the Primary Admin account's first-import progress from the snapshot. */ following?: boolean; followWarning?: string | null } | null>(null);
  const confirmationResolve = useRef<((confirmed: boolean) => void) | null>(null);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('DESKTOPWIN');
  // The ref gives async handlers the newest choice. Some handlers run from older renders.
  const loginMethodRef = useRef<LoginMethod>('DESKTOPWIN');
  const [chromeSetup, setChromeSetup] = useState<ChromeSetup | null>(null);
  // Login method menu of each existing account. An account without an entry shows its current method.
  const [methodByAccount, setMethodByAccount] = useState<Record<string, LoginMethod>>({});
  const accountMethod = (account: LineAccountSummary): LoginMethod => methodByAccount[account.accountId] ?? account.lineTransport ?? 'DESKTOPWIN';
  const chooseLoginMethod = (method: LoginMethod) => { loginMethodRef.current = method; setLoginMethod(method); };
  // Only CHROMEOS goes to main. A request without lineTransport keeps the DESKTOPWIN flow as before.
  const chosenTransport = (): 'CHROMEOS' | undefined => loginMethodRef.current === 'CHROMEOS' ? 'CHROMEOS' : undefined;
  const notify = (message: string) => { if (onNotice) onNotice(message); else setStatus(message); };
  const previousLive = useRef(live);
  const [windowPrompt, setWindowPrompt] = useState<string | null>(null);
  const previousImport = useRef<Map<string, string>>(new Map(accounts.map((account) => [account.accountId, importKey(account)])));
  const [pairing, setPairing] = useState<{ accountId: string; token: string; expiresAt: string } | null>(null);
  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [status]);
  useEffect(() => {
    if (pairing && accounts.some((account) => account.accountId === pairing.accountId && account.hasPrimaryAdmin === true)) {
      setPairing(null);
      notify(desktopText('administratorAdded'));
    }
  }, [accounts, pairing]);
  useEffect(() => {
    const previous = previousLive.current;
    previousLive.current = live;
    if (live?.state === 'connected' && previous?.state === 'connecting'
      && previous.accountId === live.accountId) notify(desktopText('lineLoginSuccessful'));
    else if (live?.state === 'connecting' && (previous?.accountId !== live.accountId || previous?.loginAttemptId !== live.loginAttemptId)) notify(desktopText('loggingInToLine'));
    else if (live?.state === 'degraded' || live?.state === 'disconnected') notify(`LINE ${live.state === 'degraded' ? desktopText('loginError') : desktopText('loggedOut')}`);
  }, [live?.accountId, live?.loginAttemptId, live?.state]);
  useEffect(() => {
    const before = previousImport.current;
    const next = new Map<string, string>();
    let ambiguous: string | null = null;
    for (const account of accounts) {
      const key = importKey(account);
      next.set(account.accountId, key);
      const progressNow = account.externalImportProgress;
      if (!ambiguous && key !== before.get(account.accountId) && progressNow?.stage === 'failed' && progressNow.message
        && describeExternalImportMessage(progressNow.message, locale).code?.endsWith('line_window_ambiguous')) ambiguous = account.accountId;
    }
    previousImport.current = next;
    if (ambiguous) {
      setWindowPrompt((current) => current ?? ambiguous);
      setProgress((current) => current?.title === desktopText('startExternalMonitoring') ? null : current);
    }
  }, [accounts]);
  useEffect(() => api.onEvent?.((event) => {
    if (event.type !== 'agentIdentityMismatch') return;
    const oldName = event.oldDisplayName || accounts.find((account) => account.accountId === event.accountId)?.displayName || 'Agent';
    const newName = event.scannedDisplayName || desktopText('differentLineAccount');
    void requestAgentReplacement(event.accountId, oldName, newName);
  }), [api, accounts]);
  /** Opens the dialog for a Chrome login that cannot start. `retry` runs when the user continues. */
  function showChromeSetup(status: ChromeLtsmUnavailableStatus | null, retry: () => void) {
    setProgress(null);
    setChromeSetup({ status, ready: false, busy: false, notFound: false, error: null, retry });
  }
  /** True when main refused the request with CHROME_LTSM_UNAVAILABLE. The dialog then explains the reason. */
  function chromeRefusal(result: IpcResult, retry: () => void): boolean {
    if (result.ok || result.type !== 'error' || result.code !== 'CHROME_LTSM_UNAVAILABLE') return false;
    showChromeSetup(result.chromeLtsmStatus ?? null, retry);
    return true;
  }
  /** Asks main if the Chrome login can start. If it cannot, show the dialog and return false. */
  async function chromeLoginReady(retry: () => void): Promise<boolean> {
    const result = await api.getChromeLoginAvailability();
    if (result.ok && result.type === 'getChromeLoginAvailability') {
      if (result.status.kind === 'available') return true;
      showChromeSetup(result.status, retry);
      return false;
    }
    if (!chromeRefusal(result, retry)) setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(result) });
    return false;
  }
  function applyChromeInstallResult(result: ChromeLtsmInstallResult) {
    setChromeSetup((current) => {
      if (!current) return current;
      if (result.kind === 'installed') return { ...current, busy: false, ready: true, notFound: false, error: null };
      if (result.kind === 'wrong-version') return { ...current, busy: false, notFound: false, error: null,
        status: { kind: 'wrong-version', required: result.required, detected: result.detected.map((entry) => entry.version) } };
      if (result.kind === 'corrupt') return { ...current, busy: false, notFound: false, error: null,
        status: { kind: 'corrupt', required: result.required, problems: result.problems } };
      return { ...current, busy: false, notFound: true, error: null, status: { kind: 'missing', required: result.required } };
    });
  }
  async function chromeSetupAction(action: 'detect' | 'choose' | 'store') {
    setChromeSetup((current) => current ? { ...current, busy: true, error: null } : current);
    try {
      if (action === 'store') {
        const opened = await api.openChromeExtensionStore();
        setChromeSetup((current) => current ? { ...current, busy: false, error: opened.ok ? null : safeErrorText(opened) } : current);
        return;
      }
      const result = action === 'detect' ? await api.detectChromeLtsm() : await api.chooseChromeLtsmFolder();
      if (!result.ok || (result.type !== 'detectChromeLtsm' && result.type !== 'chooseChromeLtsmFolder')) {
        setChromeSetup((current) => current ? { ...current, busy: false, error: safeErrorText(result) } : current);
      } else if (result.result.kind === 'cancelled') {
        // The user closed the folder picker. Nothing changes.
        setChromeSetup((current) => current ? { ...current, busy: false } : current);
      } else applyChromeInstallResult(result.result);
    } catch (cause) {
      setChromeSetup((current) => current ? { ...current, busy: false, error: safeErrorText(cause) } : current);
    }
  }
  async function requestAgentReplacement(accountId: string, oldName: string, newName?: string) {
    setProgress({ get title() { return desktopText('replaceAgentAccount'); }, step: desktopText('agentArchiveRemainsSeparate'),
      confirmationAction: desktopText('replaceAgentAccount'), methodChoice: true,
      confirmation: newName ? desktopText('replaceAgentAccountWithArg0Arg1', { arg0: oldName, arg1: newName })
        : desktopText('replaceAgentAccountPromptArg0', { arg0: oldName }) });
    const confirmed = await new Promise<boolean>((resolve) => { confirmationResolve.current = resolve; });
    confirmationResolve.current = null;
    if (!confirmed) { setProgress(null); return; }
    await startAgentReplacement(accountId);
  }
  async function startAgentReplacement(accountId: string) {
    setProgress({ get title() { return desktopText('replaceAgentAccount'); }, step: desktopText('startingLogin') });
    try {
      const lineTransport = chosenTransport();
      const retry = () => void startAgentReplacement(accountId);
      if (lineTransport && !await chromeLoginReady(retry)) return;
      const result = lineTransport ? await api.lineReplaceAgentQr(accountId, lineTransport) : await api.lineReplaceAgentQr(accountId);
      if (chromeRefusal(result, retry)) return;
      if (result.ok) setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: desktopText('scanTheQrCodeWithLineOnYourPhone') });
      else setProgress({ get title() { return desktopText('replaceAgentAccount'); }, step: '', error: safeErrorText(result), errorCode: result.type === 'error' ? result.code : null });
    } catch (cause) {
      setProgress({ get title() { return desktopText('replaceAgentAccount'); }, step: '', error: safeErrorText(cause, desktopText('unableToStartLineLogin')) });
    }
  }
  async function addAccount(slot: 'add:agent' | 'add:admin') {
    flushSync(() => setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: desktopText('startingLogin') }));
    setPending({ target: slot, action: 'add' });
    let result: IpcResult;
    const lineTransport = chosenTransport();
    const retry = () => void addAccount(slot);
    try {
      if (lineTransport && !await chromeLoginReady(retry)) return;
      result = lineTransport ? await api.lineAddAccountQr(lineTransport) : await api.lineAddAccountQr();
    }
    catch (cause) { setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(cause, desktopText('unableToStartLineLogin')) }); return; }
    finally { setPending(null); }
    if (chromeRefusal(result, retry)) return;
    if (result.ok) { setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: live?.pin ? desktopText('enterThePinOnYourPhone') : live?.imageDataUrl ? desktopText('scanTheQrCodeWithLineOnYourPhone') : desktopText('loggingIn') }); notify(desktopText('aNewLineAccountLoginHasStarted')); }
    else setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(result) });
  }
  async function restart(accountId: string) {
    flushSync(() => setProgress({ get title() { return desktopText('restartLine'); }, get step() { return desktopText('startingLine'); }, accountId }));
    setPending({ target: accountId, action: 'restart' });
    let result: IpcResult;
    try { result = await api.lineStart(accountId); }
    catch (cause) { setProgress({ get title() { return desktopText('restartLine'); }, step: '', error: safeErrorText(cause, desktopText('unableToRestartLine')) }); return; }
    finally { setPending(null); }
    if (chromeRefusal(result, () => void restart(accountId))) return;
    if (result.ok) {
      setProgress(live?.state === 'connecting' ? { get title() { return desktopText('logInToLineAccount'); }, accountId, step: live.pin ? desktopText('enterThePinOnYourPhone') : live.imageDataUrl ? desktopText('scanTheQrCodeWithLineOnYourPhone') : desktopText('loggingIn') } : null);
      notify(desktopText('syncRestartRequested'));
    }
    else setProgress({ get title() { return desktopText('restartLine'); }, step: '', error: safeErrorText(result) });
  }
  /** Chrome is checked at once. If the local files are not usable, the menu keeps its value and the setup dialog opens. */
  async function chooseAccountMethod(accountId: string, method: LoginMethod) {
    const store = () => setMethodByAccount((current) => ({ ...current, [accountId]: method }));
    if (method === 'CHROMEOS' && !await chromeLoginReady(store)) return;
    store();
  }
  async function relogin(accountId: string) {
    flushSync(() => setProgress({ get title() { return desktopText('logInToLineAccount'); }, get step() { return desktopText('startingLogin'); }, accountId }));
    const monitoring = accounts.find((account) => account.accountId === accountId)?.externalImportProgress?.stage === 'monitoring';
    setPending({ target: accountId, action: 'login' });
    const account = accounts.find((item) => item.accountId === accountId);
    const method = methodByAccount[accountId] ?? account?.lineTransport ?? 'DESKTOPWIN';
    // Only CHROMEOS is sent. DESKTOPWIN is sent only to leave a CHROMEOS account. Otherwise Main keeps the current method.
    const lineTransport = method === 'CHROMEOS' ? 'CHROMEOS' as const : account?.lineTransport === 'CHROMEOS' ? 'DESKTOPWIN' as const : undefined;
    let result: IpcResult;
    try { result = lineTransport ? await api.lineLoginQr(accountId, lineTransport) : await api.lineLoginQr(accountId); }
    catch (cause) { setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(cause, desktopText('unableToStartLineLogin')) }); return; }
    finally { setPending(null); }
    if (chromeRefusal(result, () => void relogin(accountId))) return;
    if (!result.ok) { setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(result) }); return; }
    setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: desktopText('scanTheQrCodeWithLineOnYourPhone') });
    const outcome = desktopText('qrLoginStarted');
    notify(monitoring ? desktopText('loggingInToLineAgainWillStopExternalMonitoring', { arg0: outcome }) : outcome);
  }
  async function logout(account: LineAccountSummary) {
    if (!window.confirm(desktopText('logOutOfArg0ChatHistoryAndAttachmentIndexes', { arg0: account.displayName }))) return;
    setLoggingOut(account.accountId);
    try {
      const result = await api.lineLogout(account.accountId);
      notify(result.ok ? desktopText('arg0LoggedOutHistoryRetained', { arg0: account.displayName }) : safeErrorText(result));
    } catch (cause) { notify(safeErrorText(cause, desktopText('unableToLogOutOfLine'))); }
    finally { setLoggingOut(null); }
  }
  async function refreshAvatar(account: LineAccountSummary) {
    if (refreshingAvatar) return;
    setRefreshingAvatar(account.accountId);
    try {
      const result = await api.refreshLineAvatar(account.accountId);
      notify(result.ok ? desktopText('avatarRefreshed') : safeErrorText(result));
    } catch (error) { notify(safeErrorText(error, desktopText('unableToRefreshAvatar'))); }
    finally { setRefreshingAvatar(null); }
  }
  async function cancelLogin() {
    if (!live?.accountId) { setProgress(null); return; }
    try {
      const result = await api.lineLogout(live.accountId);
      if (!result.ok) { setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(result) }); return; }
      setProgress(null);
    } catch (cause) {
      setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: safeErrorText(cause, desktopText('unableToCancelLineLogin')) });
    }
  }
  async function setAutoLogin(account: LineAccountSummary, enabled: boolean): Promise<boolean> {
    try {
      const result = await api.lineSetAutoLogin(account.accountId, enabled);
      if (!result.ok) { notify(safeErrorText(result)); return false; }
      return true;
    } catch (cause) { notify(safeErrorText(cause, desktopText('unableToUpdateAutomaticLogin'))); return false; }
  }
  async function clearAutoLoginBeforeMonitoring(account: LineAccountSummary | undefined): Promise<string | null> {
    if (!account || account.autoLoginOnStartup !== true) return null;
    try {
      const result = await api.lineSetAutoLogin(account.accountId, false);
      return result.ok ? null : desktopText('unableToDisableAutomaticLoginAtStartupArg0', { arg0: safeErrorText(result) });
    } catch (cause) { return desktopText('unableToDisableAutomaticLoginAtStartupArg0', { arg0: safeErrorText(cause, desktopText('unableToUpdateSettings')) }); }
  }
  async function stopExternalMonitoring(account: LineAccountSummary) {
    if (!window.confirm(desktopText('stopExternalMonitoringForArg0ImportedDataAndSync', { arg0: account.displayName }))) return;
    setStoppingExternalImport(account.accountId);
    try {
      const result = await api.externalImportStop(account.accountId);
      notify(result.ok ? desktopText('externalMonitoringStopped') : safeErrorText(result));
    } catch (cause) {
      notify(safeErrorText(cause, desktopText('unableToStopExternalMonitoring')));
    } finally {
      setStoppingExternalImport(null);
    }
  }
  async function startExternalMonitoring(account: LineAccountSummary) {
    if (startingExternalImport) return;
    setStartingExternalImport(account.accountId);
    flushSync(() => setProgress({ get title() { return desktopText('startExternalMonitoring'); }, get step() { return desktopText('startingExternalMonitoring'); }, accountId: account.accountId }));
    let autoLoginWarning: string | null = null;
    try {
      autoLoginWarning = await clearAutoLoginBeforeMonitoring(account);
      if (autoLoginWarning) setProgress({ get title() { return desktopText('startExternalMonitoring'); }, get step() { return desktopText('startingExternalMonitoring'); }, error: autoLoginWarning, accountId: account.accountId });
      const result = await api.externalImportStart(account.accountId);
      if (result.ok) { if (autoLoginWarning) setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: autoLoginWarning, accountId: account.accountId }); else setProgress(null); notify(desktopText('externalMonitoringStarted')); }
      else setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [autoLoginWarning, safeErrorText(result)].filter(Boolean).join('\n') });
    } catch (cause) { setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [autoLoginWarning, safeErrorText(cause, desktopText('unableToStartExternalMonitoring'))].filter(Boolean).join('\n') }); }
    finally { setStartingExternalImport(null); }
  }
  async function approveOfficialSigner() {
    if (approvingSigner) return;
    setApprovingSigner(true);
    try {
      const result = await api.officialLineApproveSigner();
      notify(result.ok ? desktopText('newLineSigningCertificateConfirmedTheNewVersionWill') : safeErrorText(result));
    } catch (cause) { notify(safeErrorText(cause, desktopText('unableToConfirmLineSigningCertificate'))); }
    finally { setApprovingSigner(false); }
  }
  async function beginAdminPairing(account: LineAccountSummary) {
    try {
      const result = await api.lineBeginAdminPairing(account.accountId);
      setPairing({ accountId: account.accountId, ...result });
      notify(desktopText('primaryAdministratorVerificationMonitoringStartedEnterTheCodeIn'));
    } catch (cause) { notify(safeErrorText(cause, desktopText('unableToCreateAdministratorVerificationCode'))); }
  }
  async function bindAdminFromOfficialLine() {
    if (bindingAdmin) return;
    setBindingAdmin(true);
    flushSync(() => setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: readingPhaseText.locating }));
    let autoLoginWarning: string | null = null;
    let unsubscribePhase: (() => void) | null = null;
    const stopPhaseUpdates = () => { unsubscribePhase?.(); unsubscribePhase = null; };
    unsubscribePhase = api.onEvent((event) => {
      if (event.type !== 'externalAdminBindingProgress') return;
      setProgress((current) => current && current.title === desktopText('startExternalMonitoring') && !current.confirmation && !current.following && !current.error
        ? { ...current, step: readingPhaseText[event.phase] } : current);
    });
    // The sentence stays friendly; a safe machine code (never free text) is returned separately for its own selectable line.
    const failureText = (result: Extract<IpcResult, { ok: false }>): { text: string; code: string | null } => {
      const whole = result.message.trim();
      if (result.code === 'OFFICIAL_IDENTITY_UNAVAILABLE') {
        const last = whole.slice(whole.lastIndexOf(':') + 1);
        return { text: knownImportText(locale, last) ?? knownImportText(locale, whole) ?? adminBindingErrors.OFFICIAL_IDENTITY_UNAVAILABLE!,
          code: SAFE_ERROR_CODE.test(whole) ? whole : null };
      }
      return { text: safeErrorText(result), code: null };
    };
    try {
      const preview = await api.previewExternalAdminBinding();
      stopPhaseUpdates();
      if (!preview.ok) { const failed = failureText(preview); setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: failed.text, errorCode: failed.code }); return; }
      if (preview.type !== 'previewExternalAdminBinding') { setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: desktopText('unableToReadTheCurrentLineAccount') }); return; }
      const name = preview.identity.displayName ?? maskMid(preview.identity.mid);
      setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', confirmation: desktopText('setArg0AsPrimaryAdministrator', { arg0: name }) });
      // The confirmation is rendered in the blocking card so the page cannot change beneath it.
      const confirmed = await new Promise<boolean>((resolve) => { confirmationResolve.current = resolve; });
      confirmationResolve.current = null;
      if (!confirmed) { setProgress(null); return; }
      setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: desktopText('settingPrimaryAdministratorAndStartingExternalMonitoring') });
      const autoLoginWarnings: string[] = [];
      for (const account of accounts.filter((entry) => entry.autoLoginOnStartup === true)) {
        const warning = await clearAutoLoginBeforeMonitoring(account);
        if (warning) autoLoginWarnings.push(warning);
      }
      autoLoginWarning = autoLoginWarnings.length ? autoLoginWarnings.join('\n') : null;
      if (autoLoginWarning) setProgress({ get title() { return desktopText('startExternalMonitoring'); }, get step() { return desktopText('settingPrimaryAdministratorAndStartingExternalMonitoring'); }, error: autoLoginWarning });
      const result = await api.startExternalMonitorAsAdmin(preview.identity.mid);
      if (!result.ok) {
        const failed = failureText(result);
        setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [autoLoginWarning, failed.text].filter(Boolean).join('\n'), errorCode: failed.code });
        return;
      }
      if (result.type !== 'startExternalMonitorAsAdmin') {
        if (autoLoginWarning) setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: autoLoginWarning }); else setProgress(null);
        notify(desktopText('setupRequestSent')); return;
      }
      if (!result.started) { setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [autoLoginWarning,
        desktopText('primaryAdministratorConfiguredButExternalMonitoringDidNotStart', { arg0: externalImportMessageText(result.message ?? '', locale) })].filter(Boolean).join('\n') }); return; }
      // The overlay stays open and follows the first import from the snapshot (see the effect below).
      setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: importStageText.checking_source, following: true, followWarning: autoLoginWarning });
    } catch (cause) {
      setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [autoLoginWarning,
        safeErrorText(cause, desktopText('unableToSetPrimaryAdministratorFromLine'))].filter(Boolean).join('\n') });
    } finally { stopPhaseUpdates(); setBindingAdmin(false); }
  }
  const loginActive = live?.state === 'connecting';
  const agent = accounts.find((account) => account.productRole === 'AGENT');
  const admin = accounts.find((account) => account.productRole === 'PRIMARY_ADMIN');
  const externalMonitoringActive = accounts.some((account) => account.externalImportProgress?.stage === 'monitoring' || account.externalImportProgress?.stage === 'syncing');
  const canBindAdminFromSettings = !admin && (!agent || agent.hasPrimaryAdmin !== true) && !externalMonitoringActive;
  const importStageLabel: Record<NonNullable<LineAccountSummary['externalImportProgress']>['stage'], string> = {
    get checking_source() { return desktopText('checkLineSource'); }, get closing_line_window() { return desktopText('closeLineWindows'); }, get copying_snapshot() { return desktopText('prepareInitialImportCopy'); }, get counting_rows() { return desktopText('countImportableMessages'); },
    get importing_history() { return desktopText('importMessageHistory'); }, get syncing() { return desktopText('syncing'); }, get monitoring() { return desktopText('monitoring'); }, get complete() { return desktopText('historyImportComplete'); }, get failed() { return desktopText('importInterrupted'); },
  };
  const officialBuildText: Record<NonNullable<LineAccountSummary['officialLineBuild']>['status'], string> = {
    get accepted() { return desktopText('compatible'); }, get candidate() { return desktopText('newVersionVerificationOnNextRead'); },
    get key_scan_failed() { return desktopText('compatibilityUpdateRequiredDatabaseKeyNotFound'); }, get schema_changed() { return desktopText('compatibilityUpdateRequiredDataFormatChanged'); },
    get rotation() { return desktopText('signingCertificateChanged'); }, get untrusted() { return desktopText('unableToVerifyThisLineProgram'); },
  };
  const percent = (done: string | null | undefined, total: string | null | undefined): number | undefined => {
    if (done === null || done === undefined || total === null || total === undefined) return undefined;
    try {
      const totalValue = BigInt(total);
      if (totalValue <= 0n) return undefined;
      return Math.min(100, Number(BigInt(done) * 10_000n / totalValue) / 100);
    } catch { return undefined; }
  };
  const externalMonitorAction = (account: LineAccountSummary, compact = false) => {
    const stage = account.externalImportProgress?.stage;
    const monitoring = stage === 'monitoring' || stage === 'syncing';
    const stopping = stoppingExternalImport === account.accountId;
    const starting = startingExternalImport === account.accountId;
    const inProgress = ['checking_source', 'closing_line_window', 'copying_snapshot', 'counting_rows', 'importing_history', 'syncing'].includes(stage ?? '');
    const disabled = monitoring ? stopping : starting || account.status === 'connected' || !account.canStartExternalImport;
    const title = monitoring ? undefined : account.status === 'connected' ? desktopText('logOutOfLineFirst')
      : account.canStartExternalImport ? undefined : account.externalImportProgress && stage !== 'failed' && stage !== 'complete'
        ? desktopText('initialImportIsInProgress') : desktopText('externalMonitoringIsCurrentlyUnavailable');
    return <div className={`external-monitor-action${compact ? ' compact' : ''}`}>
      {stopping && <InlineBusy>{desktopText('stoppingExternalMonitoring')}</InlineBusy>}
      {!starting && !stopping && inProgress && <InlineBusy>{importStageLabel[stage as keyof typeof importStageLabel]}</InlineBusy>}
      {monitoring && <span className="external-monitor-indicator">{desktopText('monitoring')}</span>}
      <button className="primary" disabled={disabled} title={title}
        onClick={() => monitoring ? void stopExternalMonitoring(account) : void startExternalMonitoring(account)}>
        {monitoring ? desktopText('stopExternalMonitoring') : desktopText('startExternalMonitoring')}
      </button>
    </div>;
  };
  const accountCard = (account: LineAccountSummary) => {
    const busy = pending !== null && pending.target === account.accountId;
    const stage = account.externalImportProgress?.stage;
    const monitoring = stage === 'monitoring' || stage === 'syncing';
    const adminMonitoring = monitoring && account.productRole === 'PRIMARY_ADMIN';
    const loggedOut = account.status === 'disconnected' || account.status === 'reauth_required';
    const stopping = stoppingExternalImport === account.accountId;
    const starting = startingExternalImport === account.accountId;
    return <article className={`${embedded ? 'account-record' : 'panel'} route-${account.mode}`} data-account-id={account.accountId} key={account.accountId}>
      {account.lineTransport === 'CHROMEOS' && <p className="login-method-badge">{extraText('loginMethodChrome')}</p>}
      <p>{desktopText('connectionStatus')}{monitoring && account.productRole === 'PRIMARY_ADMIN' ? desktopText('externalMonitoringActive') : account.status === 'connected' ? desktopText('connected') : account.status === 'reauth_required' ? desktopText('lineLoginRequiredAgain') : account.status === 'disconnected' ? desktopText('loggedOut') : desktopText('connectionError')}</p>
      {(!embedded || account.productRole === 'AGENT') && <p>{desktopText('lastSynced')}{account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString(locale) : desktopText('notSyncedYet')}</p>}
      {account.hasPrimaryAdmin === true && <p>{desktopText('primaryAdministratorLinked')}</p>}
      {account.productRole === 'AGENT' && account.hasPrimaryAdmin !== true && account.hasVerifiedLineIdentity !== true && admin
        && <p>{desktopText('primaryAdministratorConfiguredANewAgentAccountWillBe')}</p>}
      {(!embedded && account.productRole === 'PRIMARY_ADMIN') && account.officialLineBuild && <section className="official-line-build" aria-label={desktopText('lineVersionStatus')}>
        <p>{desktopText('lineVersion')}{account.officialLineBuild.version ?? desktopText('unknown')}</p>
        <p role={account.officialLineBuild.status === 'accepted' || account.officialLineBuild.status === 'candidate' ? 'status' : 'alert'}>{officialBuildText[account.officialLineBuild.status]}</p>
        {account.officialLineBuild.status === 'rotation' && <div className="action-with-status"><button disabled={approvingSigner} onClick={() => void approveOfficialSigner()}>{approvingSigner ? desktopText('confirmingNewCertificate') : desktopText('confirmNewCertificate')}</button>{approvingSigner && <InlineBusy>{desktopText('confirmingCertificate')}</InlineBusy>}</div>}
      </section>}
      {(!embedded && account.productRole === 'PRIMARY_ADMIN') && account.externalImportProgress && <section className="external-import-progress" aria-label={desktopText('lineHistoryImportProgress')}>
        <h3>{importStageLabel[account.externalImportProgress.stage]}</h3>
        {account.externalImportProgress.stage === 'copying_snapshot' && <>
          <progress aria-label={desktopText('snapshotCopyProgress')} max={100} {...(percent(account.externalImportProgress.copiedBytes, account.externalImportProgress.totalBytes) === undefined
            ? {} : { value: percent(account.externalImportProgress.copiedBytes, account.externalImportProgress.totalBytes) })} />
          <p>{account.externalImportProgress.copiedBytes ?? '—'} / {account.externalImportProgress.totalBytes ?? desktopText('totalUnknown')} bytes</p>
        </>}
        {['counting_rows', 'importing_history', 'syncing', 'monitoring', 'complete'].includes(account.externalImportProgress.stage) && <>
          <progress aria-label={desktopText('messageHistoryImportProgress')} max={100} {...(percent(account.externalImportProgress.committedRows, account.externalImportProgress.eligibleRows) === undefined
            ? {} : { value: percent(account.externalImportProgress.committedRows, account.externalImportProgress.eligibleRows) })} />
          <p>{desktopText('committed')}{account.externalImportProgress.committedRows} / {account.externalImportProgress.eligibleRows ?? desktopText('totalUnknown445')} {desktopText('messages')}</p>
        </>}
        {account.externalImportProgress.message && (() => {
          const described = describeExternalImportMessage(account.externalImportProgress.message, locale);
          return <p role={account.externalImportProgress.stage === 'failed' ? 'alert' : 'status'}>{described.text}
            {described.code && <small className="error-code"> （{described.code}）</small>}</p>;
        })()}
      </section>}
      {pairing?.accountId === account.accountId && <div className="line-auth-code"><h3>{desktopText('primaryAdministratorVerificationCode')}</h3><output aria-label={desktopText('primaryAdministrator6DigitVerificationCode')}>{pairing.token}</output><p>{desktopText('enterThisCodeBefore')}{new Date(pairing.expiresAt).toLocaleTimeString(locale)} {desktopText('inADirectChatGroupMessagesAreNotAccepted')}</p></div>}
      <label className="auto-login-option"><input type="checkbox" checked={account.autoLoginOnStartup === true} disabled={monitoring}
        title={monitoring ? desktopText('unavailableDuringExternalMonitoring') : undefined} aria-describedby={monitoring ? `auto-login-disabled-${account.accountId}` : undefined}
        onChange={(event) => void setAutoLogin(account, event.target.checked)} /> {desktopText('logInAutomaticallyAtStartup')}</label>
      {monitoring && <span id={`auto-login-disabled-${account.accountId}`} className="sr-only">{desktopText('unavailableDuringExternalMonitoring')}</span>}
      <div className="button-row account-actions">
        {account.status === 'connected' && !monitoring && <button disabled={refreshingAvatar !== null || busy}
          onClick={() => void refreshAvatar(account)}>{refreshingAvatar === account.accountId ? desktopText('refreshingAvatar') : desktopText('refreshAvatar')}</button>}
        {account.productRole === 'AGENT' && account.hasPrimaryAdmin !== true && <button className="primary" onClick={() => void beginAdminPairing(account)}>{desktopText('addAdministrator')}</button>}
        <button disabled={account.status === 'disconnected' || busy} onClick={() => void restart(account.accountId)}>{desktopText('restart')}</button>
        {loggedOut && <button aria-label={`${desktopText('logIn')} ${account.displayName}`} disabled={busy || adminMonitoring} title={adminMonitoring ? desktopText('unavailableDuringExternalMonitoring') : undefined} aria-describedby={adminMonitoring ? `auto-login-disabled-${account.accountId}` : undefined} onClick={() => void relogin(account.accountId)}>{desktopText('logIn')}</button>}
        {account.productRole === 'AGENT' && account.hasVerifiedLineIdentity === true && account.status === 'disconnected' && <button disabled={busy || loginActive}
          onClick={() => void requestAgentReplacement(account.accountId, account.displayName)}>{desktopText('replaceAgentAccount')}</button>}
        <button aria-label={desktopText('logOutArg0', { arg0: account.displayName })} disabled={account.status === 'disconnected' || busy || loggingOut === account.accountId} onClick={() => void logout(account)}>{loggingOut === account.accountId ? desktopText('loggingOut') : desktopText('logOut')}</button>
        <select className="login-method-select" aria-label={extraText('loginMethodLabel')} value={accountMethod(account)}
          disabled={!loggedOut || busy || loginActive || adminMonitoring}
          title={!loggedOut ? extraText('loginMethodLogoutFirst') : adminMonitoring ? desktopText('unavailableDuringExternalMonitoring') : undefined}
          onChange={(event) => void chooseAccountMethod(account.accountId, event.target.value as LoginMethod)}>
          <option value="DESKTOPWIN">{extraText('loginMethodWindows')}</option>
          <option value="CHROMEOS">{extraText('loginMethodChrome')}</option>
        </select>
        {busy && <InlineBusy>{desktopText('startingLineLogin')}</InlineBusy>}
        {loggingOut === account.accountId && <InlineBusy>{desktopText('loggingOut')}</InlineBusy>}
        {!embedded && account.productRole === 'PRIMARY_ADMIN' && account.hasVerifiedLineIdentity === true && externalMonitorAction(account)}
      </div>
    </article>;
  };
  const addPending = pending !== null && pending.action === 'add';
  const methodChoice = <div className="button-row login-method-choice" role="group" aria-label={extraText('loginMethodLabel')}>
    {(['DESKTOPWIN', 'CHROMEOS'] as const).map((method) => <button key={method} type="button" aria-pressed={loginMethod === method}
      className={loginMethod === method ? 'primary' : undefined} disabled={loginActive || addPending}
      onClick={() => chooseLoginMethod(method)}>{method === 'CHROMEOS' ? extraText('loginMethodChrome') : extraText('loginMethodWindows')}</button>)}
  </div>;
  const chromeStatus = chromeSetup?.status ?? null;
  const vacantPending = (slot: PendingTarget) => pending?.target === slot ? desktopText('startingLineLogin') : null;
  const progressAccount = progress?.accountId ? accounts.find((account) => account.accountId === progress.accountId) : undefined;
  const progressImport = progressAccount?.externalImportProgress;
  const followImport = progress?.following ? admin?.externalImportProgress : undefined;
  const followStage = followImport?.stage;
  const followStep = !progress?.following || progress.error ? undefined
    : followStage === 'importing_history'
      ? desktopText('importingIntoDatabaseArg0Arg1Messages', { arg0: followImport!.committedRows, arg1: followImport!.eligibleRows == null ? '' : ` / ${followImport!.eligibleRows}` })
      : followStage === 'checking_source' || followStage === 'closing_line_window' || followStage === 'copying_snapshot' || followStage === 'counting_rows'
        ? importStageText[followStage] : undefined;
  const followMessage = followImport?.message;
  useEffect(() => {
    if (!progress?.following || !followStage) return;
    if (followStage === 'monitoring' || followStage === 'syncing' || followStage === 'complete') {
      const warning = progress.followWarning ?? null;
      if (warning) setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: warning }); else setProgress(null);
      notify(desktopText('primaryAdministratorConfiguredAndExternalMonitoringStarted'));
    } else if (followStage === 'failed') {
      const described = followMessage ? describeExternalImportMessage(followMessage, locale)
        : { text: desktopText('externalMonitoringStoppedUnexpectedlyRestartExternalMonitoring'), code: null };
      if (described.code?.endsWith('line_window_ambiguous')) return; // handled by the window prompt above
      setProgress({ get title() { return desktopText('startExternalMonitoring'); }, step: '', error: [progress.followWarning, described.text].filter(Boolean).join('\n'), errorCode: described.code });
    }
  }, [progress?.following, followStage, followMessage]);
  useEffect(() => {
    if (progress?.title !== desktopText('startExternalMonitoring') || !progressImport) return;
    const stage = importStageLabel[progressImport.stage];
    setProgress((current) => current?.title === desktopText('startExternalMonitoring') ? { ...current, step: stage } : current);
  }, [progress?.title, progressImport?.stage]);
  useEffect(() => {
    if (live?.state === 'connected' && progress?.title === desktopText('logInToLineAccount')) setProgress(null);
    else if (live?.state === 'connecting') setProgress((current) => current?.title === desktopText('logInToLineAccount')
      ? { ...current, accountId: live.accountId, step: live.pin ? desktopText('enterThePinOnYourPhone') : live.imageDataUrl ? desktopText('scanTheQrCodeWithLineOnYourPhone') : desktopText('loggingIn') }
      : current === null ? { get title() { return desktopText('logInToLineAccount'); }, accountId: live.accountId, step: live.pin ? desktopText('enterThePinOnYourPhone') : live.imageDataUrl ? desktopText('scanTheQrCodeWithLineOnYourPhone') : desktopText('loggingIn') } : current);
    else if (live?.state === 'degraded' && progress?.title === desktopText('logInToLineAccount')) setProgress({ get title() { return desktopText('logInToLineAccount'); }, step: '', error: desktopText('lineLoginFailed') });
  }, [live?.state, live?.imageDataUrl, live?.pin, live?.message]);
  const windowPromptAccount = windowPrompt ? accounts.find((account) => account.accountId === windowPrompt) : undefined;
  return <div className={embedded ? 'account-settings' : 'page'}>
    {!embedded && <header className="page-header compact"><div><span className="eyebrow">{extraText('lineAccounts')}</span><div className="page-title-row"><h1 tabIndex={-1} ref={headingRef}>{desktopText('account')}</h1><p>{desktopText('agentAndAdministratorAccounts')}</p></div></div></header>}
    <section className={embedded ? 'panel combined-account-card' : undefined} aria-label={embedded ? desktopText('lineAccountSettings') : undefined}>
    {embedded && <h2 className="combined-account-title">{desktopText('account')}</h2>}
    <div className="account-role-slots">
      <section className="account-role-slot" aria-label={extraText('agentAccountSlot')}><div className="account-role-heading"><h2>Agent</h2><p>{agent?.displayName ?? desktopText('notLoggedIn182')}</p></div>{agent ? accountCard(agent) : <article className={`${embedded ? 'account-record' : 'panel slot-vacant'}`}>{admin ? <p>{desktopText('primaryAdministratorConfiguredANewAgentAccountWillBe')}</p> : null}{methodChoice}<div className="action-with-status"><button className="primary" disabled={loginActive || addPending} onClick={() => void addAccount('add:agent')}>{desktopText('logInToAgentLineAccount')}</button>{vacantPending('add:agent') && <InlineBusy>{vacantPending('add:agent')!}</InlineBusy>}</div></article>}</section>
      <section className="account-role-slot" aria-label={extraText('primaryAdminAccountSlot')}><div className="account-role-heading"><h2>Primary Admin</h2><p>{admin?.displayName ?? desktopText('notLoggedIn182')}</p></div>{admin ? accountCard(admin) : <article className={`${embedded ? 'account-record' : 'panel slot-vacant'}`}>{methodChoice}<div className="action-with-status"><button className="primary" disabled={loginActive || addPending || agent?.hasPrimaryAdmin !== true} onClick={() => void addAccount('add:admin')}>{desktopText('logInToPrimaryAdminLineAccount')}</button>{vacantPending('add:admin') && <InlineBusy>{vacantPending('add:admin')!}</InlineBusy>}</div>
        {embedded && canBindAdminFromSettings && <div className="action-with-status"><button className="primary" disabled={bindingAdmin || addPending} onClick={() => void bindAdminFromOfficialLine()}>{desktopText('setAdministratorFromLineAndStartExternalMonitoring')}</button>{bindingAdmin && <InlineBusy>{desktopText('settingPrimaryAdministrator')}</InlineBusy>}</div>}
        {!embedded && (!agent || agent.hasPrimaryAdmin !== true) && <div className="action-with-status"><button className="primary" disabled={bindingAdmin || addPending} onClick={() => void bindAdminFromOfficialLine()}>{desktopText('setAdministratorFromLineAndStartExternalMonitoring')}</button></div>}</article>}</section>
    </div>
    </section>
    {embedded && <section className="panel external-monitor-card" aria-label={desktopText('externalMonitoring')}><h2>{desktopText('externalMonitoring')}</h2>
      {admin ? <>
        <p>{desktopText('lastSynced')}{admin.lastSyncedAt ? new Date(admin.lastSyncedAt).toLocaleString(locale) : desktopText('notSyncedYet')}</p>
        {admin.officialLineBuild && <section className="official-line-build" aria-label={desktopText('lineVersionStatus')}>
          <p role={admin.officialLineBuild.status === 'accepted' || admin.officialLineBuild.status === 'candidate' ? 'status' : 'alert'}>
            {desktopText('lineVersion')}{admin.officialLineBuild.version ?? desktopText('unknown')}（{officialBuildText[admin.officialLineBuild.status]}）
          </p>
          {admin.officialLineBuild.status === 'rotation' && <div className="action-with-status"><button disabled={approvingSigner} onClick={() => void approveOfficialSigner()}>{approvingSigner ? desktopText('confirmingNewCertificate') : desktopText('confirmNewCertificate')}</button>{approvingSigner && <InlineBusy>{desktopText('confirmingCertificate')}</InlineBusy>}</div>}
        </section>}
        {admin.externalImportProgress && <section className="external-import-progress" aria-label={desktopText('lineHistoryImportProgress')}>
          {admin.externalImportProgress.stage !== 'monitoring' && <h3>{importStageLabel[admin.externalImportProgress.stage]}</h3>}
          {admin.externalImportProgress.stage === 'copying_snapshot' && <><progress aria-label={desktopText('snapshotCopyProgress')} max={100} {...(percent(admin.externalImportProgress.copiedBytes, admin.externalImportProgress.totalBytes) === undefined ? {} : { value: percent(admin.externalImportProgress.copiedBytes, admin.externalImportProgress.totalBytes) })} /><p>{admin.externalImportProgress.copiedBytes ?? '—'} / {admin.externalImportProgress.totalBytes ?? desktopText('totalUnknown')} bytes</p></>}
          {['counting_rows', 'importing_history', 'syncing', 'monitoring', 'complete'].includes(admin.externalImportProgress.stage) && <>
            <div className="external-monitor-layout">
              {['counting_rows', 'importing_history'].includes(admin.externalImportProgress.stage) && <progress aria-label={desktopText('messageHistoryImportProgress')} max={100} {...(percent(admin.externalImportProgress.committedRows, admin.externalImportProgress.eligibleRows) === undefined ? {} : { value: percent(admin.externalImportProgress.committedRows, admin.externalImportProgress.eligibleRows) })} />}
              <div className="external-monitor-count-row">
                <p className="external-monitor-count">{desktopText('committed')}{admin.externalImportProgress.committedRows} / {admin.externalImportProgress.eligibleRows ?? desktopText('totalUnknown445')} {desktopText('messages')}</p>
                {admin.hasVerifiedLineIdentity === true && externalMonitorAction(admin, true)}
              </div>
            </div>
          </>}
          {admin.externalImportProgress.message && (() => { const described = describeExternalImportMessage(admin.externalImportProgress.message, locale); return <p role={admin.externalImportProgress.stage === 'failed' ? 'alert' : 'status'}>{described.text}{described.code && <small className="error-code"> （{described.code}）</small>}</p>; })()}
        </section>}
        {admin.hasVerifiedLineIdentity === true && (!admin.externalImportProgress || !['counting_rows', 'importing_history', 'syncing', 'monitoring', 'complete'].includes(admin.externalImportProgress.stage)) && externalMonitorAction(admin)}
      </> : <p>{desktopText('logInToThePrimaryAdminAccountToConfigure')}</p>}
    </section>}
    {!onNotice && status && <div role="status" className="system-toast">{generatedMessageText(status)}</div>}
    {progress && <ProgressOverlay title={generatedMessageText(progress.title)} step={followStep ?? progress.step} error={progress.error ?? null} errorCode={progress.errorCode ?? null}
      spinner={!progress.confirmation} onClose={() => setProgress(null)}>
      {progress.confirmation && <><p className="progress-confirmation">{progress.confirmation}</p>{progress.methodChoice && methodChoice}<div className="progress-actions"><button onClick={() => confirmationResolve.current?.(false)}>{desktopText('cancel')}</button><button className="primary" onClick={() => confirmationResolve.current?.(true)}>{progress.confirmationAction ?? desktopText('confirm')}</button></div></>}
      {followImport?.stage === 'copying_snapshot' && <progress aria-label={desktopText('snapshotCopyProgress')} max={100} {...(percent(followImport.copiedBytes, followImport.totalBytes) === undefined
        ? {} : { value: percent(followImport.copiedBytes, followImport.totalBytes) })} />}
      {followImport?.stage === 'importing_history' && <progress aria-label={desktopText('messageHistoryImportProgress')} max={100} {...(percent(followImport.committedRows, followImport.eligibleRows) === undefined
        ? {} : { value: percent(followImport.committedRows, followImport.eligibleRows) })} />}
      {progressImport && ['counting_rows', 'importing_history', 'syncing', 'monitoring', 'complete'].includes(progressImport.stage) && <p>{desktopText('committed')}{progressImport.committedRows} / {progressImport.eligibleRows ?? desktopText('totalUnknown445')} {desktopText('messages')}</p>}
      {progress.title === desktopText('logInToLineAccount') && live?.state === 'connecting' && live.imageDataUrl && !live.pin && <img src={live.imageDataUrl} alt={desktopText('lineLoginQrCode')} width="320" height="320" />}
      {progress.title === desktopText('logInToLineAccount') && live?.state === 'connecting' && live.pin && <div className="line-auth-code"><h3>{desktopText('enterVerificationCodeOnYourPhone')}</h3><output aria-label={desktopText('line6DigitVerificationCode')}>{live.pin}</output></div>}
      {progress.title === desktopText('logInToLineAccount') && live?.state === 'connecting' && <div className="progress-actions"><button onClick={() => void cancelLogin()}>{desktopText('cancelLogin')}</button></div>}
    </ProgressOverlay>}
    {chromeSetup && <ProgressOverlay title={extraText(chromeSetup.ready ? 'chromeLoginReadyTitle' : 'chromeLoginUnavailableTitle')} step="" spinner={false}>
      {chromeSetup.ready ? <p role="status">{extraText('chromeLoginReady')}</p> : <>
        <p>{extraText('chromeLoginNeedsExtension')}</p>
        {chromeStatus?.kind === 'wrong-version' && <>
          <p>{extraText('chromeLoginRequiredVersion')}{chromeStatus.required}</p>
          <p>{extraText('chromeLoginDetectedVersions')}{chromeStatus.detected.length ? chromeStatus.detected.join(', ') : extraText('chromeLoginNoneDetected')}</p>
        </>}
        {chromeStatus?.kind === 'corrupt' && <p>{extraText('chromeLoginCorrupt')}</p>}
        {chromeSetup.notFound && <p role="status">{extraText('chromeLoginNotFound')}</p>}
      </>}
      {chromeSetup.error && <p role="alert" className="progress-error">{chromeSetup.error}</p>}
      {chromeSetup.busy && <InlineBusy>{extraText('chromeLoginDetecting')}</InlineBusy>}
      <div className="progress-actions">
        {!chromeSetup.ready && <>
          <button disabled={chromeSetup.busy} onClick={() => void chromeSetupAction('store')}>{extraText('chromeLoginInstallExtension')}</button>
          <button disabled={chromeSetup.busy} onClick={() => void chromeSetupAction('detect')}>{extraText('chromeLoginRedetect')}</button>
          <button disabled={chromeSetup.busy} onClick={() => void chromeSetupAction('choose')}>{extraText('chromeLoginChooseFolder')}</button>
        </>}
        <button disabled={chromeSetup.busy} onClick={() => setChromeSetup(null)}>{desktopText('cancel')}</button>
        {chromeSetup.ready && <button className="primary" onClick={() => { const retry = chromeSetup.retry; setChromeSetup(null); retry(); }}>{extraText('chromeLoginContinue')}</button>}
      </div>
    </ProgressOverlay>}
    {windowPromptAccount && <ProgressOverlay title={desktopText('startExternalMonitoring')} spinner={false}
      step={desktopText('multipleLineWindowsAreOpenSoTheMainWindow')}>
      <div className="progress-actions"><button onClick={() => setWindowPrompt(null)}>{desktopText('cancel')}</button>
        <button className="primary" onClick={() => { setWindowPrompt(null); void startExternalMonitoring(windowPromptAccount); }}>{desktopText('continue')}</button></div>
    </ProgressOverlay>}
  </div>;
}
