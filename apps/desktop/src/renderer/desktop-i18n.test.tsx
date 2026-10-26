// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { URL as NodeURL } from 'node:url';
import { IpcResultSchema, RELATION_ADD_SERVER_ERRORS, TALK_SERVER_ERRORS, type AppSnapshot } from '@line-agent/contracts';
import { lineServerErrorText } from './line-server-error-copy.js';
import { App } from './App.js';
import { WorkRecords } from './pages/WorkRecords.js';
import { SetupWizard } from './pages/SetupWizard.js';
import { ENGLISH_DESKTOP_COPY, TRADITIONAL_CHINESE_DESKTOP_COPY } from '../desktop-copy.js';
import { desktopTextFor, extraTextFor, generatedMessageText, generatedPreviewFor, safeErrorText, safeErrorTextFor, systemLabelFor, useDesktopLocale, useDesktopText, useSafeErrorText, JAPANESE_DESKTOP_COPY, KOREAN_DESKTOP_COPY } from './desktop-i18n.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';
import type { DesktopApi } from '../preload/api.js';
import { nativeDesktopText } from '../desktop-system-copy.js';
import { DESKTOP_ERROR_COPY } from '../desktop-error-copy.js';
import { describeExternalImportMessage } from './pages/LineLogin.js';

beforeEach(() => { localStorage.clear(); });

it('provides fixed en, zh-TW, ja, and ko copy for all 121 Talk and 8 Relation codes', () => {
  const codes = [...Object.keys(TALK_SERVER_ERRORS).map((name) => `LINE_TALK_${name}`),
    ...Object.keys(RELATION_ADD_SERVER_ERRORS).map((name) => `LINE_RELATION_ADD_${name}`)];
  expect(codes).toHaveLength(129);
  for (const code of codes) {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
      const copy = lineServerErrorText(locale, code);
      expect(copy, `${locale}:${code}`).toBeTruthy();
      expect(copy).not.toContain('token=private');
    }
  }
  for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
    expect(lineServerErrorText(locale, 'LINE_TALK_PRIVATE_MESSAGE')).toBeNull();
    expect(lineServerErrorText(locale, 'LINE_RELATION_ADD_PRIVATE_MESSAGE')).toBeNull();
  }
});
afterEach(() => { cleanup(); });
const original = '原始聊天：圖片，請勿翻譯';
const snapshot: AppSnapshot = {
  control: { epoch: 1, activeAccountId: 'account', targetAccountId: null, phase: 'idle' }, defaultProvider: 'codex', queueDepth: 0,
  components: [{ name: 'database', status: 'ready', message: null, lastSuccessAt: null, restartCount: 0 }, { name: 'lineWorker', status: 'ready', message: null, lastSuccessAt: null, restartCount: 0 }],
  providers: [], accounts: [{ accountId: 'account', displayName: 'My account', status: 'connected', mode: 'ACTIVE_CONTROL', lastSyncedAt: null, canSendManually: true }],
  conversations: [{ accountId: 'account', chatType: 'direct', chatId: 'chat', title: 'Customer', agentEnabled: false, defaultProvider: 'codex', unreadCount: 0, latestMessagePreview: original }], jobs: [],
};
function apiFixture() {
  const api = {
    getLocale: vi.fn(async () => ({ preference: 'en', effectiveLocale: 'en' })),
    getSnapshot: vi.fn(async () => snapshot),
    getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: '', agentWorkspace: '', connection: null })),
    getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3 })),
    onSnapshot: vi.fn(() => () => undefined), onEvent: vi.fn(() => () => undefined),
    listMessages: vi.fn(async () => ({ messages: [], olderCursor: null })), listFriends: vi.fn(async () => []),
    listAttachmentStates: vi.fn(async () => []), listAgentStatuses: vi.fn(async () => []),
    searchMessages: vi.fn(async () => []),
    getAgentExecutionPolicy: vi.fn(async () => ({ level: 'read_only', approvalTimeoutSeconds: 60, timeoutAction: 'deny', version: 1 })),
  } as unknown as DesktopApi;
  return { api };
}

