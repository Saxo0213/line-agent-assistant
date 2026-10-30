// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderWithoutLocale, screen, waitFor } from '@testing-library/react';
import type { IpcEvent, IpcResult, LineAccountSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { LineLogin } from './LineLogin.js';
import { accountAvatarRefreshed, LineMediaImage } from '../LineMediaImage.js';
import { desktopTextFor, extraTextFor } from '../desktop-i18n.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  ['en', 'LINE could not find the requested data.'],
  ['zh-TW', 'LINE 找不到指定資料。'],
  ['ja', 'LINE で指定されたデータが見つかりません。'],
  ['ko', 'LINE에서 요청한 데이터를 찾을 수 없습니다.'],
] as const)('shows a fixed %s profile rejection in the account card', async (locale, expected) => {
  const secret = 'token=private MID=u-private message=private';
  const result: IpcResult = { type: 'error', requestId: 'profile', ok: false, code: 'LINE_PROFILE_REFRESH_FAILED',
    serverErrorCode: 'LINE_TALK_NOT_FOUND', message: secret, retryable: true };
  const api = { refreshLineAvatar: vi.fn(async () => result) } as unknown as DesktopApi;
  const onNotice = vi.fn();
  render(<LineLogin api={api} accounts={[{ ...buildAdmin(), status: 'connected' }]} headingRef={React.createRef()} onNotice={onNotice} />, locale);
  fireEvent.click(screen.getByRole('button', { name: desktopTextFor(locale, 'refreshAvatar') }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expected));
  expect(document.body.textContent).not.toContain(secret);
});

it('reloads the connected account avatar after a successful explicit refresh', async () => {
  const account = { ...buildAdmin(), status: 'connected' as const };
  const ownMid = `u${'e'.repeat(32)}`;
  const listeners: ((event: IpcEvent) => void)[] = [];
  const refreshLineAvatar = vi.fn(async () => ({ ...accepted, ownMid }));
  const api = { refreshLineAvatar, onEvent: vi.fn((listener: (event: IpcEvent) => void) => {
    listeners.push(listener);
    return () => { listeners.splice(listeners.indexOf(listener), 1); };
  }) } as unknown as DesktopApi;
  function AvatarEventHost() {
    React.useEffect(() => api.onEvent((event) => {
      if (event.type === 'lineAvatarRefreshed') accountAvatarRefreshed(event.accountId, event.ownMid);
    }), []);
    return null;
  }
  const view = render(<><LineMediaImage enabled target={{ type: 'account', accountId: account.accountId }} fallbackKind="person" className="avatar" alt="account" />
    <LineMediaImage enabled target={{ type: 'conversation', accountId: account.accountId, chatType: 'direct', chatId: ownMid }} fallbackKind="person" className="avatar" alt="own direct chat" />
    <LineMediaImage enabled target={{ type: 'conversation', accountId: account.accountId, chatType: 'direct', chatId: 'u-peer' }} fallbackKind="person" className="avatar" alt="peer direct chat" />
    <LineLogin api={api} accounts={[account]} headingRef={React.createRef()} /><AvatarEventHost /></>);
  const beforeAccount = screen.getByAltText('account');
  const beforeOwn = screen.getByAltText('own direct chat');
  const beforePeer = screen.getByAltText('peer direct chat');
  fireEvent.click(screen.getByRole('button', { name: '更新頭像' }));
  await waitFor(() => expect(refreshLineAvatar).toHaveBeenCalledWith(account.accountId));
  act(() => listeners.forEach((listener) => listener({ type: 'lineAvatarRefreshed', accountId: account.accountId, ownMid })));
  await waitFor(() => expect(screen.getByAltText('account')).not.toBe(beforeAccount));
  expect(screen.getByAltText('account').getAttribute('src')).toBe(beforeAccount.getAttribute('src'));
  await waitFor(() => expect(screen.getByAltText('own direct chat')).not.toBe(beforeOwn));
  expect(screen.getByAltText('own direct chat').getAttribute('src')).toBe(beforeOwn.getAttribute('src'));
  expect(screen.getByAltText('peer direct chat')).toBe(beforePeer);
});

function render(ui: React.ReactElement, locale: LocaleState['effectiveLocale'] = 'zh-TW') {
  const state: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null,
    retry() {}, retryRestart() {}, setPreference() {} };
  return renderWithoutLocale(ui, { wrapper: ({ children }) => <LocaleProvider value={state}>{children}</LocaleProvider> });
}