describe('English desktop source', () => {
  it('uses the effective main locale for native dialog and tray copy', () => {
    expect(nativeDesktopText('en', 'attachmentFolder')).toBe('Choose a LINE attachment folder');
    expect(nativeDesktopText('en', 'showConsole')).toBe('Show console');
    expect(nativeDesktopText('ja', 'quit')).toBe('終了');
    expect(nativeDesktopText('ko', 'agentWorkspace')).toBe('Agent 작업 공간 선택');
    expect(nativeDesktopText('zh-TW', 'showConsole')).toBe('顯示操作台');
    expect(nativeDesktopText('ja', 'attachmentFolder')).toBe('LINE 添付ファイルフォルダーを選択');
    expect(nativeDesktopText('ko', 'quit')).toBe('종료');
  });
  it('provides complete extra and system maps with representative localized output', () => {
    expect(extraTextFor('zh-TW', 'automaticReplyConflict')).toContain('設定');
    expect(extraTextFor('ja', 'operationFailed')).toContain('操作');
    expect(extraTextFor('ko', 'operationFailed')).toContain('작업');
    expect(systemLabelFor('ja', '系統啟動')).toBe('システム起動');
    expect(systemLabelFor('ko', '系統啟動')).toBe('시스템 시작');
    expect(systemLabelFor('zh-TW', '系統啟動')).toBe('系統啟動');
    expect(systemLabelFor('en', '相簿照片下載')).toBe('Album photo download');
    expect(systemLabelFor('ja', '相簿照片下載')).toBe('アルバム写真をダウンロード');
    expect(systemLabelFor('ko', '相簿照片下載')).toBe('앨범 사진 다운로드');
  });
  it('has a complete English source and matching interpolation slots in the retained catalog', () => {
    expect(desktopTextFor('en', 'chats')).toBe('Chats');
    expect(desktopTextFor('zh-TW', 'chats')).toBe('聊天');
    for (const [key, text] of Object.entries(ENGLISH_DESKTOP_COPY)) {
      expect(text, key).not.toMatch(/\p{Script=Han}/u);
      const slots = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map((match) => match[0]).sort();
      expect(slots(TRADITIONAL_CHINESE_DESKTOP_COPY[key as keyof typeof ENGLISH_DESKTOP_COPY]), key).toEqual(slots(text));
    }
    for (const copy of Object.values(DESKTOP_ERROR_COPY)) expect(copy.en).not.toMatch(/\p{Script=Han}/u);
  });

  it('uses Agent only for compact sidebar navigation while preserving assistant copy', () => {
    expect(desktopTextFor('en', 'agentNavigation')).toBe('Agent');
    expect(desktopTextFor('ja', 'agentNavigation')).toBe('Agent');
    expect(desktopTextFor('ko', 'agentNavigation')).toBe('Agent');
    expect(desktopTextFor('zh-TW', 'agentNavigation')).toBe('助理');
    expect(desktopTextFor('en', 'assistant')).toBe('Assistant');
    expect(desktopTextFor('ja', 'assistant')).toBe('アシスタント');
    expect(desktopTextFor('ko', 'assistant')).toBe('어시스턴트');
    expect(desktopTextFor('zh-TW', 'assistant')).toBe('助理');
  });

  it('keeps application copy in typed catalogs', () => {
    const root = fileURLToPath(new NodeURL('.', import.meta.url));
    for (const path of readdirSync(root, { recursive: true }).map(String).filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))) {
      const code = readFileSync(`${root}/${path}`, 'utf8');
      // The only retained literals are language endonyms, accepted command aliases, and legacy wire-enum comparisons.
      const content = code.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*|\*\/)/.test(line)).join('\n');
      expect(content.replace(/繁體中文|日本語|新增使用者|重試中|下載失敗|上午|下午|確定/g, ''), path).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it('keeps navigation and user content unchanged without a live locale update path', async () => {
    const { api } = apiFixture();
    render(<App api={api} />);
    await screen.findByRole('button', { name: 'Chats' });
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    await screen.findByLabelText(`Latest message: ${original}`);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('heading', { name: 'Search chat history' })).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText('Message or filename').closest('form')!).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.searchMessages).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    expect(screen.getByText('No Agent jobs yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByRole('textbox', { name: 'Agent message' })).toBeTruthy();
    // The startup locale is fixed for this launch; a later saved choice takes effect on relaunch.
    expect(screen.getByRole('button', { name: 'Chats' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(screen.getByLabelText(`Latest message: ${original}`)).toBeTruthy();
  });

  it.each(['ja', 'ko'] as const)('uses the complete %s desktop catalog and preserves interpolation slots', (locale) => {
    const translated = locale === 'ja' ? JAPANESE_DESKTOP_COPY : KOREAN_DESKTOP_COPY;
    expect(Object.keys(translated)).toHaveLength(747);
    expect(desktopTextFor(locale, 'chats')).not.toBe('Chats');
    expect(desktopTextFor(locale, 'agentRequestsToolArg0', { arg0: 'shell' })).toContain('shell');
    for (const [key, text] of Object.entries(ENGLISH_DESKTOP_COPY)) {
      const slots = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map((match) => match[0]).sort();
      expect(slots(translated[key as keyof typeof ENGLISH_DESKTOP_COPY]!), key).toEqual(slots(text));
    }
  });

  it('uses LocaleProvider context and typed interpolation without same-process locale switching', () => {
    const state = (effectiveLocale: LocaleState['effectiveLocale']): LocaleState => ({ status: 'loaded', effectiveLocale, preference: effectiveLocale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} });
    function Probe() {
      const locale = useDesktopLocale();
      const text = useDesktopText();
      return <output>{locale}|{text('viewArg0Arg1', { arg0: 'A', arg1: 'B' })}</output>;
    }
    const { rerender } = render(<LocaleProvider value={state('en')}><Probe /></LocaleProvider>);
    expect(screen.getByText('en|View AB')).toBeTruthy();
    cleanup();
    render(<LocaleProvider value={state('zh-TW')}><Probe /></LocaleProvider>);
    expect(screen.getByText(/zh-TW\|/)).toBeTruthy();
    expect(desktopTextFor('zh-TW', 'chats')).toBe('聊天');
    expect(desktopTextFor('en', 'arg0Unread', { arg0: 1200 })).toContain('1,200');
    expect(desktopTextFor('zh-TW', 'arg0Unread', { arg0: 1200 })).toContain('1,200');
  });

  it.each(['ja', 'ko'] as const)('uses LocaleProvider and English catalog fallback for %s', (locale) => {
    const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
    function Probe() { return <output>{useDesktopLocale()}|{useDesktopText()('chats')}</output>; }
    render(<LocaleProvider value={value}><Probe /></LocaleProvider>);
    expect(screen.getByText(`${locale}|${desktopTextFor(locale, 'chats')}`)).toBeTruthy();
  });

  it('localizes generated previews but preserves matching user text and filenames', () => {
    expect(generatedPreviewFor('zh-TW', undefined, '圖片')).toBe('圖片');
    expect(generatedPreviewFor('en', { kind: 'image' }, '圖片')).toBe('Image');
    expect(generatedPreviewFor('zh-TW', { kind: 'file', name: '報告.pdf', status: 'failed' }, '')).toBe('報告.pdf (下載失敗)');
  });

  it('keeps transient composed messages unchanged until typed callers are migrated', () => {
    const message = desktopTextFor('zh-TW', 'arg0LoggedOutHistoryRetained', { arg0: '原始名稱' });
    expect(generatedMessageText(message)).toBe(message);
  });

  it('uses safe finite error mappings for English and Chinese backend diagnostics', () => {
    for (const message of ['C:\\private\\secret.txt', 'at service (/home/private/file.js:2)', '帳號錯誤 C:\\secret']) {
      expect(safeErrorText({ code: 'UNRECOGNIZED', message })).toBe('Unable to complete this action. Try again.');
    }
    expect(safeErrorText({ code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'secret' })).toBe('Agent jobs cannot be created in external monitoring mode.');
    expect(safeErrorTextFor('zh-TW', { code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'secret' })).toContain('外部監控');
    expect(safeErrorTextFor('ja', { code: 'UNRECOGNIZED', message: 'secret' })).toBe(extraTextFor('ja', 'operationFailed'));
    expect(safeErrorText({ code: '__proto__' })).toBe('Unable to complete this action. Try again.');
    expect(describeExternalImportMessage('constructor').text).toBe('External monitoring stopped unexpectedly. Restart external monitoring.');
    expect(describeExternalImportMessage('x'.repeat(121)).code).toBeNull();
  });

  it.each([
    ['en', 'LINE requires this message to be encrypted.', 'You can only unsend your own LINE messages.', 'LINE could not find the requested data.'],
    ['zh-TW', 'LINE 要求以加密方式傳送。', '只能收回自己傳送的 LINE 訊息。', 'LINE 找不到指定資料。'],
    ['ja', 'LINE はこのメッセージの暗号化を要求しています。', '自分が送信した LINE メッセージのみ送信取消できます。', 'LINE で指定されたデータが見つかりません。'],
    ['ko', 'LINE에서 이 메시지를 암호화해 보내도록 요구합니다.', '본인이 보낸 LINE 메시지만 전송 취소할 수 있습니다.', 'LINE에서 요청한 데이터를 찾을 수 없습니다.'],
  ] as const)('renders bounded facade Talk failures in %s without reading prose', (locale, send, unsend, profile) => {
    const make = (code: string, serverErrorCode: string) => IpcResultSchema.parse({ type: 'error', requestId: 'one',
      ok: false, code, serverErrorCode, message: 'token=private MID=u12345678901234567890123456789012', retryable: false });
    expect(safeErrorTextFor(locale, make('LINE_SEND_NOT_STARTED', 'LINE_TALK_E2EE_RETRY_ENCRYPT'))).toBe(send);
    expect(safeErrorTextFor(locale, make('LINE_UNSEND_NOT_STARTED', 'LINE_TALK_NOT_YOUR_MESSAGE'))).toBe(unsend);
    expect(safeErrorTextFor(locale, make('LINE_PROFILE_REFRESH_FAILED', 'LINE_TALK_NOT_FOUND'))).toBe(profile);
    expect(safeErrorTextFor(locale, { code: 'LINE_SEND_OUTCOME_UNKNOWN', message: 'token=private' }))
      .toBe(extraTextFor(locale, 'operationFailed'));
    expect(safeErrorTextFor(locale, { code: 'LINE_SEND_NOT_STARTED', serverErrorCode: 'LINE_TALK_PRIVATE_MESSAGE',
      message: 'token=private' })).toBe(extraTextFor(locale, 'operationFailed'));
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes unknown rejected UI actions in %s and redacts diagnostics', async (locale) => {
    const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
    function Probe() {
      const safeError = useSafeErrorText();
      const [message, setMessage] = React.useState('');
      return <><button onClick={() => { void Promise.reject(Object.assign(new Error('secret C:\\private\\file'), { code: 'UNRECOGNIZED' })).catch((error) => setMessage(safeError(error))); }}>Reject action</button><output role="status">{message}</output></>;
    }
    render(<LocaleProvider value={value}><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Reject action' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(extraTextFor(locale, 'operationFailed')));
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('uses the localized generic fallback while preserving an explicit fallback in %s', (locale) => {
    expect(safeErrorTextFor(locale, new Error('private diagnostic'))).toBe(extraTextFor(locale, 'operationFailed'));
    expect(safeErrorTextFor(locale, new Error('private diagnostic'), 'Caller supplied')).toBe('Caller supplied');
  });

  it('shows safe English setup failure and keeps its machine code', async () => {
    const api = { onSetupProgress: () => () => undefined, startEmbeddedProvision: vi.fn(async () => { throw Object.assign(new Error('秘密 C:\\secret'), { errorCode: 'pg_hash_mismatch' }); }) } as unknown as DesktopApi;
    render(<SetupWizard api={api} defaultAttachmentRoot="" defaultAgentWorkspace="" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Downloaded files failed verification and were removed. Retry the download.');
    expect(alert.textContent).toContain('pg_hash_mismatch');
    expect(alert.textContent).not.toContain('secret');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders legacy audit wire labels in English without exposing arbitrary diagnostics', async () => {
    const api = { listSystemActivity: vi.fn(async () => ({ activity: [{ kind: 'audit', createdAt: '2026-10-23T00:00:00Z', action: '系統啟動', phase: '已完成' }], partial: false })) } as unknown as DesktopApi;
    render(<WorkRecords api={api} onOpen={() => undefined} headingRef={React.createRef()} />);
    expect(await screen.findByRole('heading', { name: 'System startup' })).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
  });
});