describe('account card button layout (theme-independent: spacing and alignment only)', () => {
  const css = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
  const rule = (selector: string) => css.match(new RegExp(`(?:^|})${selector.replaceAll('.', '\\.').replaceAll('>', '\\>')}\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  it('left-aligns and stacks vacant-slot buttons with an 8px gap at natural width', () => {
    const vacant = rule('.slot-vacant');
    expect(vacant).toContain('flex-direction:column');
    expect(vacant).toContain('align-items:flex-start');
    expect(vacant).toContain('gap:8px');
    expect(vacant).not.toContain('align-items:center');
  });
  it('keeps the external monitor status and button together at the right end of the action row', () => {
    const monitor = rule('.external-monitor-action');
    expect(monitor).toContain('flex-wrap:nowrap');
    expect(monitor).toContain('align-items:center');
    expect(monitor).toContain('text-align:left');
    expect(monitor).toContain('margin-left:auto');
    expect(monitor).not.toContain('flex-basis:100%');
    expect(rule('.auto-login-option')).toContain('white-space:nowrap');
    expect(rule('.button-row')).toContain('gap:8px');
    expect(rule('.inline-busy')).toContain('align-items:center');
    expect(rule('.action-with-status')).toContain('flex-wrap:wrap');
  });
});

type Build = NonNullable<LineAccountSummary['officialLineBuild']>;
const buildAdmin = (officialLineBuild?: Build | null): LineAccountSummary => ({
  accountId: 'admin-1', displayName: 'Admin', status: 'disconnected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN',
  hasVerifiedLineIdentity: true, canStartExternalImport: true, ...(officialLineBuild === undefined ? {} : { officialLineBuild }),
});
const buildAgent: LineAccountSummary = { accountId: 'buildAgent-1', displayName: 'Agent', status: 'disconnected', lastSyncedAt: null,
  mode: 'MONITOR_ONLY', productRole: 'AGENT', hasPrimaryAdmin: true };

function renderBuildPage(accounts: LineAccountSummary[], overrides: Partial<DesktopApi> = {}) {
  const api = {
    lineSetAutoLogin: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
    officialLineApproveSigner: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
    externalImportStart: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
    ...overrides,
  } as unknown as DesktopApi;
  const onNotice = vi.fn();
  render(<LineLogin api={api} accounts={accounts} headingRef={React.createRef()} onNotice={onNotice} />);
  return { api, onNotice };
}

describe('official LINE build status on the Primary Admin card', () => {
  it('uses LINE without the official qualifier in visible account-page copy', () => {
    renderBuildPage([buildAgent, buildAdmin({ version: '26.5.0.3975', status: 'accepted' })]);
    expect(document.body.textContent).not.toMatch(/官方\s*LINE|官方LINE/);
  });

  it.each([
    ['accepted', '相容'],
    ['candidate', '新版本，下次讀取時驗證'],
    ['key_scan_failed', '需要相容性更新（找不到資料庫金鑰）'],
    ['schema_changed', '需要相容性更新（資料格式變更）'],
    ['rotation', '簽署憑證已變更'],
    ['untrusted', '無法驗證此 LINE 程式'],
  ] as const)('shows the version and the %s status text', (status, text) => {
    renderBuildPage([buildAgent, buildAdmin({ version: '26.5.0.3975', status })]);
    const section = screen.getByLabelText('LINE 版本狀態');
    expect(section.textContent).toContain('LINE 版本：26.5.0.3975');
    expect(section.textContent).toContain(text);
    expect(section.textContent).not.toMatch(/[0-9a-f]{40}|[A-Za-z]:\\|sha/i);
    expect(!!screen.queryByRole('button', { name: '確認新憑證' })).toBe(status === 'rotation');
  });

  it('shows nothing before any reader session has observed a build, and never on the Agent card', () => {
    renderBuildPage([{ ...buildAgent, officialLineBuild: { version: '26.5.0.3975', status: 'accepted' } }, buildAdmin(null)]);
    expect(screen.queryByLabelText('LINE 版本狀態')).toBeNull();
  });

  it('shows an unknown version without inventing one', () => {
    renderBuildPage([buildAgent, buildAdmin({ version: null, status: 'untrusted' })]);
    expect(screen.getByLabelText('LINE 版本狀態').textContent).toContain('LINE 版本：未知');
  });

  it('approves the new signer only through the payload-free IPC and reports the result', async () => {
    const { api, onNotice } = renderBuildPage([buildAgent, buildAdmin({ version: '26.5.0.3975', status: 'rotation' })]);
    fireEvent.click(screen.getByRole('button', { name: '確認新憑證' }));
    await waitFor(() => expect(api.officialLineApproveSigner).toHaveBeenCalledTimes(1));
    expect(api.officialLineApproveSigner).toHaveBeenCalledWith();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('已確認新的 LINE 簽署憑證')));
    expect(api.externalImportStart).not.toHaveBeenCalled();
  });

  it('surfaces a failed approval message instead of claiming success', async () => {
    const { onNotice } = renderBuildPage([buildAgent, buildAdmin({ version: '26.5.0.3975', status: 'rotation' })], {
      officialLineApproveSigner: vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'OFFICIAL_SIGNER_NOT_PENDING',
        message: '目前沒有待確認的 LINE 簽署憑證。', retryable: false } as const)),
    });
    fireEvent.click(screen.getByRole('button', { name: '確認新憑證' }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('目前沒有待確認的 LINE 簽署憑證。'));
  });

  it('keeps 啟動外部監控 as the retry action without a separate recheck job', () => {
    renderBuildPage([buildAgent, buildAdmin({ version: '26.5.0.3975', status: 'key_scan_failed' })]);
    expect(screen.getByRole('button', { name: '啟動外部監控' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新檢查/ })).toBeNull();
  });
});

describe('embedded external monitor card', () => {
  const importing = (stage: 'monitoring' | 'importing_history', committedRows: string, eligibleRows: string) => ({
    stage, copiedBytes: null, totalBytes: null, committedRows, eligibleRows, message: null,
  }) as unknown as NonNullable<LineAccountSummary['externalImportProgress']>;
  const renderEmbedded = (admin: LineAccountSummary) => {
    const api = {} as unknown as DesktopApi;
    render(<LineLogin api={api} accounts={[buildAgent, admin]} headingRef={React.createRef()} embedded />);
  };

  it('hides the import count while monitoring and keeps one stop button in the version row', () => {
    renderEmbedded({ ...buildAdmin({ version: '26.5.0.3975', status: 'accepted' }), externalImportProgress: importing('monitoring', '4560', '4560') });
    expect(screen.queryByText(/已提交/)).toBeNull();
    expect(screen.getByText('監控中')).toBeTruthy();
    const stops = screen.getAllByRole('button', { name: '關閉外部監控' });
    expect(stops).toHaveLength(1);
    const row = document.querySelector('.external-monitor-version-row')!;
    expect(row.contains(stops[0]!)).toBe(true);
    expect(row.textContent).toContain('LINE 版本：26.5.0.3975');
  });

  it('shows the count during the first history import', () => {
    renderEmbedded({ ...buildAdmin({ version: '26.5.0.3975', status: 'accepted' }), externalImportProgress: importing('importing_history', '250', '1000') });
    expect(screen.getByText('已提交 250 / 1000 則訊息')).toBeTruthy();
  });

  it('renders the stop button one time when no LINE build is known', () => {
    renderEmbedded({ ...buildAdmin(null), externalImportProgress: importing('monitoring', '4560', '4560') });
    expect(screen.getAllByRole('button', { name: '關閉外部監控' })).toHaveLength(1);
    expect(document.querySelector('.external-monitor-version-row')?.querySelector('button')).toBeTruthy();
  });
});

describe('inline account action status', () => {
  const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

  it('shows LINE reading while the admin preview is pending and clears it after cancellation', async () => {
    const preview = deferred<IpcResult>();
    const listeners: Array<(event: IpcEvent) => void> = [];
    const unsubscribe = vi.fn();
    const api = { previewExternalAdminBinding: vi.fn(() => preview.promise),
      onEvent: vi.fn((listener: (event: IpcEvent) => void) => { listeners.push(listener); return unsubscribe; }) } as unknown as DesktopApi;
    render(<LineLogin api={api} accounts={[]} headingRef={React.createRef()} onNotice={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '管理者帳號(LINE監控模式)' }));
    expect(await screen.findByText('尋找 LINE…')).toBeTruthy();
    expect(document.querySelector('.progress-spinner')).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'externalAdminBindingProgress', phase: 'locating' })));
    expect(screen.getByText('尋找 LINE…')).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'externalAdminBindingProgress', phase: 'reading_identity' })));
    expect(screen.getByText('讀取使用者資料…')).toBeTruthy();
    expect(screen.queryByText('尋找 LINE…')).toBeNull();
    preview.resolve({ type: 'previewExternalAdminBinding', requestId: 'x', ok: true,
      identity: { mid: 'u12345678901234567890123456789012', displayName: '管理者' }, otherCandidates: 0 } as unknown as IpcResult);
    // The confirmation is one sentence with no step line and no spinner.
    expect(await screen.findByText('將「管理者」設為主要管理者？')).toBeTruthy();
    expect(screen.queryByText('讀取使用者資料…')).toBeNull();
    expect(screen.queryByText('請確認以下設定')).toBeNull();
    expect(document.querySelector('.progress-spinner')).toBeNull();
    expect(document.querySelectorAll('.progress-card p')).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows start feedback and disables the monitor button while start is pending', async () => {
    const start = deferred<IpcResult>();
    const { api } = renderBuildPage([buildAdmin()], { externalImportStart: vi.fn(() => start.promise) });
    const button = screen.getByRole('button', { name: '啟動外部監控' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(await screen.findByText('啟動外部監控中…')).toBeTruthy();
    expect(button.disabled).toBe(true);
    start.resolve({ type: 'accepted', requestId: 'x', ok: true });
    await waitFor(() => expect(screen.queryByText('啟動外部監控中…')).toBeNull());
  });

  it('keeps the whole-window overlay through binding preview, confirmation, and monitor start', async () => {
    const preview = deferred<IpcResult>();
    const start = deferred<IpcResult>();
    const lineSetAutoLogin = vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const));
    const api = { previewExternalAdminBinding: vi.fn(() => preview.promise), startExternalMonitorAsAdmin: vi.fn(() => start.promise), lineSetAutoLogin,
      onEvent: vi.fn(() => () => undefined) } as unknown as DesktopApi;
    const onNotice = vi.fn();
    const agentOnly = [{ ...buildAgent, hasPrimaryAdmin: false, autoLoginOnStartup: true } as LineAccountSummary];
    const page = (accounts: LineAccountSummary[]) => <div className="app-shell"><button onClick={() => undefined}>任務</button><LineLogin api={api} accounts={accounts}
      headingRef={React.createRef()} onNotice={onNotice} /></div>;
    const { rerender } = render(page(agentOnly));
    fireEvent.click(screen.getByRole('button', { name: '管理者帳號(LINE監控模式)' }));
    expect(screen.getByRole('dialog', { name: '啟動外部監控' })).toBeTruthy();
    expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true);
    expect(api.previewExternalAdminBinding).toHaveBeenCalledTimes(1);
    preview.resolve({ type: 'previewExternalAdminBinding', requestId: 'x', ok: true,
      identity: { mid: 'u12345678901234567890123456789012', displayName: '管理者' }, otherCandidates: 0 } as unknown as IpcResult);
    expect(await screen.findByText('將「管理者」設為主要管理者？')).toBeTruthy();
    expect(document.querySelector('.app-shell button')?.textContent).toBe('任務');
    expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.startExternalMonitorAsAdmin).toHaveBeenCalledTimes(1));
    expect(lineSetAutoLogin).toHaveBeenCalledWith('buildAgent-1', false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('設定主要管理者並啟動外部監控中…')).toBeTruthy();
    expect(document.querySelector('.progress-spinner')).toBeTruthy();
    start.resolve({ type: 'startExternalMonitorAsAdmin', requestId: 'x', ok: true, started: true } as unknown as IpcResult);
    // The overlay stays open and follows the first import of the new Primary Admin account.
    expect(await screen.findByText('檢查 LINE 來源…')).toBeTruthy();
    const admin = (externalImportProgress: NonNullable<LineAccountSummary['externalImportProgress']>) => [{ ...agentOnly[0]!, hasPrimaryAdmin: true },
      { ...buildAdmin(), externalImportProgress }];
    const progress = (stage: NonNullable<LineAccountSummary['externalImportProgress']>['stage'], extra: Partial<NonNullable<LineAccountSummary['externalImportProgress']>> = {}) =>
      ({ stage, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null, message: null, ...extra });
    rerender(page(admin(progress('closing_line_window'))));
    expect(screen.getByText('將 LINE 視窗關到系統匣…')).toBeTruthy();
    rerender(page(admin(progress('copying_snapshot', { copiedBytes: '50', totalBytes: '100' }))));
    expect(screen.getByText('準備匯入…')).toBeTruthy();
    expect((document.querySelector('.progress-card progress') as HTMLProgressElement).value).toBe(50);
    rerender(page(admin(progress('counting_rows'))));
    expect(screen.getByText('計算訊息數量…')).toBeTruthy();
    rerender(page(admin(progress('importing_history', { committedRows: '250', eligibleRows: '1000' }))));
    expect(screen.getByText('匯入資料庫… 250 / 1000 則')).toBeTruthy();
    expect((document.querySelector('.progress-card progress') as HTMLProgressElement).value).toBe(25);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onNotice).not.toHaveBeenCalledWith('已設定主要管理者並啟動外部監控。');
    rerender(page(admin(progress('monitoring', { committedRows: '1000', eligibleRows: '1000' }))));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onNotice).toHaveBeenCalledWith('已設定主要管理者並啟動外部監控。');
    expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false);
  });

  it('shows the friendly sentence and the error code when the first import fails after confirmation', async () => {
    const api = { previewExternalAdminBinding: vi.fn(async () => ({ type: 'previewExternalAdminBinding', requestId: 'x', ok: true,
      identity: { mid: 'u12345678901234567890123456789012', displayName: '管理者' }, otherCandidates: 0 }) as unknown as IpcResult),
    startExternalMonitorAsAdmin: vi.fn(async () => ({ type: 'startExternalMonitorAsAdmin', requestId: 'x', ok: true, started: true }) as unknown as IpcResult),
    onEvent: vi.fn(() => () => undefined) } as unknown as DesktopApi;
    const agentOnly = [{ ...buildAgent, hasPrimaryAdmin: false } as LineAccountSummary];
    const page = (accounts: LineAccountSummary[]) => <LineLogin api={api} accounts={accounts} headingRef={React.createRef()} onNotice={() => undefined} />;
    const { rerender } = render(page(agentOnly));
    fireEvent.click(screen.getByRole('button', { name: '管理者帳號(LINE監控模式)' }));
    fireEvent.click(await screen.findByRole('button', { name: '確定' }));
    expect(await screen.findByText('檢查 LINE 來源…')).toBeTruthy();
    rerender(page([{ ...agentOnly[0]!, hasPrimaryAdmin: true }, { ...buildAdmin(), externalImportProgress: { stage: 'failed', copiedBytes: null,
      totalBytes: null, committedRows: '0', eligibleRows: null, message: 'reader_source_unsupported:key_unavailable' } }]));
    await waitFor(() => expect(document.querySelector('.progress-card .progress-error')?.textContent).toBe('請先開啟 LINE 並登入主要管理者帳號，再啟動外部監控。'));
    expect((await screen.findByText(/^錯誤代碼：/)).textContent).toBe('錯誤代碼：reader_source_unsupported:key_unavailable');
  });

  it('shows an external-monitor failure in the overlay until closed', async () => {
    renderBuildPage([buildAdmin()], { externalImportStart: vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false,
      code: 'FAILED', message: '啟動失敗', retryable: false } as const)) });
    fireEvent.click(screen.getByRole('button', { name: '啟動外部監控' }));
    expect((await screen.findByRole('alert')).textContent).toContain(extraTextFor('zh-TW', 'operationFailed'));
    fireEvent.click(screen.getByRole('button', { name: '關閉' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders login QR inside the blocking card and cancels the login', async () => {
    const api = { lineLoginQr: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
      lineLogout: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)) } as unknown as DesktopApi;
    const { rerender } = render(<LineLogin api={api} accounts={[{ ...buildAgent, accountId: 'agent-1' }]} headingRef={React.createRef()}
      live={{ accountId: 'agent-1', loginAttemptId: 'attempt-1', state: 'connecting', message: null, imageDataUrl: 'data:image/png;base64,abc' }} />);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img[alt="LINE QR 登入碼"]')).toBeTruthy();
    expect(dialog.textContent).toContain('請用手機 LINE 掃描 QR Code');
    fireEvent.click(screen.getByRole('button', { name: '取消登入' }));
    await waitFor(() => expect(api.lineLogout).toHaveBeenCalledWith('agent-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rerender(<LineLogin api={api} accounts={[{ ...buildAgent, accountId: 'agent-1' }]} headingRef={React.createRef()} />);
  });

  it('keeps the automatic-login checkbox and label text in one left-aligned row', () => {
    renderBuildPage([{ ...buildAdmin(), autoLoginOnStartup: true } as LineAccountSummary]);
    const option = screen.getByLabelText('啟動時自動登入').closest('label');
    expect(option?.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(option?.textContent).toContain('啟動時自動登入');
    expect(option?.classList.contains('auto-login-option')).toBe(true);
  });

  it('disables automatic login while monitoring and leaves it enabled otherwise', () => {
    const { rerender } = render(<LineLogin api={{ lineSetAutoLogin: vi.fn() } as unknown as DesktopApi}
      accounts={[{ ...buildAdmin(), externalImportProgress: { stage: 'monitoring', copiedBytes: null, totalBytes: null,
        committedRows: '0', eligibleRows: null, message: null } } as unknown as LineAccountSummary]}
      headingRef={React.createRef()} onNotice={() => undefined} />);
    expect((screen.getByLabelText('啟動時自動登入') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('外部監控中無法使用', { selector: '.sr-only' })).toBeTruthy();
    rerender(<LineLogin api={{ lineSetAutoLogin: vi.fn() } as unknown as DesktopApi}
      accounts={[buildAdmin()]} headingRef={React.createRef()} onNotice={() => undefined} />);
    expect((screen.getByLabelText('啟動時自動登入') as HTMLInputElement).disabled).toBe(false);
  });

  it('disables the Primary Admin login button while external monitoring runs and leaves the Agent button enabled', () => {
    const progress = (stage: 'monitoring' | 'syncing') => ({ stage, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null, message: null });
    const accounts = (admin: LineAccountSummary) => [buildAgent, admin];
    const page = (list: LineAccountSummary[]) => <LineLogin api={{ lineSetAutoLogin: vi.fn() } as unknown as DesktopApi}
      accounts={list} headingRef={React.createRef()} onNotice={() => undefined} />;
    const adminButton = () => screen.getByRole('button', { name: '登入 Admin' }) as HTMLButtonElement;
    const agentButton = () => screen.getByRole('button', { name: '登入 Agent' }) as HTMLButtonElement;
    const { rerender } = render(page(accounts({ ...buildAdmin(), externalImportProgress: progress('monitoring') } as unknown as LineAccountSummary)));
    expect(adminButton().disabled).toBe(true);
    expect(adminButton().title).toBe('外部監控中無法使用');
    expect(adminButton().getAttribute('aria-describedby')).toBe('auto-login-disabled-admin-1');
    expect(document.getElementById('auto-login-disabled-admin-1')?.textContent).toBe('外部監控中無法使用');
    expect(agentButton().disabled).toBe(false);
    rerender(page(accounts({ ...buildAdmin(), externalImportProgress: progress('syncing') } as unknown as LineAccountSummary)));
    expect(adminButton().disabled).toBe(true);
    expect(agentButton().disabled).toBe(false);
    rerender(page(accounts(buildAdmin())));
    expect(adminButton().disabled).toBe(false);
    expect(adminButton().getAttribute('aria-describedby')).toBeNull();
  });

  it('clears automatic login before starting monitoring and reports a failed clear in the overlay', async () => {
    const lineSetAutoLogin = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'FAILED', message: '設定失敗', retryable: false } as const));
    const externalImportStart = vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const));
    const { api } = renderBuildPage([{ ...buildAdmin(), autoLoginOnStartup: true } as LineAccountSummary], { lineSetAutoLogin, externalImportStart });
    fireEvent.click(screen.getByRole('button', { name: '啟動外部監控' }));
    await waitFor(() => expect(lineSetAutoLogin).toHaveBeenCalledWith('admin-1', false));
    await waitFor(() => expect(externalImportStart).toHaveBeenCalledWith('admin-1'));
    expect(await screen.findByText(`無法取消「啟動時自動登入」：${extraTextFor('zh-TW', 'operationFailed')}`)).toBeTruthy();
  });

  it('shows the active import stage beside the monitor action', () => {
    const account = { ...buildAdmin(), externalImportProgress: { stage: 'checking_source', copiedBytes: null, totalBytes: null,
      committedRows: '0', eligibleRows: null, message: null } } as unknown as LineAccountSummary;
    renderBuildPage([account]);
    const button = screen.getByRole('button', { name: '啟動外部監控' });
    expect(button.parentElement?.textContent).toContain('檢查 LINE 來源');
    expect(button.parentElement?.firstElementChild?.textContent).toContain('檢查 LINE 來源');
    expect(button.parentElement?.lastElementChild).toBe(button);
  });
});

it('offers an explicit, archive-separate confirmation after a mismatched Agent QR login', async () => {
  const listeners: Array<(event: IpcEvent) => void> = [];
  const lineReplaceAgentQr = vi.fn(async () => ({ type: 'accepted', requestId: 'replace', ok: true } as const));
  const api = { lineReplaceAgentQr, onEvent: vi.fn((listener: (event: IpcEvent) => void) => {
    listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); };
  }) } as unknown as DesktopApi;
  render(<LineLogin api={api} accounts={[{ ...buildAgent, displayName: 'Old account', hasVerifiedLineIdentity: true }]} headingRef={React.createRef()} />);
  act(() => listeners.forEach((listener) => listener({ type: 'agentIdentityMismatch', accountId: buildAgent.accountId,
    loginAttemptId: '11111111-1111-4111-8111-111111111111', oldDisplayName: 'Old account', scannedDisplayName: 'New account' })));
  expect(await screen.findByText('要將「Old account」更換為剛掃描的 LINE 帳號「New account」嗎？')).toBeTruthy();
  expect(screen.getByText('舊帳號的聊天與附件會保留在舊帳號下；新帳號會從頭分開開始。')).toBeTruthy();
  expect(document.body.textContent).not.toContain('11111111-1111-4111-8111-111111111111');
  fireEvent.click(screen.getAllByRole('button', { name: '更換 Agent 帳號' }).at(-1)!);
  await waitFor(() => expect(lineReplaceAgentQr).toHaveBeenCalledWith(buildAgent.accountId));
});

it('lets the operator choose replacement before scanning and leaves the old account untouched on cancel', async () => {
  const lineReplaceAgentQr = vi.fn(async () => ({ type: 'accepted', requestId: 'replace', ok: true } as const));
  const api = { lineReplaceAgentQr } as unknown as DesktopApi;
  render(<LineLogin api={api} accounts={[{ ...buildAgent, displayName: 'Old account', hasVerifiedLineIdentity: true }]} headingRef={React.createRef()} />);
  fireEvent.click(screen.getByRole('button', { name: '更換 Agent 帳號' }));
  expect(await screen.findByText('要將 Agent 帳號「Old account」更換為新的 LINE 帳號嗎？')).toBeTruthy();
  expect(screen.getByText('舊帳號的聊天與附件會保留在舊帳號下；新帳號會從頭分開開始。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(lineReplaceAgentQr).not.toHaveBeenCalled();
});


const accepted: IpcResult = { type: 'accepted', requestId: 'x', ok: true };

const agent = { accountId: 'account-A', displayName: '工作', status: 'disconnected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL',
  productRole: 'AGENT', canSendManually: true } as unknown as LineAccountSummary;

function setup() {
  const lineLoginQr = vi.fn(async () => accepted);
  const lineStart = vi.fn(async () => accepted);
  const lineAddAccountQr = vi.fn(async () => accepted);
  const notices: string[] = [];
  const api = { lineLoginQr, lineStart, lineAddAccountQr } as unknown as DesktopApi;
  const view = (accounts: LineAccountSummary[]) => render(<LineLogin api={api} accounts={accounts}
    headingRef={{ current: null }} onNotice={(message) => notices.push(message)} />);
  return { lineLoginQr, lineStart, lineAddAccountQr, notices, view };
}

describe('LineLogin does not inspect or confirm the official LINE process', () => {
  it('starts add, restart, and QR login directly with one request each', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { lineLoginQr, lineStart, lineAddAccountQr, notices, view } = setup();
    view([{ ...agent, status: 'disconnected' } as LineAccountSummary]);
    fireEvent.click(screen.getByRole('button', { name: '登入 工作' }));
    await waitFor(() => expect(lineLoginQr).toHaveBeenCalledOnce());
    expect(lineLoginQr).toHaveBeenCalledWith('account-A');
    expect(confirm).not.toHaveBeenCalled();
    cleanup();
    view([{ ...agent, status: 'connected' } as LineAccountSummary]);
    fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
    await waitFor(() => expect(lineStart).toHaveBeenCalledOnce());
    expect(lineStart).toHaveBeenCalledWith('account-A');
    expect(confirm).not.toHaveBeenCalled();
    cleanup();
    view([]);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    await waitFor(() => expect(lineAddAccountQr).toHaveBeenCalledOnce());
    expect(lineAddAccountQr).toHaveBeenCalledWith();
    expect(confirm).not.toHaveBeenCalled();
    expect(notices.length).toBeGreaterThan(0);
  });
});

describe('accounts page header', () => {
  it('shows only the Agent and Primary Admin account sections', () => {
    const historical = { ...buildAgent, accountId: 'historical-1', displayName: '舊 Agent 帳號', productRole: null,
      hasVerifiedLineIdentity: true } satisfies LineAccountSummary;
    renderBuildPage([buildAgent, buildAdmin(), historical]);
    expect(document.querySelectorAll('.account-role-slot')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('舊 Agent 帳號');
    expect(document.body.textContent).not.toContain('歷史 Agent 帳號');
  });

  it('shows the description on the same row as the title', () => {
    renderBuildPage([buildAgent]);
    const row = screen.getByRole('heading', { name: '帳號' }).parentElement!;
    expect(row.className).toBe('page-title-row');
    expect(row.textContent).toContain('Agent 帳號與管理者帳號。');
    expect(row.closest('header')!.className).toContain('compact');
  });

  it.each([
    ['en', 'Account', 'Log in to Agent LINE account'],
    ['zh-TW', '帳號', '登入 Agent LINE 帳號'],
  ] as const)('renders login copy from the %s startup locale', (locale, heading, loginLabel) => {
    render(<LineLogin api={{} as DesktopApi} accounts={[]} headingRef={React.createRef()} />, locale);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByRole('button', { name: loginLabel })).toBeTruthy();
  });
});

describe('LINE login method choice', () => {
  const availability = (status: unknown) => ({ type: 'getChromeLoginAvailability', requestId: 'a', ok: true, status }) as unknown as IpcResult;
  const unavailableError = (chromeLtsmStatus: unknown) => ({ type: 'error', requestId: 'e', ok: false, code: 'CHROME_LTSM_UNAVAILABLE',
    message: 'x', retryable: false, chromeLtsmStatus }) as unknown as IpcResult;
  const install = (type: 'detectChromeLtsm' | 'chooseChromeLtsmFolder', result: unknown) => ({ type, requestId: 'i', ok: true, result }) as unknown as IpcResult;
  const chromeApi = (overrides: Record<string, unknown> = {}) => ({
    lineAddAccountQr: vi.fn(async (..._args: unknown[]) => accepted),
    lineReplaceAgentQr: vi.fn(async (..._args: unknown[]) => accepted),
    getChromeLoginAvailability: vi.fn(async () => availability({ kind: 'available', version: '3.7.2' })),
    detectChromeLtsm: vi.fn(async () => install('detectChromeLtsm', { kind: 'not-found', required: '3.7.2' })),
    chooseChromeLtsmFolder: vi.fn(async () => install('chooseChromeLtsmFolder', { kind: 'cancelled' })),
    openChromeExtensionStore: vi.fn(async () => ({ type: 'openChromeExtensionStore', requestId: 's', ok: true }) as unknown as IpcResult),
    ...overrides,
  });
  const renderChrome = (api: ReturnType<typeof chromeApi>, accounts: LineAccountSummary[] = []) =>
    render(<LineLogin api={api as unknown as DesktopApi} accounts={accounts} headingRef={React.createRef()} onNotice={() => undefined} />);

  it('offers the two methods with Windows selected by default', () => {
    renderChrome(chromeApi());
    const windows = screen.getAllByRole('button', { name: 'Windows 版' })[0]!;
    const chrome = screen.getAllByRole('button', { name: 'Chrome 版' })[0]!;
    expect(windows.getAttribute('aria-pressed')).toBe('true');
    expect(chrome.getAttribute('aria-pressed')).toBe('false');
  });

  it('checks availability first and then starts the Chrome login with lineTransport', async () => {
    const api = chromeApi();
    renderChrome(api);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    await waitFor(() => expect(api.lineAddAccountQr).toHaveBeenCalledWith('CHROMEOS'));
    expect(api.getChromeLoginAvailability).toHaveBeenCalledOnce();
    expect(api.getChromeLoginAvailability.mock.invocationCallOrder[0]!).toBeLessThan(api.lineAddAccountQr.mock.invocationCallOrder[0]!);
  });

  it('does not check Chrome availability for the default Windows login', async () => {
    const api = chromeApi();
    renderChrome(api);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    await waitFor(() => expect(api.lineAddAccountQr).toHaveBeenCalledWith());
    expect(api.getChromeLoginAvailability).not.toHaveBeenCalled();
  });

  it('shows the required and the detected versions and starts no login when the version is wrong', async () => {
    const api = chromeApi({ getChromeLoginAvailability: vi.fn(async () => availability({ kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0', '3.6.1'] })) });
    renderChrome(api);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    expect(await screen.findByText('Chrome 版登入需要在這台電腦上安裝官方 LINE Chrome 擴充功能 3.7.2。')).toBeTruthy();
    expect(screen.getByText('所需版本：3.7.2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '無法使用 Chrome 版登入' })).toBeTruthy();
    expect(screen.getByText('偵測到的版本：3.8.0, 3.6.1')).toBeTruthy();
    expect(api.lineAddAccountQr).not.toHaveBeenCalled();
  });

  it('tells the user that damaged files are damaged', async () => {
    const api = chromeApi({ getChromeLoginAvailability: vi.fn(async () => availability({ kind: 'corrupt', required: '3.7.2', problems: ['md5'] })) });
    renderChrome(api);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    expect(await screen.findByText('擴充功能檔案已損壞，請重新偵測或重新選擇資料夾。')).toBeTruthy();
  });

  it('runs the three actions and lets the user continue after a match is installed', async () => {
    const api = chromeApi({ getChromeLoginAvailability: vi.fn(async () => availability({ kind: 'missing', required: '3.7.2' })) });
    renderChrome(api);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    fireEvent.click(await screen.findByRole('button', { name: '安裝 LINE Chrome 擴充功能' }));
    await waitFor(() => expect(api.openChromeExtensionStore).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: '重新偵測' }));
    expect(await screen.findByText('這台電腦上找不到擴充功能。')).toBeTruthy();
    expect(api.detectChromeLtsm).toHaveBeenCalledOnce();
    // A cancelled folder picker changes nothing.
    fireEvent.click(screen.getByRole('button', { name: '手動選擇資料夾' }));
    await waitFor(() => expect(api.chooseChromeLtsmFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole('button', { name: '手動選擇資料夾' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: '繼續登入' })).toBeNull();
    expect(screen.getByText('這台電腦上找不到擴充功能。')).toBeTruthy();
    // A chosen folder that matches lets the user continue.
    api.chooseChromeLtsmFolder.mockResolvedValueOnce(install('chooseChromeLtsmFolder', { kind: 'installed', status: { kind: 'available', version: '3.7.2' }, source: { browser: 'manual', profile: '' } }));
    api.getChromeLoginAvailability.mockResolvedValue(availability({ kind: 'available', version: '3.7.2' }));
    fireEvent.click(screen.getByRole('button', { name: '手動選擇資料夾' }));
    expect(await screen.findByRole('heading', { name: '可以使用 Chrome 版登入' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '無法使用 Chrome 版登入' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '繼續登入' }));
    await waitFor(() => expect(api.lineAddAccountQr).toHaveBeenCalledWith('CHROMEOS'));
  });

  it('shows the same explanation when the start request returns CHROME_LTSM_UNAVAILABLE', async () => {
    const api = chromeApi({ lineAddAccountQr: vi.fn(async () => unavailableError({ kind: 'wrong-version', required: '3.7.2', detected: ['3.9.0'] })) });
    renderChrome(api);
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '登入 Agent LINE 帳號' }));
    expect(await screen.findByText('偵測到的版本：3.9.0')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeTruthy();
  });

  it('passes the chosen method when the Agent account is replaced', async () => {
    const api = chromeApi();
    renderChrome(api, [{ ...buildAgent, displayName: 'Old account', hasVerifiedLineIdentity: true }]);
    fireEvent.click(screen.getByRole('button', { name: '更換 Agent 帳號' }));
    await screen.findByText('要將 Agent 帳號「Old account」更換為新的 LINE 帳號嗎？');
    fireEvent.click(screen.getAllByRole('button', { name: 'Chrome 版' }).at(-1)!);
    fireEvent.click(screen.getAllByRole('button', { name: '更換 Agent 帳號' }).at(-1)!);
    await waitFor(() => expect(api.lineReplaceAgentQr).toHaveBeenCalledWith(buildAgent.accountId, 'CHROMEOS'));
  });

  it('labels only Chrome accounts', () => {
    renderChrome(chromeApi(), [{ ...buildAgent, lineTransport: 'CHROMEOS' } as LineAccountSummary]);
    expect(document.querySelector('.login-method-badge')?.textContent).toBe('Chrome 版');
    cleanup();
    renderChrome(chromeApi(), [{ ...buildAgent, lineTransport: 'DESKTOPWIN' } as LineAccountSummary]);
    expect(document.querySelector('.login-method-badge')).toBeNull();
  });

  it.each([
    ['en', 'Chrome login needs the official LINE Chrome extension 3.7.2 on this computer.'],
    ['ja', 'Chrome 版ログインには、このコンピューターに公式の LINE Chrome 拡張機能 3.7.2 が必要です。'],
    ['ko', 'Chrome 버전 로그인에는 이 컴퓨터에 공식 LINE Chrome 확장 프로그램 3.7.2가 필요합니다.'],
  ] as const)('writes the unavailable explanation in %s', (locale, expected) => {
    expect(extraTextFor(locale, 'chromeLoginNeedsExtension')).toBe(expected);
  });
});

describe('login method menu of an existing account', () => {
  const availability = (status: unknown) => ({ type: 'getChromeLoginAvailability', requestId: 'a', ok: true, status }) as unknown as IpcResult;
  const menuApi = (status: unknown = { kind: 'available', version: '3.7.2' }) => ({
    lineLoginQr: vi.fn(async (..._args: unknown[]) => accepted),
    getChromeLoginAvailability: vi.fn(async () => availability(status)),
    detectChromeLtsm: vi.fn(), chooseChromeLtsmFolder: vi.fn(), openChromeExtensionStore: vi.fn(),
  });
  const show = (api: ReturnType<typeof menuApi>, account: Partial<LineAccountSummary> = {}, live: React.ComponentProps<typeof LineLogin>['live'] = null) =>
    render(<LineLogin api={api as unknown as DesktopApi} accounts={[{ ...buildAgent, ...account } as LineAccountSummary]}
      headingRef={React.createRef()} onNotice={() => undefined} live={live} />);
  const menu = () => screen.getByRole('combobox', { name: '登入方式' }) as HTMLSelectElement;
  const loginButton = () => screen.getByRole('button', { name: '登入 Agent' });

  it('shows the current method of the account', () => {
    show(menuApi(), { lineTransport: 'CHROMEOS' });
    expect(menu().value).toBe('CHROMEOS');
    cleanup();
    show(menuApi());
    expect(menu().value).toBe('DESKTOPWIN');
  });

  it('keeps Chrome when it is available and sends it with the login', async () => {
    const api = menuApi();
    show(api);
    fireEvent.change(menu(), { target: { value: 'CHROMEOS' } });
    await waitFor(() => expect(menu().value).toBe('CHROMEOS'));
    expect(api.getChromeLoginAvailability).toHaveBeenCalledOnce();
    expect(api.lineLoginQr).not.toHaveBeenCalled();
    fireEvent.click(loginButton());
    await waitFor(() => expect(api.lineLoginQr).toHaveBeenCalledWith(buildAgent.accountId, 'CHROMEOS'));
  });

  it('keeps Windows and shows the setup dialog when the Chrome version is wrong', async () => {
    const api = menuApi({ kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0'] });
    show(api);
    fireEvent.change(menu(), { target: { value: 'CHROMEOS' } });
    expect(await screen.findByText('偵測到的版本：3.8.0')).toBeTruthy();
    expect(menu().value).toBe('DESKTOPWIN');
    expect(api.lineLoginQr).not.toHaveBeenCalled();
  });

  it('sends the login without lineTransport for Windows', async () => {
    const api = menuApi();
    show(api);
    fireEvent.click(loginButton());
    await waitFor(() => expect(api.lineLoginQr).toHaveBeenCalledWith(buildAgent.accountId));
    expect(api.getChromeLoginAvailability).not.toHaveBeenCalled();
  });

  it('sends DESKTOPWIN only to leave a Chrome account', async () => {
    const api = menuApi();
    show(api, { lineTransport: 'CHROMEOS' });
    fireEvent.change(menu(), { target: { value: 'DESKTOPWIN' } });
    await waitFor(() => expect(menu().value).toBe('DESKTOPWIN'));
    fireEvent.click(loginButton());
    await waitFor(() => expect(api.lineLoginQr).toHaveBeenCalledWith(buildAgent.accountId, 'DESKTOPWIN'));
  });

  it('is enabled only while the account is logged out', () => {
    for (const status of ['disconnected', 'reauth_required'] as const) {
      show(menuApi(), { status });
      expect(menu().disabled).toBe(false);
      expect(menu().title).toBe('');
      cleanup();
    }
    for (const status of ['connected', 'degraded'] as const) {
      show(menuApi(), { status });
      expect(menu().disabled).toBe(true);
      expect(menu().title).toBe('登出後才能切換登入方式');
      cleanup();
    }
  });

  it('shows the login button only for a logged-out account', () => {
    for (const status of ['connected', 'degraded'] as const) {
      show(menuApi(), { status });
      expect(screen.queryByRole('button', { name: /^(重新)?登入 Agent$/ })).toBeNull();
      expect(screen.queryAllByRole('button', { name: /^(重新)?登入/ }).filter((button) => button.getAttribute('aria-label')?.endsWith('Agent') || button.textContent === '登入')).toHaveLength(0);
      expect(screen.getByRole('button', { name: '重新啟動' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '登出 Agent' })).toBeTruthy();
      cleanup();
    }
    for (const status of ['disconnected', 'reauth_required'] as const) {
      show(menuApi(), { status });
      expect(screen.getByRole('button', { name: '登入 Agent' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /重新登入/ })).toBeNull();
      cleanup();
    }
  });

  it('is disabled during a login and for the Primary Admin while monitoring', () => {
    show(menuApi(), {}, { accountId: buildAgent.accountId, loginAttemptId: 'attempt-1', state: 'connecting', message: null });
    expect(menu().disabled).toBe(true);
    cleanup();
    render(<LineLogin api={menuApi() as unknown as DesktopApi} headingRef={React.createRef()} onNotice={() => undefined}
      accounts={[{ ...buildAdmin(), externalImportProgress: { stage: 'monitoring' } } as unknown as LineAccountSummary]} />);
    expect(menu().disabled).toBe(true);
  });
});
