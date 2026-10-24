// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import { formatReadTime } from './pages/MessageReadReceipt.js';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBase, screen, waitFor, within } from '@testing-library/react';
import { App, firstDisplayedConversation } from './App.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';
import { LineLogin } from './pages/LineLogin.js';
import { accountComposerStatus, accountHeaderStatusFor, formatLatestMessageTime, formatVisibleMessageDate } from './pages/Conversations.js';
import type { DesktopApi } from '../preload/api.js';
import type { TimelineMessage } from '../main/service-facade.js';
import { DEFAULT_AGENT_STATUS_ICONS, lineMediaUrl, type AppSnapshot, type ConversationSummary, type IpcEvent } from '@line-agent/contracts';
import { createCoalescedSnapshotPublisher } from '../main/domain-event-publisher.js';
import { LINE_REACTION_GLYPHS } from './AgentStatusMarker.js';
import { desktopTextFor, extraTextFor } from './desktop-i18n.js';

const testLocaleState = (locale: NonNullable<LocaleState['effectiveLocale']>): LocaleState => ({
  status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, restartChoice: false, restartPending: false,
  retry() {}, retryRestart() {}, restartNow() {}, restartLater() {}, setPreference() {},
});
/** Standalone renderer components use the same explicit startup locale as App's fake API. */
function render(ui: React.ReactElement, locale: NonNullable<LocaleState['effectiveLocale']> = 'zh-TW') {
  const view = renderBase(<LocaleProvider value={testLocaleState(locale)}>{ui}</LocaleProvider>);
  return { ...view, rerender: (next: React.ReactElement) => view.rerender(<LocaleProvider value={testLocaleState(locale)}>{next}</LocaleProvider>) };
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('linejs.lastPage', 'conversations'); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

/** The shared Agent room is the 助理 page of the left rail. */
async function renderAssistantApp(api: DesktopApi) {
  const view = render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '助理' }));
  return view;
}

/** LINE tests open the first LINE chat explicitly. */
async function renderLineApp(api: DesktopApi) {
  const view = render(<App api={api} />);
  const firstTitle = (await api.getSnapshot()).conversations.find((item) => !item.localOnly)?.title;
  const row = await waitFor(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.conversation-row')].filter((item) => !item.textContent?.includes('Agent 室'));
    const found = rows.find((item) => firstTitle && item.textContent?.includes(firstTitle)) ?? rows[0];
    if (!found) throw new Error('no LINE conversation row yet');
    return found;
  });
  fireEvent.click(row);
  return view;
}

it('picks the rail click target in displayed latest-activity order, or nothing when the account has no LINE chat', () => {
  const chat = (accountId: string, chatId: string, latestMessageAt: string | null, localOnly?: boolean): ConversationSummary => ({
    accountId, chatType: 'group', chatId, title: chatId, unreadCount: 0, agentEnabled: false, defaultProvider: 'codex', latestMessageAt,
    ...(localOnly ? { localOnly: true } : {}) });
  const list = [chat('a', 'old', '2026-10-01T00:00:00.000Z'), chat('a', 'quiet', null), chat('a', 'newest', '2026-10-20T00:00:00.000Z'),
    chat('a', 'legacy-room', '2026-10-25T00:00:00.000Z', true), chat('b', 'other', '2026-10-30T00:00:00.000Z')];
  expect(firstDisplayedConversation(list, 'a')?.chatId).toBe('newest');
  expect(firstDisplayedConversation(list, 'c')).toBeUndefined();
  expect(firstDisplayedConversation([chat('a', 'legacy-room', null, true)], 'a')).toBeUndefined();
});

it('formats conversation timestamps as local time, yesterday, or a date', () => {
  const now = new Date(2026, 9, 17, 23, 0);
  const today = new Date(2026, 9, 17, 22, 26);
  const yesterday = new Date(2026, 9, 16, 22, 26);
  const older = new Date(2025, 9, 17, 22, 26);
  expect(formatLatestMessageTime(today.toISOString(), now, 'zh-TW')).toBe(
    new Intl.DateTimeFormat('zh-TW', { hour: 'numeric', minute: '2-digit', hour12: true }).format(today),
  );
  expect(formatLatestMessageTime(yesterday.toISOString(), now, 'zh-TW')).toBe('昨天');
  expect(formatLatestMessageTime(older.toISOString(), now, 'zh-TW')).toBe(
    new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(older),
  );
  expect(formatLatestMessageTime(null, now, 'zh-TW')).toBeNull();
});

it('formats the visible message date without a current year and includes a different year', () => {
  const now = new Date(2026, 9, 21, 12);
  expect(formatVisibleMessageDate(new Date(2026, 9, 21, 8).toISOString(), now, 'zh-TW')).toBe(new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(2026, 9, 21)));
  expect(formatVisibleMessageDate(new Date(2025, 9, 21, 8).toISOString(), now, 'zh-TW')).toBe(new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(2025, 9, 21)));
  expect(formatVisibleMessageDate('invalid', now, 'zh-TW')).toBeNull();
});

it('tracks the topmost visible message date and removes its pane scroll listener on unmount', async () => {
  const now = new Date();
  const currentYearDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).toISOString();
  const previousYearDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 10).toISOString();
  const api = fakeApi();
  api.listMessages = vi.fn(async () => ({ messages: [
    { ...message('account-A', 'current-visible'), occurredAt: currentYearDate },
    { ...message('account-A', 'previous-visible'), occurredAt: previousYearDate },
  ], olderCursor: null }));
  let previousTop = 120;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.id === 'timeline') return { top: 100, bottom: 400, left: 0, right: 500, width: 500, height: 300, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
    if (this instanceof HTMLElement && this.dataset.messageDate) {
      const top = this.dataset.messageDate === currentYearDate ? previousTop : 220;
      return { top, bottom: top + 50, left: 0, right: 300, width: 300, height: 50, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  const view = await renderLineApp(api);
  const chip = await screen.findByText(formatVisibleMessageDate(currentYearDate, new Date(), 'zh-TW')!);
  const timeline = document.getElementById('timeline')!;
  const removeSpy = vi.spyOn(timeline, 'removeEventListener');
  previousTop = 40;
  fireEvent.scroll(timeline);
  expect(await screen.findByText(formatVisibleMessageDate(previousYearDate, new Date(), 'zh-TW')!)).toBeTruthy();
  view.unmount();
  expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  expect(chip.classList.contains('visible-message-date')).toBe(true);
});

it('shows login success once for a fresh transition and never replays it on page remount', () => {
  vi.useFakeTimers();
  try {
    const props = { api: fakeApi(), accounts: [], headingRef: React.createRef<HTMLHeadingElement>() };
    const connecting = { accountId: 'account-new', loginAttemptId: 'attempt-new', state: 'connecting' as const, message: null };
    const connected = { ...connecting, loginAttemptId: null, state: 'connected' as const };
    const view = render(<LineLogin {...props} live={connecting} />);
    view.rerender(<LineLogin {...props} live={connected} />);
    expect(document.querySelector('.system-toast')?.textContent).toBe('LINE 登入成功');
    act(() => vi.advanceTimersByTime(4000));
    expect(document.querySelector('.system-toast')).toBeNull();
    view.rerender(<LineLogin {...props} live={{ ...connected }} />);
    expect(document.querySelector('.system-toast')).toBeNull();
    view.unmount();
    render(<LineLogin {...props} live={connected} />);
    expect(document.querySelector('.system-toast')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

const snapshot: AppSnapshot = {
  control: { epoch: 4, activeAccountId: 'account-A', phase: 'idle' as const, targetAccountId: null },
  defaultProvider: 'codex' as const,
  components: [
    { name: 'database' as const, status: 'ready' as const, message: null, lastSuccessAt: null, restartCount: 0 },
    { name: 'lineWorker' as const, status: 'ready' as const, message: null, lastSuccessAt: null, restartCount: 0 },
  ], queueDepth: 0,
  accounts: [
    { accountId: 'account-A', displayName: '工作', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const, productRole: 'AGENT' as const, canSendManually: true },
    { accountId: 'account-B', displayName: '觀察', status: 'connected' as const, lastSyncedAt: null, mode: 'MONITOR_ONLY' as const, productRole: 'PRIMARY_ADMIN' as const, canSendManually: true },
  ],
  conversations: [
    { accountId: 'account-A', chatType: 'group' as const, chatId: 'same-chat', title: '同名群組', unreadCount: 2, agentEnabled: false, defaultProvider: 'claude' as const, latestMessagePreview: '群組摘要', latestMessageAt: '2026-10-15T10:00:00.000Z', latestAttachmentStatus: null },
    { accountId: 'account-B', chatType: 'group' as const, chatId: 'same-chat', title: '同名群組', unreadCount: 0, agentEnabled: false, defaultProvider: 'codex' as const, latestMessagePreview: null, latestMessageAt: null, latestAttachmentStatus: null },
  ], jobs: [], providers: [
    { provider: 'claude' as const, status: 'logged_in' as const, detail: null },
    { provider: 'codex' as const, status: 'logged_in' as const, detail: null },
  ],
};

function message(accountId: string, messageId: string): TimelineMessage {
  return { accountId, chatType: 'group', chatId: 'same-chat', messageId, senderId: 'sender', senderName: 'Sender', text: messageId,
    occurredAt: '2026-10-15T10:00:00.000Z', direction: 'inbound', replyToMessageId: null, replyTo: null, deleted: false, attachments: [], kind: 'text', sticker: null };
}

function scrollTimelineToTop() {
  const pane = document.getElementById('timeline')!;
  pane.scrollTop = 0;
  fireEvent.scroll(pane);
}

function scrollTimelineToBottom() {
  const pane = document.getElementById('timeline')!;
  Object.defineProperty(pane, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(pane, 'clientHeight', { value: 300, configurable: true });
  pane.scrollTop = 4700;
  fireEvent.scroll(pane);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeApi(): DesktopApi {
  const accepted = { type: 'accepted', requestId: 'x', ok: true } as const;
  return {
    getLocale: vi.fn(async () => ({ preference: 'zh-TW' as const, effectiveLocale: 'zh-TW' as const })),
    setLocale: vi.fn(async (preference: 'automatic' | 'en' | 'zh-TW' | 'ja' | 'ko') => ({ preference, effectiveLocale: preference === 'automatic' ? 'en' : preference })),
    getSnapshot: vi.fn(async () => snapshot),
    listMessages: vi.fn(async () => ({ messages: [], olderCursor: null })),
    listChatNotes: vi.fn(async () => ({ notes: [], nextCursor: null })),
    getChatNote: vi.fn(async () => ({ postId: 'post-1', createdTime: null, text: null })),
    listChatAlbums: vi.fn(async () => ({ albums: [], nextCursor: null })),
    listChatAlbumPhotos: vi.fn(async () => ({ photos: [], nextCursor: null })),
    downloadChatAlbumPhoto: vi.fn(async (key, albumId, photoId) => ({ albumId, photoId, sizeBytes: 1 })),
    openChatAlbum: vi.fn(async (_key, albumId) => ({ albumId, savedCount: 0, failedCount: 0, totalCount: 0, byteCount: 0, complete: true, failureCodes: [], errorCode: null })),
    cancelChatResourceRequest: vi.fn(async () => true),
    listAttachmentStates: vi.fn(async () => []),
    listAgentStatuses: vi.fn(async () => []),
    listWorkRecords: vi.fn(async () => []),
    listFriends: vi.fn(async () => []),
    listMessageReaders: vi.fn(async () => ({ readers: [] })),
    listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
    listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })),
    getControlState: vi.fn(async () => ({ activeAccountId: 'account-A', epoch: 4, pendingOutbound: 1 })),
    getJobEvents: vi.fn(async () => []),
    searchAgentJobs: vi.fn(async () => ({ jobs: [], nextCursor: null })),
    getAgentRoomJobEvents: vi.fn(async () => []),
    stopAgentRoomJob: vi.fn(async () => accepted),
    retryAgentRoomJob: vi.fn(async () => accepted),
    searchMessages: vi.fn(async () => []),
    sendText: vi.fn(async () => accepted),
    replyText: vi.fn(async () => accepted),
    unsendMessage: vi.fn(async () => accepted),
    getManualUnsendWindow: vi.fn(async () => '1h' as const),
    setManualUnsendWindow: vi.fn(async (window) => window),
    submitAgentRoomPrompt: vi.fn(async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-1' } as const)),
    openAttachment: vi.fn(async () => false),
    openExternalUrl: vi.fn(async () => ({ type: 'openExternalUrl', requestId: 'x', ok: true } as const)),
    downloadAttachment: vi.fn(async () => accepted),
    resolveFileTypeIcon: vi.fn(async () => null),
    lineAddAccountQr: vi.fn(async () => accepted),
    lineLoginQr: vi.fn(async () => accepted),
    lineLogout: vi.fn(async () => accepted),
    refreshLineAvatar: vi.fn(async () => accepted),
    lineSetAutoLogin: vi.fn(async () => accepted),
    lineBeginAdminPairing: vi.fn(async () => ({ token: '123456', expiresAt: '2026-10-16T06:00:00.000Z' })),
    lineStart: vi.fn(async () => accepted),
    externalImportStart: vi.fn(async () => accepted),
    externalImportStop: vi.fn(async () => accepted),
    previewExternalAdminBinding: vi.fn(async () => ({ type: 'previewExternalAdminBinding', requestId: 'x', ok: true,
      identity: { mid: `u${'a'.repeat(32)}`, displayName: '王小明' }, otherCandidates: 0 } as const)),
    startExternalMonitorAsAdmin: vi.fn(async () => ({ type: 'startExternalMonitorAsAdmin', requestId: 'x', ok: true,
      bound: true, started: true, message: null } as const)),
    officialLineApproveSigner: vi.fn(async () => accepted),
    agentLogin: vi.fn(async () => accepted),
    agentLogout: vi.fn(async () => accepted),
    agentRefreshStatus: vi.fn(async () => accepted),
    stopJob: vi.fn(async () => accepted),
    retryJob: vi.fn(async () => accepted),
    setWorkspace: vi.fn(async () => accepted),
    setDefaultAgent: vi.fn(async () => accepted),
    getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS }, agentStatusRotationIntervalSeconds: 10 })),
    setConversationSettings: vi.fn(async (settings) => settings),
    getAutoResponderSettings: vi.fn(async () => ({ version: 0, displayName: 'Agent', fallback: '我不知道你在說甚麼', rules: [] })),
    setAutoResponderSettings: vi.fn(async () => ({ type: 'setAutoResponderSettings', requestId: 'x', ok: true, version: 1 } as const)),
    mcpGetStatus: vi.fn(async () => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount: 0, inFlightRequests: 0, maxConcurrentRequests: 8 })),
    mcpLocalClientStatus: vi.fn(async () => [{ client: 'claude-desktop' as const, installed: false, connected: false, tokenId: null, accountScopes: [] }, { client: 'codex' as const, installed: false, connected: false, tokenId: null, accountScopes: [] }]),
    mcpLocalClientConnect: vi.fn(async (client) => ({ client, installed: true, connected: true, tokenId: '11111111-1111-4111-8111-111111111111', accountScopes: ['account-A'] })),
    mcpLocalClientDisconnect: vi.fn(async () => undefined),
    mcpListTokens: vi.fn(async () => []),
    mcpIssueToken: vi.fn(async () => ({ token: { tokenId: '11111111-1111-4111-8111-111111111111', principalId: 'external:test', deviceLabel: 'Test', accountScopes: ['account-A'], toolScopes: ['list_targets' as const], grantVersion: 1, state: 'ACTIVE' as const, expiresAt: '2026-10-20T00:00:00.000Z', revokedAt: null, lastUsedAt: null, createdAt: '2026-10-17T00:00:00.000Z' }, plaintextToken: 'la_mcp_' + 'A'.repeat(43) })),
    mcpRevokeToken: vi.fn(async () => true),
    mcpCallInternalTool: vi.fn(async () => ({ toolName: 'list_targets' as const, targets: [] })),
    getAgentPermissions: vi.fn(async () => ({ catalog: [], defaults: [], subjects: [], rules: [], links: [], folders: [], eligibleChats: [], workspaceRoot: null })),
    getAgentPermissionDefaults: vi.fn(async () => ({ rules: [] })),
    setAgentPermissionDefault: vi.fn(async () => ({ type: 'setAgentPermissionDefault' as const, requestId: 'r', ok: true as const, version: 1 })),
    revokeAgentWhitelistUser: vi.fn(async () => ({ type: 'revokeAgentWhitelistUser' as const, requestId: 'r', ok: true as const, revoked: 0 })),
    setAgentPermission: vi.fn(async () => ({ type: 'accepted' as const, requestId: 'r', ok: true as const })),
    getAgentExecutionPolicy: vi.fn(async () => ({ level: 'workspace_write' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 1, updatedAt: new Date(0).toISOString() })),
    setAgentExecutionPolicy: vi.fn(async () => accepted),
    listAgentToolAllowlist: vi.fn(async () => []),
    removeAgentToolAllowlistEntry: vi.fn(async () => accepted),
    clearAgentToolAllowlist: vi.fn(async () => accepted),
    listPendingAgentApprovals: vi.fn(async () => []),
    decideAgentApproval: vi.fn(async () => accepted),
    setAgentFolderLink: vi.fn(async () => ({ type: 'accepted' as const, requestId: 'r', ok: true as const })),
    createChatFolder: vi.fn(async () => ({ type: 'accepted' as const, requestId: 'r', ok: true as const })),
    openChatFolder: vi.fn(async () => ({ type: 'accepted' as const, requestId: 'r', ok: true as const })),
    getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    listDatabases: vi.fn(async () => []),
    createDatabase: vi.fn(async () => []),
    chooseAttachmentRoot: vi.fn(async () => null),
    chooseAgentWorkspace: vi.fn(async () => null),
    saveDatabaseSetup: vi.fn(async () => ({ saved: true, restartRequired: true } as const)),
    restartApplication: vi.fn(async () => undefined),
    startEmbeddedProvision: vi.fn(async () => undefined),
    cancelEmbeddedProvision: vi.fn(async () => undefined),
    changeEmbeddedPassword: vi.fn(async () => undefined),
    getEmbeddedConnectionInfo: vi.fn(async () => ({ version: '18.6', host: '127.0.0.1', port: 55432, username: 'line_agent_admin', database: 'line_agent', url: '', password: '' })),
    saveEmbeddedSetup: vi.fn(async () => ({ saved: true, restartRequired: true } as const)),
    onSetupProgress: vi.fn(() => () => undefined),
    onSnapshot: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
}

async function openSystemTab() {
  fireEvent.click(await screen.findByRole('button', { name: '設定' }));
  fireEvent.click(await screen.findByRole('tab', { name: '系統' }));
}

it('reloads only the refreshed account avatars for periodic and manual App events', async () => {
  const ownMid = `u${'e'.repeat(32)}`;
  const peerMid = `u${'f'.repeat(32)}`;
  const api = fakeApi();
  const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
  api.onEvent = vi.fn((listener) => { listeners.push(listener); return () => undefined; });
  api.getSnapshot = vi.fn(async () => ({
    ...snapshot,
    accounts: snapshot.accounts.map((item) => ({ ...item, avatarAvailable: item.accountId === 'account-A' })),
    conversations: [
      { ...snapshot.conversations[0]!, avatarAvailable: true },
      { ...snapshot.conversations[0]!, chatType: 'direct' as const, chatId: ownMid, title: '我的聊天室', avatarAvailable: true },
      { ...snapshot.conversations[0]!, chatType: 'direct' as const, chatId: peerMid, title: 'Peer 聊天', avatarAvailable: true },
    ],
  }));
  api.listMessages = vi.fn(async () => ({ messages: [
    { ...message('account-A', 'own-message'), senderId: ownMid, senderName: 'Me', senderAvatarAvailable: true },
    { ...message('account-A', 'peer-message'), senderId: peerMid, senderName: 'Peer', senderAvatarAvailable: true },
  ], olderCursor: null }));
  const target = {
    account: { type: 'account' as const, accountId: 'account-A' },
    ownChat: { type: 'conversation' as const, accountId: 'account-A', chatType: 'direct' as const, chatId: ownMid },
    ownMember: { type: 'member' as const, accountId: 'account-A', chatType: 'group' as const, chatId: 'same-chat', memberId: ownMid },
    peerChat: { type: 'conversation' as const, accountId: 'account-A', chatType: 'direct' as const, chatId: peerMid },
    peerMember: { type: 'member' as const, accountId: 'account-A', chatType: 'group' as const, chatId: 'same-chat', memberId: peerMid },
  };
  const imagesFor = (value: typeof target.account | typeof target.ownChat | typeof target.ownMember) =>
    [...document.querySelectorAll<HTMLImageElement>(`img[src="${lineMediaUrl(value)}"]`)];
  const mounted = async () => {
    await waitFor(() => expect(imagesFor(target.account).length).toBeGreaterThan(0));
    await waitFor(() => expect(imagesFor(target.ownChat).length).toBeGreaterThan(0));
    await waitFor(() => expect(imagesFor(target.ownMember).length).toBeGreaterThan(0));
    await waitFor(() => expect(imagesFor(target.peerChat).length).toBeGreaterThan(0));
    await waitFor(() => expect(imagesFor(target.peerMember).length).toBeGreaterThan(0));
  };
  const capture = () => ({
    account: imagesFor(target.account), ownChat: imagesFor(target.ownChat), ownMember: imagesFor(target.ownMember),
    peerChat: imagesFor(target.peerChat), peerMember: imagesFor(target.peerMember),
  });
  const expectOwnReloaded = (before: ReturnType<typeof capture>) => {
    for (const key of ['account', 'ownChat', 'ownMember'] as const) {
      const after = capture()[key];
      expect(after).toHaveLength(before[key].length);
      after.forEach((image, index) => {
        expect(image).not.toBe(before[key][index]);
        expect(image.getAttribute('src')).toBe(before[key][index]!.getAttribute('src'));
      });
    }
    expect(capture().peerChat).toEqual(before.peerChat);
    expect(capture().peerMember).toEqual(before.peerMember);
  };

  await renderLineApp(api);
  await mounted();
  const beforePeriodic = capture();
  act(() => listeners.forEach((listener) => listener({ type: 'lineAvatarRefreshed', accountId: 'account-A', ownMid })));
  await waitFor(() => expectOwnReloaded(beforePeriodic));

  await openSystemTab();
  const beforeManual = imagesFor(target.account)[0]!;
  fireEvent.click(within(document.querySelector('.account-record[data-account-id="account-A"]')!).getByRole('button', { name: '更新頭像' }));
  await waitFor(() => expect(api.refreshLineAvatar).toHaveBeenCalledWith('account-A'));
  act(() => listeners.forEach((listener) => listener({ type: 'lineAvatarRefreshed', accountId: 'account-A', ownMid })));
  await waitFor(() => {
    expect(imagesFor(target.account)[0]).not.toBe(beforeManual);
    expect(imagesFor(target.account)[0]?.getAttribute('src')).toBe(beforeManual.getAttribute('src'));
  });
});

describe('locale restart choice focus', () => {
  async function beginLocaleSave() {
    const save = deferred<{ preference: 'en'; effectiveLocale: 'en' }>();
    const api = fakeApi();
    api.setLocale = vi.fn(() => save.promise);
    render(<App api={api} />);
    await openSystemTab();
    const selector = await screen.findByRole('combobox', { name: '語言' }) as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'en' } });
    expect(selector.disabled).toBe(true);
    await waitFor(() => expect(api.setLocale).toHaveBeenCalledWith('en'));
    await act(async () => { save.resolve({ preference: 'en', effectiveLocale: 'en' }); await save.promise; });
    await screen.findByRole('alertdialog');
    return selector;
  }

  it('returns focus to the language selector after Later following a deferred save', async () => {
    const selector = await beginLocaleSave();
    fireEvent.click(screen.getByRole('button', { name: '稍後' }));
    await waitFor(() => expect(document.activeElement).toBe(selector));
  });

  it('returns focus to the language selector after Escape following a deferred save', async () => {
    const selector = await beginLocaleSave();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(selector));
  });
});

describe('last visited page', () => {
  const settingsTabs = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
  const expectSystemTabOpen = async () => {
    const tab = await screen.findByRole('tab', { name: '系統' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: '設定' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent 帳號欄位' })).toBeTruthy();
  };

  it('opens Settings on the 系統 tab on first launch even when there are no accounts', async () => {
    localStorage.removeItem('linejs.lastPage');
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [], conversations: [], jobs: [] }));
    render(<App api={api} />);
    await expectSystemTabOpen();
    expect(settingsTabs()[0]).toBe('系統');
  });

  it('overrides a remembered page and tab with Settings 系統 when the first snapshot has no account', async () => {
    localStorage.setItem('linejs.lastPage', 'jobs');
    localStorage.setItem('line-agent:settings-tab', 'work');
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [], conversations: [], jobs: [] }));
    render(<App api={api} />);
    await expectSystemTabOpen();
    expect(localStorage.getItem('line-agent:settings-tab')).toBe('system');
  });

  it('keeps the remembered page when the first snapshot has an account', async () => {
    localStorage.setItem('linejs.lastPage', 'jobs');
    const api = fakeApi();
    expect(snapshot.accounts.length).toBeGreaterThan(0);
    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: '任務' })).toBeTruthy();
  });

  it('opens a stored retired accounts page as Settings on the 系統 tab', async () => {
    localStorage.setItem('linejs.lastPage', 'accounts');
    render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
    await waitFor(() => expect(localStorage.getItem('linejs.lastPage')).toBe('settings'));
  });

  it('restores a remembered page and stores left navigation clicks', async () => {
    localStorage.setItem('linejs.lastPage', 'jobs');
    render(<App api={fakeApi()} />);
    expect(await screen.findByRole('heading', { name: '任務' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { name: '設定' });
    expect(localStorage.getItem('linejs.lastPage')).toBe('settings');
    expect(screen.getByRole('tab', { name: '系統' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens Settings on the 系統 tab for invalid or inaccessible storage', async () => {
    localStorage.setItem('linejs.lastPage', 'not-a-page');
    const view = render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
    view.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
  });

  it('keeps 系統 as the tab when Settings is opened from the navigation after the first launch', async () => {
    localStorage.removeItem('linejs.lastPage');
    render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
    fireEvent.click(screen.getByRole('button', { name: '聊天' }));
    await screen.findByRole('navigation', { name: '主要導覽' });
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect((await screen.findByRole('tab', { name: '系統' })).getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the clicked Settings tab across an unmount and remount', async () => {
    localStorage.setItem('linejs.lastPage', 'settings');
    const view = render(<App api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('tab', { name: '紀錄' }));
    expect(screen.getByRole('tab', { name: '紀錄' }).getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem('line-agent:settings-tab')).toBe('work');
    view.unmount();
    render(<App api={fakeApi()} />);
    expect((await screen.findByRole('tab', { name: '紀錄' })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '聊天' }));
    await screen.findByRole('navigation', { name: '主要導覽' });
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect((await screen.findByRole('tab', { name: '紀錄' })).getAttribute('aria-selected')).toBe('true');
  });

  it('ignores an invalid stored Settings tab', async () => {
    localStorage.setItem('line-agent:settings-tab', 'not-a-tab');
    localStorage.removeItem('linejs.lastPage');
    render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
  });

  it('opens the default Settings tab when storage throws', async () => {
    localStorage.removeItem('linejs.lastPage');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App api={fakeApi()} />);
    await expectSystemTabOpen();
    fireEvent.click(screen.getByRole('tab', { name: '紀錄' }));
    expect(screen.getByRole('tab', { name: '紀錄' }).getAttribute('aria-selected')).toBe('true');
  });

  it('redirects a database health issue to 系統 and remembers the surviving tab', async () => {
    localStorage.setItem('line-agent:settings-tab', 'work');
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, components: [{ name: 'database', status: 'degraded', message: '資料庫連線異常' } as never] }));
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '系統' }).getAttribute('aria-selected')).toBe('true'));
    expect(localStorage.getItem('line-agent:settings-tab')).toBe('system');
    expect(screen.getByText('連線異常')).toBeTruthy();
  });

  it('redirects a failed snapshot read to 系統 and remembers the surviving tab', async () => {
    localStorage.setItem('line-agent:settings-tab', 'work');
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => { throw new Error('snapshot unavailable'); });
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '系統' }).getAttribute('aria-selected')).toBe('true'));
    expect(localStorage.getItem('line-agent:settings-tab')).toBe('system');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no separate account item in the sidebar and lists 系統 as the first Settings tab', async () => {
    render(<App api={fakeApi()} />);
    const navigation = await screen.findByRole('navigation', { name: '主要導覽' });
    expect(within(navigation).queryByRole('button', { name: '系統' })).toBeNull();
    expect(within(navigation).getByRole('button', { name: '搜尋' }).previousElementSibling?.classList.contains('nav-divider')).toBe(true);
    fireEvent.click(within(navigation).getByRole('button', { name: '設定' }));
    await screen.findByRole('tablist', { name: '設定分類' });
    expect(settingsTabs().slice(0, 2)).toEqual(['系統', '對話']);
    fireEvent.click(screen.getByRole('tab', { name: '系統' }));
    const accountSettings = await screen.findByRole('region', { name: 'LINE 帳號設定' });
    const agentSlot = within(accountSettings).getByRole('region', { name: 'Agent 帳號欄位' });
    expect(within(agentSlot).getByRole('heading', { name: 'Agent' })).toBeTruthy();
    expect(within(agentSlot).getByText(snapshot.accounts[0]!.displayName)).toBeTruthy();
  });

  it('renders a live QR login state inside the 系統 tab', async () => {
    const listeners: Array<(event: never) => void> = [];
    const api = fakeApi();
    api.onEvent = vi.fn((next) => { listeners.push(next as never); return () => undefined; });
    api.lineAddAccountQr = vi.fn(async () => ({ ok: true, type: 'lineAddAccountQr' } as never));
    localStorage.removeItem('linejs.lastPage');
    render(<App api={api} />);
    await expectSystemTabOpen();
    act(() => { for (const listener of listeners) listener({ type: 'lineLoginState', accountId: 'qr-account', loginAttemptId: 'attempt-1', state: 'connecting', message: null } as never); });
    act(() => { for (const listener of listeners) listener({ type: 'lineQr', accountId: 'qr-account', loginAttemptId: 'attempt-1', imageDataUrl: 'data:image/png;base64,AAAA' } as never); });
    const image = await screen.findByAltText('LINE QR 登入碼');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(screen.getByRole('tab', { name: '系統', hidden: true }).getAttribute('aria-selected')).toBe('true');
  });
});

function snapshotWithRooms(roomCount: number) {
  return {
    ...snapshot,
    conversations: Array.from({ length: roomCount }, (_, index) => ({
      ...snapshot.conversations[0]!,
      chatId: `chat-${index}`,
      title: `聊天室 ${index}`,
      unreadCount: 0,
      latestMessagePreview: `摘要 ${index}`,
      latestMessageAt: `2026-10-15T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      latestAttachmentStatus: null,
    })),
  };
}

function storedEvent(conversation: ConversationSummary, messageId: string): IpcEvent {
  return {
    type: 'messageStored',
    key: { accountId: conversation.accountId, chatType: conversation.chatType, chatId: conversation.chatId },
    messageId,
    conversation,
  };
}


describe('operator console', () => {
  it.each(['direct', 'group', 'room'] as const)('shows sender identity only for multi-person %s message cards', async (chatType) => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot,
      conversations: [{ ...snapshot.conversations[0]!, chatType }],
    }));
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'incoming'), chatType },
      { ...message('account-A', 'outgoing'), chatType, direction: 'outbound' as const, senderName: 'Me' },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('incoming');
    for (const id of ['incoming', 'outgoing']) {
      const card = container.querySelector(`#message-${id}`)!;
      const row = card.closest('.message-row')!;
      expect(row.querySelector('.sender-avatar') !== null).toBe(id === 'incoming');
      expect(row.querySelector('.message-identity > span:not(.sender-avatar)') !== null).toBe(chatType !== 'direct' && id === 'incoming');
      expect(card.parentElement?.querySelector('.message-time')?.textContent).toBeTruthy();
      expect(card.querySelector('.message-text')?.textContent).toBe(id);
    }
  });

  it('shows a group sender avatar and name above the bubble in the same content column', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'group-inbound')], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('group-inbound');
    const row = container.querySelector('.message-row.inbound')!;
    const identity = row.querySelector('.message-identity')!;
    expect(row.classList.contains('has-inbound-identity')).toBe(true);
    expect(identity.querySelector('.sender-avatar')).toBeTruthy();
    expect(identity.querySelector('.message-sender-name')?.textContent).toBe('Sender');
    expect(row.querySelector('.message-sender-name')?.compareDocumentPosition(row.querySelector('.message')!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.querySelector('time')?.dateTime).toBe('2026-10-15T10:00:00.000Z');
  });

  it('shows the unread count as a LINE-style badge, capped at 999+ with the true count in the label', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [
      { ...snapshot.conversations[0]!, unreadCount: 3 },
      { ...snapshot.conversations[0]!, chatId: 'busy-chat', title: '忙碌群組', unreadCount: 1200 },
    ] }));
    const { container } = await renderLineApp(api);
    await screen.findAllByRole('button', { name: /忙碌群組/ });
    const badges = Array.from(container.querySelectorAll('.list-row-sub .unread'));
    expect(badges.map((badge) => badge.textContent).sort()).toEqual(['3', '999+']);
    expect(container.querySelector('[aria-label="3 則未讀"]')?.textContent).toBe('3');
    expect(container.querySelector('[aria-label="1,200 則未讀"]')?.textContent).toBe('999+');
  });

  it('shows group identity once for consecutive messages from the same sender', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'group-first'), message('account-A', 'group-second')], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('group-second');
    const rows = container.querySelectorAll('.message-row.inbound');
    expect(rows[0]?.querySelector('.message-sender-name')).toBeTruthy();
    expect(rows[1]?.querySelector('.message-sender-name')).toBeNull();
    expect(rows[1]?.querySelector('.inbound-avatar-spacer')).toBeTruthy();
  });

  it('renders the peer avatar for the first direct inbound bubble and reserves its column afterward', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot,
      conversations: [{ ...snapshot.conversations[0]!, chatType: 'direct' as const, avatarAvailable: true }],
    }));
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'direct-first'), chatType: 'direct' as const },
      { ...message('account-A', 'direct-second'), chatType: 'direct' as const },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('direct-second');
    const rows = container.querySelectorAll('.message-row.inbound.direct');
    expect(rows).toHaveLength(2);
    const firstAvatar = rows[0]?.querySelector('img.sender-avatar');
    expect(firstAvatar?.getAttribute('src')).toBe(lineMediaUrl({ type: 'conversation', accountId: 'account-A', chatType: 'direct', chatId: 'same-chat' }));
    expect(rows[1]?.querySelector('.sender-avatar')).toBeNull();
    expect(rows[1]?.querySelector('.inbound-avatar-spacer')).toBeTruthy();
    expect(rows[0]?.querySelector('.message')).toBeTruthy();
    expect(rows[0]?.querySelector('.message-sender-name')).toBeNull();
    expect(rows[1]?.querySelector('.message')).toBeTruthy();
    expect(rows[1]?.querySelector('.message-sender-name')).toBeNull();
  });

  describe('read receipts', () => {
    const own = (id: string, readCount?: number) => ({ ...message('account-A', id), direction: 'outbound' as const,
      ...(readCount !== undefined ? { readCount } : {}) });
    const readers = [{ mid: 'u1', name: '小明', readAt: new Date().toISOString() }, { mid: 'u2', name: '小華', readAt: '2026-01-02T08:05:00.000Z' }];

    it('shows plain 已讀 for a direct chat', async () => {
      const api = fakeApi();
      api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [{ ...snapshot.conversations[0]!, chatType: 'direct' as const }] }));
      api.listMessages = vi.fn(async () => ({ messages: [{ ...own('direct-read', 1), chatType: 'direct' as const }], olderCursor: null }));
      await renderLineApp(api);
      const label = await screen.findByText('已讀');
      expect(label.tagName).not.toBe('BUTTON');
      expect(screen.queryByRole('button', { name: /已讀/ })).toBeNull();
    });

    it('shows no text without a count', async () => {
      const api = fakeApi();
      api.listMessages = vi.fn(async () => ({ messages: [own('unread-own')], olderCursor: null }));
      await renderLineApp(api);
      await screen.findByText('unread-own');
      expect(document.body.textContent).not.toContain('已讀');
    });

    it('does not render a zero read count as text', async () => {
      const api = fakeApi();
      api.listMessages = vi.fn(async () => ({ messages: [own('zero-read-own', 0)], olderCursor: null }));
      const { container } = await renderLineApp(api);
      await screen.findByText('zero-read-own');
      expect(container.querySelector('#message-zero-read-own')?.textContent).not.toContain('0');
    });

    it('opens the reader list, closes on Esc with focus restored, and keeps one panel open', async () => {
      const api = fakeApi();
      api.listMessages = vi.fn(async () => ({ messages: [own('g-one', 2), own('g-two', 1)], olderCursor: null }));
      api.listMessageReaders = vi.fn(async () => ({ readers }));
      await renderLineApp(api);
      const first = await screen.findByRole('button', { name: '已讀 2，查看已讀成員' });
      fireEvent.click(first);
      expect(await screen.findByText('小明')).toBeTruthy();
      expect(screen.getByText('小華')).toBeTruthy();
      expect(screen.getByText(formatReadTime('2026-01-02T08:05:00.000Z', new Date(), 'zh-TW'), { normalizer: (text) => text })).toBeTruthy();
      expect(api.listMessageReaders).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText('小明')).toBeNull());
      expect(document.activeElement).toBe(first);
      fireEvent.click(first);
      await screen.findByText('小明');
      fireEvent.click(screen.getByRole('button', { name: '已讀 1，查看已讀成員' }));
      await waitFor(() => expect(document.querySelectorAll('.read-readers-panel')).toHaveLength(1));
      expect(screen.getByRole('dialog', { name: '已讀 1' })).toBeTruthy();
    });

    it('shows an error when the reader list cannot load', async () => {
      const api = fakeApi();
      api.listMessages = vi.fn(async () => ({ messages: [own('g-err', 2)], olderCursor: null }));
      api.listMessageReaders = vi.fn(async () => { throw new Error('boom'); });
      await renderLineApp(api);
      fireEvent.click(await screen.findByRole('button', { name: '已讀 2，查看已讀成員' }));
      expect(await screen.findByText('無法載入已讀成員')).toBeTruthy();
    });
  });

  it('renders the reaction row only for messages with reactions, above the Agent status marker', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'plain-msg') },
      { ...message('account-A', 'reacted-msg'), agentJobStatus: 'completed' as const,
        reactions: [{ kind: 'NICE' as const, count: 2, reactorNames: ['小明', '小華'] }] },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('reacted-msg');
    const rows = [...container.querySelectorAll('.message-row')];
    expect(rows[0]!.querySelector('.message-reactions')).toBeNull();
    expect(rows[0]!.classList.contains('has-reactions')).toBe(false);
    expect(rows[1]!.classList.contains('has-reactions')).toBe(true);
    const pill = rows[1]!.querySelector('.message-reaction')!;
    expect(pill.getAttribute('aria-label')).toBe('NICE 2 人：小明、小華');
    expect(pill.getAttribute('title')).toBe('小明、小華');
    expect(rows[1]!.querySelector('.message-reactions')!.compareDocumentPosition(rows[1]!.querySelector('.agent-status-marker')!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders outbound messages without sender avatar or name', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'outbound'), direction: 'outbound' as const }], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('outbound');
    const row = container.querySelector('.message-row.outbound')!;
    expect(row.querySelector('.sender-avatar, .message-identity')).toBeNull();
    expect(row.querySelector('.message-time')?.textContent).toBeTruthy();
  });

  it('requires confirmation, then refreshes an unsent message from the exact DB row', async () => {
    const api = fakeApi();
    const own = { ...message('account-A', 'recent-own'), senderId: 'own-account-A', text: 'own message', direction: 'outbound' as const,
      occurredAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
    const other = { ...message('account-A', 'recent-inbound'), text: 'other message', occurredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    const recalled = { ...own, text: null, deleted: true, content: { format: 1 as const, type: 'unsent' as const } };
    const listMessages = vi.fn(async (...args: Parameters<DesktopApi['listMessages']>) => args[3] === own.messageId
      ? { messages: [recalled], olderCursor: null }
      : { messages: [own, other], olderCursor: null });
    api.listMessages = listMessages;
    const { container } = await renderLineApp(api);
    await screen.findByText('own message');
    const ownRow = container.querySelector('#message-recent-own')!.closest('.message-row')!;
    const otherRow = container.querySelector('#message-recent-inbound')!.closest('.message-row')!;
    fireEvent.contextMenu(otherRow);
    expect(screen.queryByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') })).toBeNull();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.contextMenu(ownRow);
    fireEvent.click(await screen.findByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') }));
    expect(confirm).toHaveBeenCalled();
    expect(api.unsendMessage).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.contextMenu(ownRow);
    fireEvent.click(await screen.findByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') }));
    await waitFor(() => expect(api.unsendMessage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-A', chatId: 'same-chat' }), own.messageId));
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-A', chatId: 'same-chat' }), null, 1, own.messageId));
    await waitFor(() => expect(ownRow.querySelector('.message-recalled-label')?.textContent).toContain('已收回'));
  });

  it('shows the context action for older own messages only with the seven day window', async () => {
    const oldOwn = { ...message('account-A', 'old-own'), senderId: 'own-account-A', direction: 'outbound' as const,
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [oldOwn], olderCursor: null }));
    api.getManualUnsendWindow = vi.fn(async () => '1h' as const);
    const oneHour = await renderLineApp(api);
    await screen.findByText('old-own');
    const row = oneHour.container.querySelector('#message-old-own')!.closest('.message-row')!;
    fireEvent.contextMenu(row);
    expect(screen.queryByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') })).toBeNull();
    oneHour.unmount();

    const sevenDayApi = fakeApi();
    sevenDayApi.listMessages = vi.fn(async () => ({ messages: [oldOwn], olderCursor: null }));
    sevenDayApi.getManualUnsendWindow = vi.fn(async () => '7d' as const);
    const sevenDays = await renderLineApp(sevenDayApi);
    await screen.findByText('old-own');
    const sevenDayRow = sevenDays.container.querySelector('#message-old-own')!.closest('.message-row')!;
    fireEvent.contextMenu(sevenDayRow);
    expect(await screen.findByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') })).toBeTruthy();
  });

  it('suppresses the message context menu for an external-monitor-only account', async () => {
    const own = { ...message('account-B', 'monitor-own'), senderId: 'own-account-B', direction: 'outbound' as const,
      text: 'monitor own message', occurredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((item) => item.accountId === 'account-B'
      ? { ...item, canSendManually: false } : item) }));
    api.listMessages = vi.fn(async () => ({ messages: [own], olderCursor: null }));
    const view = await renderLineApp(api);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-account-id="account-B"]')!);
    await screen.findByText('monitor own message');
    const row = view.container.querySelector('#message-monitor-own')!.closest('.message-row')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(api.unsendMessage).not.toHaveBeenCalled();
  });

  it('does not refresh an unsent row after switching accounts while the request is pending', async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi['unsendMessage']>>>();
    const own = { ...message('account-A', 'switch-own'), senderId: 'own-account-A', direction: 'outbound' as const,
      occurredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
    const other = { ...message('account-B', 'switch-other'), text: 'other account message' };
    const api = fakeApi();
    api.listMessages = vi.fn(async (key, _cursor, _limit, exactMessageId) => ({
      messages: exactMessageId === own.messageId ? [{ ...own, text: null, deleted: true,
        content: { format: 1 as const, type: 'unsent' as const } }] : [key.accountId === 'account-A' ? own : other],
      olderCursor: null,
    }));
    api.unsendMessage = vi.fn(() => pending.promise);
    const view = await renderLineApp(api);
    const row = view.container.querySelector('#message-switch-own')!.closest('.message-row')!;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') }));
    await waitFor(() => expect(api.unsendMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-account-id="account-B"]')!);
    await screen.findByText('other account message');
    await act(async () => pending.resolve({ type: 'accepted', requestId: 'accepted', ok: true }));
    const calls = (api.listMessages as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call: unknown[]) => call[0] && (call[0] as { accountId?: string }).accountId === 'account-A'
      && call[3] === own.messageId)).toBe(false);
  });

  it('does not fetch a projected row after the conversation unmounts during unsend', async () => {
    const pending = deferred<Awaited<ReturnType<DesktopApi['unsendMessage']>>>();
    const api = fakeApi();
    const own = { ...message('account-A', 'unmount-own'), senderId: 'own-account-A', direction: 'outbound' as const,
      occurredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
    api.listMessages = vi.fn(async () => ({ messages: [own], olderCursor: null }));
    api.unsendMessage = vi.fn(() => pending.promise);
    const view = await renderLineApp(api);
    const row = view.container.querySelector('#message-unmount-own')!.closest('.message-row')!;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole('menuitem', { name: desktopTextFor('zh-TW', 'unsendMessage') }));
    await waitFor(() => expect(api.unsendMessage).toHaveBeenCalledTimes(1));
    const listMessages = api.listMessages as ReturnType<typeof vi.fn>;
    expect(listMessages.mock.calls.map((call: unknown[]) => call[3])).not.toContain(own.messageId);
    view.unmount();
    await act(async () => pending.resolve({ type: 'accepted', requestId: 'accepted', ok: true }));
    expect(api.listMessages).not.toHaveBeenCalledWith(expect.anything(), null, 1, own.messageId);
  });

  it('formats message time as a 12-hour time with a space after the period label', async () => {
    vi.stubEnv('TZ', 'Asia/Taipei');
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'time-format'), occurredAt: '2026-10-14T23:46:00.000Z' }], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('time-format');
    expect(container.querySelector('#message-time-format')?.parentElement?.querySelector('.message-time')?.textContent).toBe('上午 7:46');
    vi.unstubAllEnvs();
  });

  it('groups bubbles into runs: first of a run has avatar, name and tail; later ones do not', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      message('account-A', 'run-1'),
      { ...message('account-A', 'run-2'), occurredAt: '2026-10-15T10:02:00.000Z' },
      { ...message('account-A', 'run-3'), occurredAt: '2026-10-15T10:09:00.000Z' },
      { ...message('account-A', 'run-other'), senderId: 'other', senderName: 'Other', occurredAt: '2026-10-15T10:09:30.000Z' },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('run-other');
    const rows = [...container.querySelectorAll('.message-row.inbound')];
    expect(rows).toHaveLength(4);
    const shape = rows.map((row) => ({
      start: row.classList.contains('run-start'), avatar: row.querySelector('img.sender-avatar, span.sender-avatar') !== null,
      name: row.querySelector('.message-sender-name')?.textContent ?? null, tail: row.querySelector('.message.bubble-tail') !== null,
      spacer: row.querySelector('.inbound-avatar-spacer') !== null,
    }));
    expect(shape[0]).toEqual({ start: true, avatar: true, name: 'Sender', tail: true, spacer: false });
    expect(shape[1]).toEqual({ start: false, avatar: false, name: null, tail: false, spacer: true });
    // More than five minutes after the previous bubble starts a new run for the same sender.
    expect(shape[2]).toEqual({ start: true, avatar: true, name: 'Sender', tail: true, spacer: false });
    expect(shape[3]).toMatchObject({ start: true, name: 'Other', tail: true });
    expect(rows[0]!.classList.contains('has-sender-name')).toBe(true);
  });

  it('places meta outside the bubble: time after inbound bubbles and before outbound bubbles, outbound without avatar', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      message('account-A', 'meta-in'),
      { ...message('account-A', 'meta-out-1'), direction: 'outbound' as const, senderId: 'me', occurredAt: '2026-10-15T10:01:00.000Z' },
      { ...message('account-A', 'meta-out-2'), direction: 'outbound' as const, senderId: 'me', occurredAt: '2026-10-15T10:02:00.000Z' },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('meta-out-2');
    const inbound = container.querySelector('#message-meta-in')!;
    expect(inbound.nextElementSibling?.classList.contains('message-trailing-meta')).toBe(true);
    expect(inbound.nextElementSibling?.querySelector('.message-meta .message-time')).not.toBeNull();
    const outbound = [...container.querySelectorAll('.message-row.outbound')];
    for (const row of outbound) {
      const bubble = row.querySelector('.message')!;
      const trailingMeta = row.querySelector('.message-trailing-meta')!;
      expect(trailingMeta.querySelector('.message-meta .message-time')).not.toBeNull();
      expect(trailingMeta.parentElement).toBe(row);
      expect(row.querySelector('.sender-avatar, .message-identity, .message-sender-name')).toBeNull();
    }
    expect(outbound[0]!.querySelector('.message.bubble-tail')).not.toBeNull();
    expect(outbound[1]!.querySelector('.message.bubble-tail')).toBeNull();
  });

  it('renders media-style messages without a bubble, a vector pin and a centered event pill', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'bare-sticker'), text: null, kind: 'sticker' as const, sticker: { stickerId: '1', animated: false, altText: 'Hi' } },
      { ...message('account-A', 'bare-location'), text: null, kind: 'location' as const,
        content: { format: 1 as const, type: 'location' as const, title: '台北車站', address: '台北市', latitude: null, longitude: null } },
      { ...message('account-A', 'bare-file'), text: null, kind: 'file' as const,
        attachments: [{ id: 'att-bare', kind: 'file' as const, name: '很長很長的檔案名稱.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'ready' }] },
      { ...message('account-A', 'pill-event'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 6, text: null } },
      message('account-A', 'plain-text'),
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('plain-text');
    for (const id of ['bare-sticker', 'bare-location', 'bare-file', 'pill-event']) {
      const bubble = container.querySelector(`#message-${id}`)!;
      expect(bubble.classList.contains('bubble-bare')).toBe(true);
      expect(bubble.classList.contains('bubble-tail')).toBe(false);
    }
    expect(container.querySelector('#message-plain-text')!.classList.contains('bubble-bare')).toBe(false);
    const pin = container.querySelector('#message-bare-location .location-pin-icon')!;
    expect(pin.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('#message-bare-location')!.textContent).not.toContain('📍');
    expect(container.querySelector('#message-bare-file .file-attachment-glyph')).not.toBeNull();
    expect(container.querySelector('#message-bare-file .file-attachment-card')).not.toBeNull();
    const eventRow = container.querySelector('#message-pill-event')!.closest('.message-row')!;
    expect(eventRow.querySelector('.message.system-event-message .message-system-event')?.textContent).toBe('通話');
    expect(eventRow.querySelector('.sender-avatar, .inbound-avatar-spacer, .message-sender-name')).toBeNull();
    expect(eventRow.classList.contains('run-start')).toBe(true);
  });

  it('renders recalled messages as normal bubbles and formats call duration', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'recalled-in'), content: { format: 1 as const, type: 'unsent' as const }, text: null, deleted: true, attachments: [] },
      { ...message('account-A', 'recalled-out'), content: { format: 1 as const, type: 'unsent' as const }, direction: 'outbound' as const, senderId: 'me', text: null, deleted: true, attachments: [] },
      { ...message('account-A', 'recalled-kept'), content: { format: 1 as const, type: 'unsent' as const }, text: 'original words', deleted: true, attachments: [] },
      { ...message('account-A', 'recalled-queued'), content: { format: 1 as const, type: 'unsent' as const }, text: null, deleted: true,
        attachments: [{ id: 'recalled-queued-file', kind: 'image' as const, name: '圖片', mimeType: 'image/jpeg', sizeBytes: 10, status: 'queued' }] },
      { ...message('account-A', 'recalled-ready'), content: { format: 1 as const, type: 'unsent' as const }, text: null, deleted: true,
        attachments: [{ id: 'recalled-ready-file', kind: 'file' as const, name: 'kept.pdf', mimeType: 'application/pdf', sizeBytes: 10, status: 'ready' }] },
      { ...message('account-A', 'call-event'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 6, text: null,
          call: { media: 'audio' as const, result: 'NORMAL', durationMs: 74000 } } },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    const inbound = container.querySelector('#message-recalled-in')!;
    expect(inbound.classList.contains('system-event-message')).toBe(false);
    expect(inbound.querySelector('.message-system-event')).toBeNull();
    const inboundRow = inbound.closest('.message-row')!;
    const inboundMarker = inboundRow.querySelector('.message-recalled-label')!;
    expect(inboundMarker.textContent).toBe('已收回（無資料）');
    expect(inboundMarker.parentElement?.classList.contains('message-meta')).toBe(true);
    expect(inboundMarker.nextElementSibling).toBe(inboundRow.querySelector('.message-time'));
    expect(inbound.querySelector('.message-recalled-label')).toBeNull();
    expect(inbound.textContent).not.toContain('已收回訊息');
    expect(inbound.closest('.message-row')?.classList.contains('inbound')).toBe(true);
    expect(inbound.closest('.message-row')?.querySelector('.sender-avatar, .message-sender-name, .inbound-avatar-spacer')).not.toBeNull();
    expect(inbound.querySelector('.file-attachment-card')).toBeNull();
    const outRecalled = container.querySelector('#message-recalled-out')!;
    expect(outRecalled.closest('.message-row')?.classList.contains('outbound')).toBe(true);
    expect(outRecalled.querySelector('.message-system-event')).toBeNull();
    const outboundRow = outRecalled.closest('.message-row')!;
    const outboundMarker = outboundRow.querySelector('.message-recalled-label')!;
    expect(outboundMarker.textContent).toBe('已收回（無資料）');
    expect(outboundMarker.nextElementSibling).toBe(outboundRow.querySelector('.message-time'));
    expect(outRecalled.textContent).toBe('');
    const kept = container.querySelector('#message-recalled-kept')!;
    expect(kept.classList.contains('system-event-message')).toBe(false);
    expect(kept.textContent).toContain('original words');
    expect(kept.querySelectorAll('.message-text').length).toBe(1);
    expect(kept.classList.contains('message-recalled')).toBe(false);
    const keptRow = kept.closest('.message-row')!;
    const keptLabel = keptRow.querySelector('.message-recalled-label')!;
    expect(keptLabel.textContent).toBe('已收回');
    expect(keptLabel.nextElementSibling).toBe(keptRow.querySelector('.message-time'));
    expect(kept.querySelector('.message-recalled-divider')).toBeNull();
    expect(kept.textContent).not.toContain('已收回訊息');
    const queued = container.querySelector('#message-recalled-queued')!;
    expect(queued.classList.contains('system-event-message')).toBe(false);
    expect(queued.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已收回（無資料）');
    expect(queued.querySelector('.file-attachment-card, .inline-attachment-image')).toBeNull();
    const ready = container.querySelector('#message-recalled-ready')!;
    expect(ready.classList.contains('system-event-message')).toBe(false);
    expect(ready.querySelector('.message-recalled-divider')).toBeNull();
    expect(ready.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已收回');
    expect(ready.classList.contains('message-recalled')).toBe(false);
    expect(ready.querySelector('.file-attachment-card')).not.toBeNull();
    expect(container.querySelector('#message-call-event .message-system-event')?.textContent).toBe('語音通話 · 通話時間 01:14');
  });

  it('keeps recalled message content in the bubble while placing markers above timestamps', async () => {
    const api = fakeApi();
    const unsent = { format: 1 as const, type: 'unsent' as const };
    api.listMessages = vi.fn(async () => ({ messages: [
      message('account-A', 'quote-target'),
      { ...message('account-A', 'rq-none'), content: unsent, text: null, deleted: true, attachments: [], replyToMessageId: 'quote-target' },
      { ...message('account-A', 'rq-kept'), content: unsent, text: 'kept original', deleted: true, attachments: [], replyToMessageId: 'quote-target' },
      { ...message('account-A', 'rq-src'), content: unsent, text: null, deleted: true, deletedAtSource: true, attachments: [], replyToMessageId: 'quote-target' },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    await screen.findByText('quote-target');
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const none = container.querySelector('#message-rq-none')!;
    expect(none.closest('.message-row')?.classList.contains('inbound')).toBe(true);
    expect(none.querySelector('.message-system-event')).toBeNull();
    const noneRow = none.closest('.message-row')!;
    const noneMarker = noneRow.querySelector('.message-recalled-label')!;
    expect(noneMarker.textContent).toBe('已收回（無資料）');
    expect(noneMarker.nextElementSibling).toBe(noneRow.querySelector('.message-time'));
    expect(noneMarker.closest('.message-meta')?.parentElement?.classList.contains('message-trailing-meta')).toBe(true);
    const kept = container.querySelector('#message-rq-kept')!;
    const keptRow = kept.closest('.message-row')!;
    const keptMarker = keptRow.querySelector('.message-recalled-label')!;
    expect(keptMarker.nextElementSibling).toBe(kept.closest('.message-row')!.querySelector('.message-time'));
    expect(keptMarker.closest('.message-meta')?.parentElement?.classList.contains('message-trailing-meta')).toBe(true);
    expect(before(kept.querySelector('.reply-reference')!, kept.querySelector('.message-text')!)).toBe(true);
    expect(kept.querySelector('.message-recalled-label, .message-recalled-divider')).toBeNull();
    expect(keptMarker.textContent).toBe('已收回');
    const src = container.querySelector('#message-rq-src')!;
    const srcMarker = src.closest('.message-row')!.querySelector('.message-recalled-label')!;
    expect(srcMarker.textContent).toBe('已刪除（無資料）');
    expect(srcMarker.nextElementSibling).toBe(src.closest('.message-row')!.querySelector('.message-time'));
    expect(srcMarker.closest('.message-meta')?.parentElement?.classList.contains('message-trailing-meta')).toBe(true);
  });

  it('presents source-deleted messages like recalled ones with the 已刪除 label and recalled stickers below 已收回', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'deleted-text'), text: 'deleted words', deleted: true, deletedAtSource: true, attachments: [] },
      { ...message('account-A', 'recalled-sticker'), content: { format: 1 as const, type: 'unsent' as const }, text: null, kind: 'text' as const, deleted: true,
        recalledKind: 'sticker' as const, sticker: { stickerId: '4242', animated: false, altText: 'hello' }, attachments: [] },
      { ...message('account-A', 'recalled-location'), content: { format: 1 as const, type: 'unsent' as const }, text: null, deleted: true,
        recalledKind: 'location' as const, recalledContent: { format: 1 as const, type: 'location' as const, title: 'Taipei 101', address: null, latitude: null, longitude: null }, attachments: [] },
      { ...message('account-A', 'deleted-sticker'), text: null, kind: 'sticker' as const, deleted: true, deletedAtSource: true,
        sticker: { stickerId: '4242', animated: false, altText: 'hello' }, attachments: [] },
      { ...message('account-A', 'deleted-location'), text: null, kind: 'location' as const, deleted: true, deletedAtSource: true,
        content: { format: 1 as const, type: 'location' as const, title: 'Zhongshan Rd', address: null, latitude: null, longitude: null }, attachments: [] },
      { ...message('account-A', 'deleted-capsule-in'), text: null, deleted: true, deletedAtSource: true, attachments: [] },
      { ...message('account-A', 'deleted-capsule-out'), direction: 'outbound' as const, senderId: 'me', text: null, deleted: true, deletedAtSource: true, attachments: [] },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    const deleted = container.querySelector('#message-deleted-text')!;
    const deletedRow = deleted.closest('.message-row')!;
    const label = deletedRow.querySelector('.message-recalled-label')!;
    const text = deleted.querySelector('.message-text')!;
    expect(label.textContent).toBe('已刪除');
    expect(label.nextElementSibling).toBe(deletedRow.querySelector('.message-time'));
    expect(deleted.querySelector('.message-recalled-divider')).toBeNull();
    expect(deleted.classList.contains('system-event-message')).toBe(false);
    const sticker = container.querySelector('#message-recalled-sticker')!;
    expect(sticker.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已收回');
    expect(sticker.querySelector('.message-recalled-divider')).toBeNull();
    expect(sticker.querySelector('.message-sticker')).not.toBeNull();
    const location = container.querySelector('#message-recalled-location')!;
    expect(location.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已收回');
    expect(location.querySelector('.location-content-card')?.textContent).toContain('Taipei 101');
    // A source-deleted sticker/location keeps its own kind/content as the original: label, divider, then the original, no capsule.
    const deletedSticker = container.querySelector('#message-deleted-sticker')!;
    expect(deletedSticker.classList.contains('system-event-message')).toBe(false);
    expect(deletedSticker.querySelector('.message-recalled-divider')).toBeNull();
    const deletedStickerRow = deletedSticker.closest('.message-row')!;
    const deletedStickerMarker = deletedStickerRow.querySelector('.message-recalled-label')!;
    expect(deletedStickerMarker.textContent).toBe('已刪除');
    expect(deletedStickerMarker.nextElementSibling).toBe(deletedStickerRow.querySelector('.message-time'));
    expect(deletedSticker.querySelector('.message-sticker')).not.toBeNull();
    expect(deletedSticker.textContent).not.toContain('已刪除訊息');
    const deletedLocation = container.querySelector('#message-deleted-location')!;
    expect(deletedLocation.classList.contains('system-event-message')).toBe(false);
    expect(deletedLocation.querySelector('.message-recalled-divider')).toBeNull();
    expect(deletedLocation.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已刪除');
    expect(deletedLocation.querySelector('.location-content-card')?.textContent).toContain('Zhongshan Rd');
    expect(deletedLocation.textContent).not.toContain('已刪除訊息');
    const capsuleIn = container.querySelector('#message-deleted-capsule-in')!;
    expect(capsuleIn.classList.contains('system-event-message')).toBe(false);
    expect(capsuleIn.closest('.message-row')?.querySelector('.message-recalled-label')?.textContent).toBe('已刪除（無資料）');
    expect(capsuleIn.querySelector('.message-system-event')).toBeNull();
    const capsuleOut = container.querySelector('#message-deleted-capsule-out')!;
    const capsuleOutRow = capsuleOut.closest('.message-row')!;
    const capsuleOutMarker = capsuleOutRow.querySelector('.message-recalled-label')!;
    expect(capsuleOutMarker.textContent).toBe('已刪除（無資料）');
    expect(capsuleOutMarker.nextElementSibling).toBe(capsuleOutRow.querySelector('.message-time'));
  });

  it('shows a placeholder for a contact message with no text', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'contact'), text: null, kind: 'contact' as const }], olderCursor: null }));
    const { container } = await renderLineApp(api);
    expect(await screen.findByText('已分享 LINE 聯絡人')).toBeTruthy();
    expect(container.querySelector('#message-contact .contact-placeholder')).toBeTruthy();
  });

  it('renders normalized content cards, system events, fallbacks, and media duration', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'content-contact'), text: null, kind: 'contact' as const,
        content: { format: 1 as const, type: 'contact' as const, mid: 'u-1', displayName: '好友' } },
      { ...message('account-A', 'content-location'), text: '位置備註', kind: 'location' as const,
        content: { format: 1 as const, type: 'location' as const, title: null, address: null, latitude: null, longitude: null } },
      { ...message('account-A', 'content-rich'), text: null, kind: 'rich' as const,
        content: { format: 1 as const, type: 'rich' as const, variant: 'flex' as const, altText: null } },
      { ...message('account-A', 'content-event'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 6, text: null } },
      { ...message('account-A', 'content-gift'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 9, text: '已送出貼圖' } },
      { ...message('account-A', 'content-post'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: null } },
      { ...message('account-A', 'content-post-note'), text: null, kind: 'event' as const, postNotificationType: 'note' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: 'POSTNOTIFICATION' } },
      { ...message('account-A', 'content-post-album'), text: null, kind: 'event' as const, postNotificationType: 'album' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: 'POSTNOTIFICATION' } },
      { ...message('account-A', 'content-post-enum'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: ' postnotification ' } },
      { ...message('account-A', 'content-post-text'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: '有人在貼文中提及你' } },
      { ...message('account-A', 'content-chatevent'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 18, text: null } },
      { ...message('account-A', 'content-chatevent-text'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 18, text: '小薪已新增徐佳誠至群組。' } },
      { ...message('account-A', 'content-event-plain'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: null, text: null } },
      { ...message('account-A', 'content-unsupported'), text: null, kind: 'event' as const,
        content: { format: 1 as const, type: 'unsupported' as const, nativeContentType: 42, fallbackText: null } },
      { ...message('account-A', 'content-media'), kind: 'video' as const,
        content: { format: 1 as const, type: 'media' as const, durationMs: 12345 },
        attachments: [{ id: 'attachment-1', kind: 'video' as const, name: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 200, status: 'queued' }] },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    expect(await within(document.getElementById('timeline')!).findByText('好友')).toBeTruthy();
    expect(screen.getByText('LINE 聯絡人')).toBeTruthy();
    expect(screen.getByText('位置備註')).toBeTruthy();
    expect(screen.getByText('圖文訊息')).toBeTruthy();
    expect(screen.getByText('通話')).toBeTruthy();
    expect(screen.getByText('禮物 已送出貼圖')).toBeTruthy();
    expect(screen.getAllByText('貼文通知')).toHaveLength(2);
    expect(screen.getByText('記事本通知')).toBeTruthy();
    expect(screen.getByText('相簿通知')).toBeTruthy();
    expect(screen.queryByText('貼文通知 POSTNOTIFICATION')).toBeNull();
    expect(screen.getByText('貼文通知 有人在貼文中提及你')).toBeTruthy();
    expect(screen.getByText('聊天事件')).toBeTruthy();
    expect(screen.getByText('小薪已新增徐佳誠至群組。')).toBeTruthy();
    expect(screen.getByText('系統訊息')).toBeTruthy();
    expect(screen.getByText('此訊息類型尚未支援（類型 42）')).toBeTruthy();
    expect(container.querySelector('#message-content-media')?.textContent).toContain('0:12');
  });

  it('renders note and album notifications as sender bubbles while group events stay centered', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'note-in'), senderName: '小明', senderAvatarAvailable: true, postNotificationType: 'note' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: 'POSTNOTIFICATION' } },
      { ...message('account-A', 'album-out'), direction: 'outbound' as const, postNotificationType: 'album' as const,
        content: { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: 'POSTNOTIFICATION' } },
      { ...message('account-A', 'membership'), content: { format: 1 as const, type: 'event' as const, nativeContentType: 18, text: '小明已加入群組。' } },
    ], olderCursor: null }));
    const { container } = await renderLineApp(api);
    expect(await screen.findByText('記事本通知')).toBeTruthy();
    expect(screen.getByText('相簿通知')).toBeTruthy();
    expect(screen.getByText('小明')).toBeTruthy();
    expect(container.querySelector('#message-note-in.message.inbound')).toBeTruthy();
    expect(container.querySelector('#message-note-in .message-system-event')).toBeNull();
    expect(container.querySelector('#message-album-out.message.outbound')).toBeTruthy();
    expect(container.querySelector('#message-membership .message-system-event')).toBeTruthy();
  });

  it('hides the core warning while waiting for LINE login', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({
      ...snapshot,
      components: snapshot.components.map((item) => item.name === 'lineWorker' ? { ...item, status: 'stopped' as const } : item),
      accounts: [],
      conversations: [],
    }));
    render(<App api={api} />);

    expect(document.querySelector('.app-header')).toBeNull();
    expect(document.querySelector('.app-warning')).toBeNull();
    expect(screen.queryByText('核心功能需檢查')).toBeNull();
  });

  it('renders no top app header and no core warning when healthy', async () => {
    const { container } = await renderLineApp(fakeApi());

    expect(container.querySelector('.app-header')).toBeNull();
    expect(container.querySelector('.app-warning')).toBeNull();
    expect(screen.queryByText('訊息操作台')).toBeNull();
    expect(screen.queryByText('核心功能需檢查')).toBeNull();
  });

  it('shows the core warning right after the composer status when core components are not ready', async () => {
    const api = fakeApi();
    const base = snapshot;
    api.getSnapshot = vi.fn(async () => ({
      ...base,
      components: base.components.map((item) => item.name === 'lineWorker' ? { ...item, status: 'degraded' as const } : item),
    }));
    const { container } = await renderLineApp(api);

    const warning = await screen.findByText('核心功能需檢查');
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.closest('.composer-actions')).not.toBeNull();
    expect(warning.previousElementSibling?.getAttribute('data-testid')).toBe('composer-status');
    expect(screen.getAllByText('核心功能需檢查')).toHaveLength(1);
    expect(container.querySelector('.app-header')).toBeNull();
    expect(container.querySelector('.app-warning')).toBeNull();
  });

  it('accepts picked and dropped files in the LINE composer and sends text before media', async () => {
    const api = fakeApi();
    const order: string[] = [];
    api.sendText = vi.fn(async () => { order.push('text'); return { type: 'accepted', requestId: 'text-1', ok: true } as const; });
    api.sendManualMedia = vi.fn(async (_key, files) => { order.push(`media:${files[0]?.name}`); return { type: 'accepted', requestId: 'media-1', ok: true } as const; });
    const { container } = await renderLineApp(api);
    const picker = screen.getByTestId('line-media-file-input') as HTMLInputElement;
    const attachButton = container.querySelector('.composer-actions .attach-button')!;
    expect(attachButton.classList.contains('attach-button')).toBe(true);
    expect(attachButton.querySelector('svg')?.getAttribute('width')).toBe('18');
    expect(attachButton.querySelector('svg path')?.getAttribute('d')).toBe('M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5');
    const picked = new File([new Uint8Array([1, 2])], 'picked.txt', { type: 'text/plain' });
    const dropped = new File([new Uint8Array([3, 4])], 'dropped.txt', { type: 'text/plain' });
    fireEvent.change(picker, { target: { files: [picked] } });
    fireEvent.drop(screen.getByRole('textbox', { name: 'LINE 訊息' }), { dataTransfer: { files: [dropped] } });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello first' } });
    expect(screen.getByText('picked.txt')).toBeTruthy();
    expect(screen.getByText('dropped.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(order).toEqual(['text', 'media:picked.txt', 'media:dropped.txt']));
  });

  it('keeps the uncertain attachment and stops the remaining media batch', async () => {
    const api = fakeApi();
    api.sendManualMedia = vi.fn(async () => ({ type: 'error', requestId: 'media-unknown', ok: false,
      code: 'LINE_SEND_OUTCOME_UNKNOWN', message: 'unknown', retryable: false } as const));
    await renderLineApp(api);
    const picker = screen.getByTestId('line-media-file-input') as HTMLInputElement;
    const files = [new File([new Uint8Array([1])], 'first.txt'), new File([new Uint8Array([2])], 'second.txt')];
    fireEvent.change(picker, { target: { files } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.sendManualMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByText('first.txt')).toBeTruthy();
    expect(screen.getByText('second.txt')).toBeTruthy();
  });

  it('reports account readiness rejection as definitely not sent', async () => {
    const api = fakeApi();
    api.sendManualMedia = vi.fn(async () => ({ type: 'error', requestId: 'media-not-ready', ok: false,
      code: 'ACCOUNT_NOT_READY', message: 'not ready', retryable: false } as const));
    await renderLineApp(api);
    fireEvent.change(screen.getByTestId('line-media-file-input'), { target: { files: [new File([new Uint8Array([1])], 'wait.txt')] } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    expect(await screen.findByText('附件未傳送，可以重試。')).toBeTruthy();
    expect(screen.queryByText('無法確認訊息是否已送出，請到 LINE 確認。')).toBeNull();
    expect(screen.getByText('wait.txt')).toBeTruthy();
  });

  it('shows scoped account, conversation, sender, and ready-image media with text fallback', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot,
      accounts: snapshot.accounts.map((item) => ({ ...item, avatarAvailable: item.accountId === 'account-A' })),
      conversations: snapshot.conversations.map((item) => ({ ...item, avatarAvailable: item.accountId === 'account-A' })),
    }));
    api.openAttachment = vi.fn(async () => true);
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'image-message'), senderAvatarAvailable: true,
      attachments: [{ id: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', kind: 'image' as const, name: 'photo.png',
        mimeType: 'image/png', sizeBytes: 18, status: 'ready' }] }], olderCursor: null }));

    const { container } = await renderLineApp(api);
    await waitFor(() => expect(container.querySelector('img.account-avatar')).not.toBeNull());
    expect(container.querySelector('img.conversation-avatar')).not.toBeNull();
    expect(container.querySelector('img.sender-avatar')).not.toBeNull();
    expect(container.querySelector('img.inline-attachment-image')).not.toBeNull();
    const open = screen.getByRole('button', { name: '開啟' });
    const imageBubble = container.querySelector('article.message')!;
    expect(imageBubble.contains(open)).toBe(false);
    expect(open.compareDocumentPosition(screen.getByRole('button', { name: '回覆' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(open);
    expect(api.openAttachment).toHaveBeenCalledWith('2a653934-7064-4d90-a9f0-e6e24cf4f93d');
    vi.mocked(api.openAttachment).mockResolvedValue(false);
    fireEvent.click(open);
    expect(await within(screen.getByTestId('composer-status')).findByText('無法開啟附件，請確認檔案仍可用且已設定 Windows 預設應用程式。')).toBeTruthy();
  });
  it('shows the requested full labels in the feature rail', async () => {
    render(<App api={fakeApi()} />);
    const navigation = await screen.findByRole('navigation', { name: '主要導覽' });
    expect(Array.from(navigation.querySelectorAll('.nav-short'), (item) => item.textContent)).toEqual([
      '聊天', '助理', '搜尋', '任務', '設定',
    ]);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(await screen.findByRole('tab', { name: '紀錄' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '狀態' })).toBeNull();
  });

  it('shares the search account scope with the account rail and keeps it when returning to search', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    fireEvent.click(await screen.findByRole('button', { name: '搜尋' }));

    const scopeTab = async (name: string) => within(await screen.findByRole('tablist', { name: '帳號篩選' })).getByRole('tab', { name });
    expect(screen.queryByRole('combobox', { name: '帳號' })).toBeNull();
    expect((await scopeTab('工作')).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await scopeTab('觀察'));
    expect((await scopeTab('觀察')).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '查看觀察' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    expect((await scopeTab('觀察')).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(await scopeTab('全部帳號'));
    await waitFor(() => expect(screen.getByRole('tab', { name: '全部帳號' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('button', { name: '查看觀察' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '聊天' }));
    expect(screen.getByRole('button', { name: '查看觀察' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows only the selected conversation Agent trigger state beside chat resources', async () => {
    await renderLineApp(fakeApi());
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    expect(screen.getByText('Agent 觸發：未啟用')).toBeTruthy();
    expect(screen.queryByText('Agent 觸發：未啟用 · Claude')).toBeNull();
    expect(screen.queryByText('收訊監控與 Agent 觸發分開設定')).toBeNull();
    const statusArea = document.querySelector('.chat-header-meta');
    expect(statusArea?.firstElementChild?.classList.contains('agent-trigger-status')).toBe(true);
    expect(statusArea?.firstElementChild?.nextElementSibling?.classList.contains('chat-resources-actions')).toBe(true);
    expect(screen.queryByText('已連線')).toBeNull();
  });

  it('localizes the external monitoring status and preserves connected and paused labels', () => {
    const monitored = snapshot.accounts.find((account) => account.accountId === 'account-B')!;
    expect(accountHeaderStatusFor(monitored, 'en')).toBe('Monitoring');
    expect(accountHeaderStatusFor(monitored, 'zh-TW')).toBe('監控中');
    expect(accountHeaderStatusFor(monitored, 'ja')).toBe('監視中');
    expect(accountHeaderStatusFor(monitored, 'ko')).toBe('모니터링 중');
    expect(accountHeaderStatusFor(snapshot.accounts[0]!, 'zh-TW')).toBe('已連線');
    expect(accountHeaderStatusFor({ ...snapshot.accounts[0]!, mode: 'PAUSED' }, 'zh-TW')).toBe('已暫停');
  });

  it('shows the enabled state for the selected conversation Agent trigger', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [{
      ...snapshot.conversations[0]!, agentEnabled: true, defaultProvider: 'codex' as const,
    }] }));
    await renderLineApp(api);
    await screen.findByText('Agent 觸發：已啟用');
  });

  it('renders committed job state delivered by the coalesced domain snapshot publisher', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    const job = { jobId: 'job-state', accountId: 'account-A', chatType: 'group' as const, chatId: 'same-chat',
      provider: 'codex' as const, prompt: '整理工作', status: 'running' as const, createdAt: '2026-10-16T05:00:00.000Z' };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, jobs: [job] }));
    api.onEvent = vi.fn((listener) => { listeners.push(listener); return () => undefined; });
    await renderLineApp(api);
    fireEvent.click(await screen.findByRole('button', { name: '任務' }));
    const jobsTable = within(screen.getByRole('table', { name: 'Agent 任務列表' }));
    expect(await jobsTable.findByText('(執行中)')).toBeTruthy();
    const update = createCoalescedSnapshotPublisher(async () => ({ ...snapshot, jobs: [{ ...job, status: 'completed' }] }),
      (event) => listeners.forEach((listener) => listener(event)));

    await act(async () => { await Promise.all([update(), update()]); });

    expect(await jobsTable.findByText('(已完成)')).toBeTruthy();
  });

  it('marks only accounts with a bound primary administrator using a crown', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [
      { ...snapshot.accounts[0]!, hasPrimaryAdmin: true },
      { ...snapshot.accounts[1]!, hasPrimaryAdmin: false },
    ] }));
    await renderLineApp(api);

    const administrator = await screen.findByRole('button', { name: '查看工作，已綁定管理者' });
    expect(administrator.querySelector('.admin-crown')?.textContent).toBe('♛');
    expect(screen.getByRole('button', { name: '查看觀察' }).querySelector('.admin-crown')).toBeNull();
  });

  it('starts external monitoring (啟動外部監控) from an eligible logged-out Primary Admin card and renders persisted progress', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [snapshot.accounts[0]!, {
      ...snapshot.accounts[1]!, status: 'disconnected' as const, hasPrimaryAdmin: true, canStartExternalImport: true,
      productRole: 'PRIMARY_ADMIN' as const, hasVerifiedLineIdentity: true,
      externalImportProgress: { stage: 'importing_history' as const, copiedBytes: '200', totalBytes: '200',
        committedRows: '81', eligibleRows: '120', message: null },
    }] }));
    await renderLineApp(api);
    await openSystemTab();
    expect((await screen.findByLabelText('LINE 歷史匯入進度')).textContent).toContain('匯入歷史訊息');
    expect(screen.getByText('已提交 81 / 120 則訊息')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '啟動外部監控' }));
    await waitFor(() => expect(api.externalImportStart).toHaveBeenCalledWith('account-B'));
  });

  it('keeps the chat panel visible without a chat panel toggle', async () => {
    render(<App api={fakeApi()} />);
    const search = await screen.findByPlaceholderText('搜尋聊天室');
    expect(search).toBeTruthy();
    expect(document.querySelector('.chat-panel')).toBeTruthy();
    expect(document.querySelector('.chat-panel-toggle')).toBeNull();
    expect(document.querySelector('.conversation-layout')?.classList.contains('chat-panel-closed')).toBe(false);
    fireEvent.change(search, { target: { value: '測試搜尋' } });
    expect(document.querySelector('.chat-panel')).toBeTruthy();
  });

  it('shows local person placeholders for account avatars while preserving accessible account names', async () => {
    render(<App api={fakeApi()} />);
    const rail = await screen.findByRole('complementary', { name: '帳號與導覽' });
    const work = screen.getByRole('button', { name: '查看工作' });
    const observer = screen.getByRole('button', { name: '查看觀察' });
    expect(work.querySelector('[data-avatar-placeholder="person"]')).toBeTruthy();
    expect(observer.querySelector('[data-avatar-placeholder="person"]')).toBeTruthy();
    expect(work.textContent).toBe('');
    expect(observer.textContent).toBe('');
    expect(work.closest('.account-item')?.getAttribute('title')).toBeNull();
    expect(rail.textContent).not.toContain('account-A');
    expect(rail.textContent).not.toContain('account-B');
    expect(rail.textContent).not.toContain('ACTIVE_CONTROL');
    expect(rail.textContent).not.toContain('MONITOR_ONLY');
    expect(rail.textContent).not.toContain('主操作');
    expect(rail.textContent).not.toContain('僅監控');
    expect(screen.queryByRole('heading', { name: '聊天室' })).toBeNull();
    expect(screen.getByPlaceholderText('搜尋聊天室')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
  });

  it('places chat type before the name and shows the latest message in the former type row', async () => {
    const api = fakeApi();
    const direct = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'direct-1', title: '徐佳誠', unreadCount: 0, agentEnabled: false, defaultProvider: 'claude' as const, latestMessagePreview: '嗨，明天見', latestMessageAt: '2026-10-15T10:00:00.000Z', latestAttachmentStatus: null };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [snapshot.conversations[0]!, direct] }));
    api.listMessages = vi.fn(async (key) => ({ messages: [{ ...message(key.accountId, key.chatId === 'direct-1' ? '嗨，明天見' : '群組最新訊息'), chatType: key.chatType, chatId: key.chatId, text: key.chatId === 'direct-1' ? '嗨，明天見' : '群組最新訊息' }], olderCursor: null }));
    await renderLineApp(api);
    const groupRow = await screen.findByRole('button', { name: '同名群組 群組' });
    const directRow = screen.getByRole('button', { name: '徐佳誠 個人' });
    expect(groupRow.querySelector('strong')?.textContent).toBe('同名群組');
    expect(directRow.querySelector('strong')?.textContent).toBe('徐佳誠');
    expect(groupRow.querySelector('.avatar-badge-wrap .chat-type-badge svg[role="img"]')?.getAttribute('aria-label')).toBe('群組');
    expect(directRow.querySelector('.avatar-badge-wrap .chat-type-badge svg[role="img"]')?.getAttribute('aria-label')).toBe('個人');
    expect(groupRow.querySelector('strong svg')).toBeNull();
    expect(directRow.querySelector('.list-preview')?.getAttribute('data-preview')).toBe('嗨，明天見');
    expect(directRow.querySelector('time.conversation-time')?.textContent).toBe(formatLatestMessageTime(direct.latestMessageAt));
    expect(groupRow.querySelector('.list-preview')?.getAttribute('data-preview')).toBe('群組摘要');
    expect(vi.mocked(api.listMessages).mock.calls.filter((call) => call[2] === 1)).toHaveLength(0);
  });

  it('renders chat-list preview sticons as inline images without private-use characters', async () => {
    const api = fakeApi();
    const sticonChat = { accountId: 'account-A', chatType: 'group' as const, chatId: 'sticon-chat', title: '千年沉睡之旅', unreadCount: 0, agentEnabled: false, defaultProvider: 'claude' as const,
      latestMessagePreview: '小密秘￼￼快樂', latestMessageAt: '2026-10-22T10:00:00.000Z', latestAttachmentStatus: null, latestMessageId: 'latest-sticon',
      latestSticonRanges: [3, 4].map((start) => ({ start, end: start + 1, productId: '0123456789abcdef01234567', sticonId: String(start), animated: false })) };
    const stray = { ...sticonChat, chatId: 'stray-chat', title: '殘留字元', latestMessageId: 'latest-stray', latestSticonRanges: [], latestMessagePreview: `hi ${String.fromCodePoint(0x100103)}` };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [snapshot.conversations[0]!, sticonChat, stray] }));
    await renderLineApp(api);
    const row = await screen.findByRole('button', { name: '千年沉睡之旅 群組' });
    const preview = row.querySelector('.list-preview')!;
    const images = [...preview.querySelectorAll('.list-sticon')] as HTMLElement[];
    expect(images).toHaveLength(2);
    images.forEach((node, index) => {
      if (node.tagName === 'IMG') expect((node as HTMLImageElement).getAttribute('src')).toBe(lineMediaUrl({ type: 'sticon', accountId: 'account-A', chatType: 'group', chatId: 'sticon-chat', messageId: 'latest-sticon', index }));
      else expect(node.textContent).toBe('[表情]');
    });
    expect(preview.classList.contains('list-preview')).toBe(true);
    expect(/[\u{F0000}-\u{10FFFF}]/u.test(preview.textContent ?? '')).toBe(false);
    expect(preview.getAttribute('aria-label')).toBe('最新訊息：小密秘[表情][表情]快樂');
    const strayPreview = screen.getByRole('button', { name: '殘留字元 群組' }).querySelector('.list-preview')!;
    expect(strayPreview.getAttribute('data-preview')).toBe('hi ');
  });

  it.each(['direct', 'group', 'community', 'room', 'thread'] as const)('marks the %s chat type badge', async (chatType) => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [{ ...snapshot.conversations[0]!, chatType }] }));
    await renderLineApp(api);
    const badge = document.querySelector('.conversation-row .chat-type-badge');
    expect(badge?.getAttribute('data-chat-type')).toBe(chatType);
    expect(badge?.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('does not repeat the LINE destination or account route above the composer', async () => {
    await renderLineApp(fakeApi());
    await screen.findByLabelText('LINE 訊息');
    const composer = document.getElementById('composer')!;
    expect(composer.querySelector('.route-plate')).toBeNull();
    expect(composer.textContent).not.toContain('工作 → 同名群組');
    expect(screen.queryByRole('button', { name: 'LINE 傳送' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本機 Agent' })).toBeNull();
  });

  it('pins the shared Agent 室 first and uses the default provider without a LINE composer', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, defaultProvider: 'codex' as const }));
    await renderAssistantApp(api);
    await screen.findByRole('heading', { name: 'Agent 室' });
    // The room is a full page: no chat list, and no Agent room row in the chat list either.
    expect(document.querySelector('.conversation-row')).toBeNull();
    expect(document.getElementById('conversation-list')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement).value).toBe('codex');
    expect(screen.getByRole('textbox', { name: 'Agent 訊息' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'LINE 訊息' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'LINE 傳送' })).toBeNull();
  });

  it('submits Agent 室 input only to the configured local provider', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, defaultProvider: 'codex' as const }));
    await renderAssistantApp(api);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '整理今天的訊息' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledWith({ provider: 'codex', prompt: '整理今天的訊息' }));
    expect(api.sendText).not.toHaveBeenCalled();
    expect(api.replyText).not.toHaveBeenCalled();
  });

  it('uses a sidebar account click to filter the chat list without changing control authority', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const controlAccount = document.querySelector<HTMLButtonElement>('[data-account-id="account-A"]')!;
    const monitorAccount = document.querySelector<HTMLButtonElement>('[data-account-id="account-B"]')!;
    expect(controlAccount.getAttribute('aria-pressed')).toBe('true');
    expect(controlAccount.closest('.account-item')?.classList.contains('selected')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    expect(controlAccount.getAttribute('aria-pressed')).toBe('false');
    expect(controlAccount.closest('.account-item')?.classList.contains('selected')).toBe(false);
    expect(monitorAccount.getAttribute('aria-pressed')).toBe('true');
    expect(monitorAccount.closest('.account-item')?.classList.contains('selected')).toBe(true);
    expect(screen.getAllByRole('button', { name: /同名群組.*群組/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /同名群組.*群組/ }).textContent).not.toContain('account-B');
  });

  it('creates a three-minute primary administrator pairing token only from account management', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    expect(screen.queryByRole('button', { name: '新增管理' })).toBeNull();
    await openSystemTab();
    fireEvent.click(screen.getByRole('button', { name: '新增管理' }));
    expect((await screen.findByText(/已進入主要管理者驗證監控/)).textContent).toContain('3 分鐘');
    expect(screen.getByLabelText('主要管理者 6 位數驗證碼').textContent).toBe('123456');
    expect(api.lineBeginAdminPairing).toHaveBeenCalledWith('account-A');
  });

  it('dismisses transient login feedback while keeping QR, PIN, and an active admin challenge visible', async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      const { rerender } = render(<LineLogin api={api} accounts={[snapshot.accounts[0]!]} headingRef={React.createRef<HTMLHeadingElement>()}
        live={{ accountId: 'account-A', loginAttemptId: 'attempt-1', state: 'connecting', message: null,
          imageDataUrl: 'data:image/png;base64,cXItY29kZQ==' }} />);
      expect(screen.getByRole('img', { name: 'LINE QR 登入碼' })).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '新增管理' }));
        await Promise.resolve();
      });
      expect(document.querySelector('.system-toast')).toBeTruthy();
      expect(document.querySelector('[aria-label="主要管理者 6 位數驗證碼"]')?.textContent).toBe('123456');

      act(() => { vi.advanceTimersByTime(5000); });
      expect(document.querySelector('.system-toast')).toBeNull();
      expect(screen.getByRole('img', { name: 'LINE QR 登入碼' })).toBeTruthy();
      expect(document.querySelector('[aria-label="主要管理者 6 位數驗證碼"]')?.textContent).toBe('123456');

      rerender(<LineLogin api={api} accounts={[snapshot.accounts[0]!]} headingRef={React.createRef<HTMLHeadingElement>()}
        live={{ accountId: 'account-A', loginAttemptId: 'attempt-1', state: 'connecting', message: null, pin: '654321' }} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
        await Promise.resolve();
      });
      expect(document.querySelector('.system-toast')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(document.querySelector('.system-toast')).toBeNull();
      expect(screen.getByLabelText('LINE 6 位數認證碼').textContent).toBe('654321');
      expect(document.querySelector('[aria-label="主要管理者 6 位數驗證碼"]')?.textContent).toBe('123456');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('binding the primary admin from the official LINE', () => {
    const BIND_BUTTON = '從 LINE 設定管理者並啟動外部監控';
    const renderAgentOnly = (api: DesktopApi, hasPrimaryAdmin: boolean) => render(
      <LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin }]} headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);

    it('shows the button only while no primary admin is bound', () => {
      renderAgentOnly(fakeApi(), false);
      expect(screen.getByRole('button', { name: BIND_BUTTON })).toBeTruthy();
      cleanup();
      renderAgentOnly(fakeApi(), true);
      expect(screen.queryByRole('button', { name: BIND_BUTTON })).toBeNull();
      cleanup();
      // No Agent account: the action is offered too (an Agent is optional for the operator).
      render(<LineLogin api={fakeApi()} accounts={[]} headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
      expect(screen.getByRole('button', { name: BIND_BUTTON })).toBeTruthy();
      expect(screen.queryByText(/自動綁定/)).toBeNull();
      cleanup();
      // Admin slot already set while no Agent exists: no action, and the empty Agent slot explains the automatic bind.
      render(<LineLogin api={fakeApi()} accounts={[{ ...snapshot.accounts[1]!, productRole: 'PRIMARY_ADMIN' as const, hasPrimaryAdmin: false }]}
        headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
      expect(screen.queryByRole('button', { name: BIND_BUTTON })).toBeNull();
      expect(screen.getByText('主要管理者已設定；新增 Agent 帳號後會自動綁定為它的管理者。')).toBeTruthy();
    });

    it('confirms with the account name, then binds with the previewed MID and reports success', async () => {
      const api = fakeApi();
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      expect((await screen.findByText('將「王小明」設為主要管理者？')).textContent).toContain('王小明');
      fireEvent.click(screen.getByRole('button', { name: '確定' }));
      await waitFor(() => expect(api.startExternalMonitorAsAdmin).toHaveBeenCalledWith(`u${'a'.repeat(32)}`));
      // The overlay stays open until the first import of the new Primary Admin account reaches monitoring.
      expect(await screen.findByText('檢查 LINE 來源…')).toBeTruthy();
    });

    it('uses the masked MID without a name', async () => {
      const api = fakeApi();
      api.previewExternalAdminBinding = vi.fn(async () => ({ type: 'previewExternalAdminBinding', requestId: 'x', ok: true,
        identity: { mid: `u1a2b${'0'.repeat(23)}9f0e`, displayName: null }, otherCandidates: 1 } as const));
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      const text = (await screen.findByText(/設為主要管理者？/)).textContent ?? '';
      expect(text).toBe('將「u1a2b…9f0e」設為主要管理者？');
      expect(text).not.toContain('0'.repeat(10));
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
    });

    it('makes no binding call when the user cancels', async () => {
      const api = fakeApi();
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      await screen.findByText(/設為主要管理者？/);
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(api.previewExternalAdminBinding).toHaveBeenCalledTimes(1);
      expect(api.startExternalMonitorAsAdmin).not.toHaveBeenCalled();
    });

    it('maps error codes to zh-TW and reports a bound admin whose monitoring did not start', async () => {
      const api = fakeApi();
      api.previewExternalAdminBinding = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false,
        code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'raw reader code', retryable: true } as const));
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      expect(await screen.findByText('無法讀取 LINE 目前登入的帳號，請確認 LINE 已開啟並登入。')).toBeTruthy();
      cleanup();
      const second = fakeApi();
      second.startExternalMonitorAsAdmin = vi.fn(async () => ({ type: 'startExternalMonitorAsAdmin', requestId: 'x', ok: true,
        bound: true, started: false, message: 'reader_source_unsupported:official_account_not_active' } as const));
      renderAgentOnly(second, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      await screen.findByText(/設為主要管理者？/);
      fireEvent.click(screen.getByRole('button', { name: '確定' }));
      expect(await screen.findByText('已設定主要管理者，但外部監控未啟動：LINE 目前登入的不是主要管理者帳號，請在 LINE 切換到管理者帳號後再啟動外部監控。')).toBeTruthy();
    });

    it.each([
      ['source_io_error', '無法讀取 LINE 目前登入的帳號，請確認 LINE 已開啟並登入。'],
      ['key_unavailable', '請先開啟 LINE 並登入主要管理者帳號，再啟動外部監控。'],
      ['unsupported_build', '無法讀取 LINE 目前登入的帳號，請確認 LINE 已開啟並登入。'],
    ])('shows the reader code %s on its own line under the unavailable official identity sentence', async (code, sentence) => {
      const api = fakeApi();
      api.previewExternalAdminBinding = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false,
        code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: code, retryable: true } as const));
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      expect(await screen.findByText(sentence)).toBeTruthy();
      const line = await screen.findByText(/^錯誤代碼：/);
      expect(line.textContent).toBe(`錯誤代碼：${code}`);
      expect(line.querySelector('span')?.textContent).toBe(code);
    });

    it('shows no code line when the unavailable-identity message is not a machine code', async () => {
      const api = fakeApi();
      api.previewExternalAdminBinding = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false,
        code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'raw reader code', retryable: true } as const));
      renderAgentOnly(api, false);
      fireEvent.click(screen.getByRole('button', { name: BIND_BUTTON }));
      expect(await screen.findByText('無法讀取 LINE 目前登入的帳號，請確認 LINE 已開啟並登入。')).toBeTruthy();
      expect(screen.queryByText(/錯誤代碼/)).toBeNull();
    });

    it.each([
      ['official_account_not_active', 'LINE 目前登入的不是主要管理者帳號，請在 LINE 切換到管理者帳號後再啟動外部監控。'],
      ['reader_source_identity_changed', 'LINE 目前登入的不是主要管理者帳號，請在 LINE 切換到管理者帳號後再啟動外部監控。'],
      ['key_unavailable', '請先開啟 LINE 並登入主要管理者帳號，再啟動外部監控。'],
      ['process_missing', '請先開啟 LINE 並登入主要管理者帳號，再啟動外部監控。'],
      ['candidate_ambiguous', 'LINE 有多個資料庫同時更新，請稍後再試。'],
      ['reader_inventory_invalid', '外部監控中斷，請重新啟動外部監控。'],
      ['reader_inventory_shape_invalid', '外部監控中斷，請重新啟動外部監控。'],
    ])('shows the %s import failure as a Chinese sentence with the code only as small secondary text', (code, sentence) => {
      for (const message of [code, `reader_source_unsupported:${code}`]) {
        const admin = { ...snapshot.accounts[1]!, productRole: 'PRIMARY_ADMIN' as const, hasPrimaryAdmin: true,
          externalImportProgress: { stage: 'failed' as const, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null, message } };
        const { container } = render(<LineLogin api={fakeApi()} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }, admin]}
          headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
        const alert = within(container).getByRole('alert');
        expect(alert.textContent?.startsWith(sentence)).toBe(true);
        expect(alert.querySelector('small')?.textContent).toContain(code);
        expect(alert.firstChild?.textContent).toBe(sentence);
        cleanup();
      }
    });

    describe('line_window_ambiguous prompt', () => {
      const PROMPT = 'LINE 目前開著多個視窗，無法確定哪一個是主視窗。請關閉 LINE 的其他視窗（例如獨立的聊天視窗），只留主視窗或全部關閉後，按「繼續」。';
      const adminWith = (progress: { stage: 'failed' | 'copying_snapshot'; message?: string }) => ({ ...snapshot.accounts[1]!, productRole: 'PRIMARY_ADMIN' as const, hasPrimaryAdmin: true,
        externalImportProgress: { stage: progress.stage, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null, message: progress.message ?? null } });
      const agent = { ...snapshot.accounts[0]!, hasPrimaryAdmin: true };
      const failed = { stage: 'failed' as const, message: 'reader_source_unsupported:line_window_ambiguous' };

      it('maps the code to the card text', () => {
        render(<LineLogin api={fakeApi()} accounts={[agent, adminWith(failed)]} headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
        expect(screen.getByRole('alert').textContent?.startsWith('LINE 開著多個視窗，請關閉其他 LINE 視窗後重新啟動外部監控。')).toBe(true);
      });
      it('shows no prompt for a state that was already failed at mount', () => {
        render(<LineLogin api={fakeApi()} accounts={[agent, adminWith(failed)]} headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
        expect(screen.queryByText(PROMPT)).toBeNull();
      });
      it('prompts on a live change to failed; 繼續 restarts monitoring for that account', async () => {
        const api = fakeApi();
        const headingRef = React.createRef<HTMLHeadingElement>();
        const { rerender } = render(<LineLogin api={api} accounts={[agent, adminWith({ stage: 'copying_snapshot' })]} headingRef={headingRef} live={null} />);
        expect(screen.queryByText(PROMPT)).toBeNull();
        rerender(<LineLogin api={api} accounts={[agent, adminWith(failed)]} headingRef={headingRef} live={null} />);
        expect(await screen.findByText(PROMPT)).toBeTruthy();
        expect(api.externalImportStart).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: '繼續' }));
        await waitFor(() => expect(api.externalImportStart).toHaveBeenCalledWith(snapshot.accounts[1]!.accountId));
        expect(screen.queryByText(PROMPT)).toBeNull();
      });
      it('取消 closes the prompt without starting', async () => {
        const api = fakeApi();
        const headingRef = React.createRef<HTMLHeadingElement>();
        const { rerender } = render(<LineLogin api={api} accounts={[agent, adminWith({ stage: 'copying_snapshot' })]} headingRef={headingRef} live={null} />);
        rerender(<LineLogin api={api} accounts={[agent, adminWith(failed)]} headingRef={headingRef} live={null} />);
        fireEvent.click(await screen.findByRole('button', { name: '取消' }));
        expect(screen.queryByText(PROMPT)).toBeNull();
        expect(api.externalImportStart).not.toHaveBeenCalled();
      });
    });

    it('maps free-form backend diagnostics to safe display copy', () => {
      const admin = { ...snapshot.accounts[1]!, productRole: 'PRIMARY_ADMIN' as const, hasPrimaryAdmin: true,
        externalImportProgress: { stage: 'complete' as const, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null,
          message: 'External monitoring paused.' } };
      render(<LineLogin api={fakeApi()} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }, admin]}
        headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
      expect(screen.getByText('外部監控中斷，請重新啟動外部監控。')).toBeTruthy();
    });
  });

  it('shows pairing success and clears the challenge when the account snapshot becomes bound', async () => {
    const api = fakeApi();
    const headingRef = React.createRef<HTMLHeadingElement>();
    const { rerender } = render(<LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: false }]}
      headingRef={headingRef} live={null} />);
    fireEvent.click(screen.getByRole('button', { name: '新增管理' }));
    expect(await screen.findByLabelText('主要管理者 6 位數驗證碼')).toBeTruthy();
    rerender(<LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }]}
      headingRef={headingRef} live={null} />);
    expect(await screen.findByText('管理者新增成功', { selector: '.system-toast' })).toBeTruthy();
    expect(screen.queryByLabelText('主要管理者 6 位數驗證碼')).toBeNull();
    expect(screen.queryByRole('button', { name: '新增管理' })).toBeNull();
  });

  it('keeps pairing success visible and clears its code when LINE is already connected', async () => {
    const api = fakeApi();
    const headingRef = React.createRef<HTMLHeadingElement>();
    const live = { accountId: 'account-A', loginAttemptId: null, state: 'connected' as const, message: null };
    const { rerender } = render(<LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: false }]}
      headingRef={headingRef} live={live} />);
    fireEvent.click(screen.getByRole('button', { name: '新增管理' }));
    expect(await screen.findByLabelText('主要管理者 6 位數驗證碼')).toBeTruthy();
    rerender(<LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }]}
      headingRef={headingRef} live={live} />);
    expect(await screen.findByText('管理者新增成功', { selector: '.system-toast' })).toBeTruthy();
    expect(screen.queryByLabelText('主要管理者 6 位數驗證碼')).toBeNull();
  });

  it('does not invent a pairing success notice for an already bound initial account', () => {
    render(<LineLogin api={fakeApi()} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }]}
      headingRef={React.createRef<HTMLHeadingElement>()} live={null} />);
    expect(screen.queryByText('管理者新增成功')).toBeNull();
    expect(screen.getByText('主要管理者：已綁定')).toBeTruthy();
  });

  it('keeps the current launch language when restart is deferred and loads the saved choice on the next launch', async () => {
    let saved = { preference: 'automatic' as const, effectiveLocale: 'en' as const };
    const api = fakeApi();
    api.getLocale = vi.fn(async () => saved);
    api.setLocale = vi.fn(async (preference) => {
      saved = { preference, effectiveLocale: preference === 'automatic' ? 'en' : preference };
      return saved;
    });
    const firstLaunch = render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const selector = await screen.findByRole('combobox', { name: 'Language' });
    fireEvent.change(selector, { target: { value: 'ja' } });
    expect(await screen.findByRole('alertdialog', { name: 'Restart the application now to apply the saved language?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(api.restartApplication).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'System Settings' })).toBeTruthy();
    expect(screen.getByText('Current language: English')).toBeTruthy();
    expect((selector as HTMLSelectElement).value).toBe('ja');
    firstLaunch.unmount();

    localStorage.setItem('linejs.lastPage', 'settings');
    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: 'システム設定' })).toBeTruthy();
    expect(screen.getByText('現在の言語: 日本語')).toBeTruthy();
    expect(api.getLocale).toHaveBeenCalledTimes(2);
  });

  it('does not write or prompt when the selected language preference is unchanged', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'automatic' as const, effectiveLocale: 'en' as const }));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Language' }), { target: { value: 'automatic' } });
    expect(api.setLocale).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog', { name: 'Restart the application now to apply the saved language?' })).toBeNull();
  });

  it('coalesces rapid language changes while a save is in flight', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'automatic' as const, effectiveLocale: 'en' as const }));
    let finishSave!: (value: { preference: 'ja'; effectiveLocale: 'en' }) => void;
    api.setLocale = vi.fn(() => new Promise<{ preference: 'ja'; effectiveLocale: 'en' }>((resolve) => { finishSave = resolve; }));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const selector = await screen.findByRole('combobox', { name: 'Language' });
    fireEvent.change(selector, { target: { value: 'ja' } });
    fireEvent.change(selector, { target: { value: 'ko' } });
    expect(api.setLocale).toHaveBeenCalledOnce();
    await act(async () => finishSave({ preference: 'ja', effectiveLocale: 'en' }));
    expect(await screen.findByRole('alertdialog', { name: 'Restart the application now to apply the saved language?' })).toBeTruthy();
    expect(api.restartApplication).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'Restart the application now to apply the saved language?', 'Restart now', 'Later'],
    ['zh-TW', '要立即重新啟動應用程式以套用已儲存的語言嗎？', '立即重新啟動', '稍後'],
    ['ja', '保存した言語を適用するため、今すぐアプリを再起動しますか？', '今すぐ再起動', '後で'],
    ['ko', '저장한 언어를 적용하려면 지금 앱을 다시 시작할까요?', '지금 다시 시작', '나중에'],
  ] as const)('localizes the restart choice in %s', async (locale, prompt, now, later) => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: locale, effectiveLocale: locale }));
    api.setLocale = vi.fn(async () => ({ preference: 'en' as const, effectiveLocale: locale }));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: desktopTextFor(locale, 'settings') }));
    const languageName = ({ en: 'Language', 'zh-TW': '語言', ja: '言語', ko: '언어' } as const)[locale];
    fireEvent.change(await screen.findByRole('combobox', { name: languageName }), { target: { value: locale === 'en' ? 'ja' : 'en' } });
    expect(await screen.findByRole('alertdialog', { name: prompt })).toBeTruthy();
    expect(screen.getByRole('button', { name: now })).toBeTruthy();
    expect(screen.getByRole('button', { name: later })).toBeTruthy();
  });

  it('uses the system locale on the first launch with an automatic preference', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'automatic' as const, effectiveLocale: 'ja' as const }));
    render(<App api={api} />);
    expect(await screen.findByRole('button', { name: 'チャット' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(await screen.findByRole('heading', { name: 'システム設定' })).toBeTruthy();
    expect(screen.getByText('現在の言語: 日本語')).toBeTruthy();
    expect(api.getLocale).toHaveBeenCalledOnce();
  });

  it('reads the main locale once when StrictMode replays startup effects', async () => {
    const api = fakeApi();
    render(<React.StrictMode><App api={api} /></React.StrictMode>);
    await screen.findByRole('button', { name: '設定' });
    expect(api.getLocale).toHaveBeenCalledOnce();
  });

  it('does not restart when saving a language fails', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'automatic' as const, effectiveLocale: 'en' as const }));
    api.setLocale = vi.fn(async () => { throw new Error('save failed'); });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const selector = await screen.findByRole('combobox', { name: 'Language' });
    fireEvent.change(selector, { target: { value: 'ja' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to save language setting.');
    expect((selector as HTMLSelectElement).value).toBe('automatic');
    expect(api.restartApplication).not.toHaveBeenCalled();
  });

  it('keeps a successfully saved preference after restart failure and retries the restart', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'automatic' as const, effectiveLocale: 'en' as const }));
    api.setLocale = vi.fn(async (preference) => ({ preference, effectiveLocale: preference === 'automatic' ? 'en' as const : preference }));
    api.restartApplication = vi.fn().mockRejectedValueOnce(new Error('restart failed')).mockResolvedValueOnce(undefined);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const selector = await screen.findByRole('combobox', { name: 'Language' });
    fireEvent.change(selector, { target: { value: 'ja' } });
    expect(await screen.findByRole('alertdialog', { name: 'Restart the application now to apply the saved language?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Language saved. Restart the application to apply it.');
    expect((selector as HTMLSelectElement).value).toBe('ja');
    expect(screen.getByText('Current language: English')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.restartApplication).toHaveBeenCalledTimes(2));
    expect(api.setLocale).toHaveBeenCalledOnce();
  });

  it('blocks the main console with first-run setup when PostgreSQL is not configured', async () => {
    const api = fakeApi();
    api.getLocale = vi.fn(async () => ({ preference: 'ja' as const, effectiveLocale: 'ja' as const }));
    api.getDatabaseSetupStatus = vi.fn(async () => ({ configured: false, attachmentRoot: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\attachments', agentWorkspace: 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\agent-workspace', connection: null }));
    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: 'データベースをインストール' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.setup-shell')?.getAttribute('lang')).toBe('ja'));
    expect(screen.queryByRole('navigation', { name: '主要導覽' })).toBeNull();
  });
  it('without a bootstrap (ZIP install, no installer) auto-provisions, saves the default folders and restarts', async () => {
    const attachmentRoot = 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\attachments';
    const agentWorkspace = 'C:\\Users\\me\\AppData\\Local\\LineAgentAssistant\\data\\agent-workspace';
    const api = fakeApi();
    api.getDatabaseSetupStatus = vi.fn(async () => ({ configured: false, attachmentRoot, agentWorkspace, connection: null }));
    api.startEmbeddedProvision = vi.fn(async () => undefined);
    api.saveEmbeddedSetup = vi.fn(async () => ({ saved: true as const, restartRequired: true as const }));
    api.restartApplication = vi.fn(async () => undefined);
    render(<App api={api} />);
    await waitFor(() => expect(api.restartApplication).toHaveBeenCalledOnce());
    expect(api.startEmbeddedProvision).toHaveBeenCalledOnce();
    expect(api.saveEmbeddedSetup).toHaveBeenCalledWith(attachmentRoot, agentWorkspace);
    expect(screen.queryByRole('navigation', { name: '主要導覽' })).toBeNull();
  });
  it('shows a persistent reauthentication prompt for an invalidated LINE account', async () => {
    render(<LineLogin api={fakeApi()} accounts={[{ ...snapshot.accounts[0]!, status: 'reauth_required' }]}
      headingRef={{ current: null }} />);
    expect(screen.getByText(/LINE 需要重新登入/)).toBeTruthy();
  });
  it('starts a distinct account login and renders only the current attempt QR, PIN, and status', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }] }));
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    await renderLineApp(api);
    await openSystemTab();
    fireEvent.click(screen.getByRole('button', { name: '登入 Primary Admin LINE 帳號' }));
    await waitFor(() => expect(api.lineAddAccountQr).toHaveBeenCalledOnce());
    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-2', state: 'connecting', message: null })));
    expect(document.querySelector('.system-toast')?.textContent).toBe('LINE 登入中');
    expect(document.querySelector('.login-notice')).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-1', imageDataUrl: 'data:image/png;base64,b2xk' })));
    expect(screen.queryByRole('img', { name: 'LINE QR 登入碼' })).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-2', imageDataUrl: 'data:image/png;base64,bmV3' })));
    expect(screen.getByRole('img', { name: 'LINE QR 登入碼' })).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-2', pin: '020824' })));
    expect(screen.queryByRole('img', { name: 'LINE QR 登入碼' })).toBeNull();
    expect(screen.getByRole('heading', { name: '在手機輸入認證碼' })).toBeTruthy();
    expect(screen.getByLabelText('LINE 6 位數認證碼').textContent).toBe('020824');
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('.app-shell button')).find((button) => button.textContent?.includes('登入 Primary Admin LINE 帳號'))?.disabled).toBe(true);
    expect(screen.getByText('LINE 登入中', { selector: '.system-toast' })).toBeTruthy();

    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-2', state: 'connected', message: null })));
    expect(screen.queryByRole('heading', { name: '在手機輸入認證碼' })).toBeNull();
    expect(screen.getByText(/登入成功/)).toBeTruthy();
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('.app-shell button')).find((button) => button.textContent?.includes('登入 Primary Admin LINE 帳號'))?.disabled).toBe(false);

    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-2', state: 'degraded', message: 'Worker command rejected' })));
    expect(screen.getByText(/登入成功/)).toBeTruthy();
    expect(screen.queryByText(/Worker command rejected/)).toBeNull();
    expect(screen.queryByText('020824')).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-2', pin: '999999' })));
    expect(screen.queryByText('999999')).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-3', state: 'connecting', message: null })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-3', imageDataUrl: 'data:image/png;base64,ZmFpbHVyZQ==' })));
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-3', pin: '333333' })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-3', state: 'degraded', message: 'LINE login failed. Try again.' })));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('333333')).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-3', imageDataUrl: 'data:image/png;base64,c3RhbGU=' })));
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-3', pin: '444444' })));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('444444')).toBeNull();

    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-4', state: 'connecting', message: null })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-4', imageDataUrl: 'data:image/png;base64,bG9nb3V0' })));
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-4', pin: '555555' })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: null, state: 'disconnected', message: null })));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('555555')).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-4', imageDataUrl: 'data:image/png;base64,c3RhbGU=' })));
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-4', pin: '666666' })));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('666666')).toBeNull();

    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-new',
      loginAttemptId: 'attempt-5', state: 'connecting', message: null })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineQr', accountId: 'account-new',
      loginAttemptId: 'attempt-5', imageDataUrl: 'data:image/png;base64,YWNjb3VudEE=' })));
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-5', pin: '777777' })));
    act(() => listeners.forEach((listener) => listener({ type: 'lineLoginState', accountId: 'account-B',
      loginAttemptId: null, state: 'reauth_required', message: 'Sign in again.' })));
    expect(screen.getByText('777777')).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'linePin', accountId: 'account-new',
      loginAttemptId: 'attempt-5', pin: '888888' })));
    expect(screen.getByText('888888')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '關閉' }));
    fireEvent.click(screen.getByRole('button', { name: '重新登入 工作' }));
    await waitFor(() => expect(api.lineLoginQr).toHaveBeenCalledWith('account-A'));
  });

  it('refreshes the active timeline from typed message events even when unread does not change', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let calls = 0;
    api.listMessages = vi.fn(async () => ({ messages: ++calls === 1 ? [] : [message('account-A', 'live-message')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'live-message' }, 'live-message'))));
    expect(await screen.findByText('live-message')).toBeTruthy();
  });

  it('refreshes the visible timeline once when the coalesced import completion snapshot arrives', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    api.listMessages = vi.fn(async () => ({ messages: [], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    await waitFor(() => expect(api.listMessages).toHaveBeenCalled());
    vi.mocked(api.listMessages).mockClear();
    const completed = { ...snapshot, accounts: snapshot.accounts.map((account) => account.accountId === 'account-A'
      ? { ...account, externalImportProgress: { stage: 'complete' as const, copiedBytes: '100', totalBytes: '100',
        committedRows: '2', eligibleRows: '2', message: 'Initial history imported.' } } : account),
      conversations: [...snapshot.conversations, { ...snapshot.conversations[0]!, chatId: 'imported-chat', title: 'Imported chat',
        latestMessagePreview: 'History ready', latestMessageAt: '2026-10-18T10:00:00.000Z' }] };
    const completionEvent: IpcEvent = { type: 'snapshotChanged', snapshot: completed };
    act(() => listeners.forEach((listener) => listener(completionEvent)));
    expect(await screen.findByRole('button', { name: 'Imported chat 群組' })).toBeTruthy();
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(1));
    act(() => listeners.forEach((listener) => listener(completionEvent)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it('uses snapshot summaries without issuing per-room preview reads for 500 rooms', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => snapshotWithRooms(500));
    await renderLineApp(api);
    // The list is sorted by latest message time and virtualized above 100 rooms, so the old chat-0 row is not mounted;
    // the newest-timestamp group (10:59) tie-breaks by chatId.localeCompare, so chat-119 is its first row; chat-0 comes from App's default selection (viewedConversations[0]).
    const rows = await screen.findAllByRole('button', { name: /^聊天室 \d+ 群組$/ });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(500);
    expect(screen.queryByRole('button', { name: '聊天室 0 群組' })).toBeNull();
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledWith(
      { accountId: 'account-A', chatType: 'group', chatId: 'chat-0' }, null, 75));
    expect(vi.mocked(api.listMessages).mock.calls.filter((call) => call[2] === 1)).toHaveLength(0);
  });

  it('performs at most one timeline read and no snapshot read when the selected room receives a message', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    const largeSnapshot = snapshotWithRooms(50);
    api.getSnapshot = vi.fn(async () => largeSnapshot);
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    await renderLineApp(api);
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledWith(
      { accountId: 'account-A', chatType: 'group', chatId: 'chat-0' }, null, 75));
    vi.mocked(api.listMessages).mockClear();
    vi.mocked(api.getSnapshot).mockClear();

    const changed = { ...largeSnapshot.conversations[0]!, latestMessagePreview: 'live-selected', unreadCount: 1 };
    act(() => listeners.forEach((listener) => listener(storedEvent(changed, 'live-selected'))));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listMessages).toHaveBeenCalledWith({ accountId: 'account-A', chatType: 'group', chatId: 'chat-0' }, null, 75);
    expect(api.getSnapshot).not.toHaveBeenCalled();
  });

  it('upserts a non-selected room summary without reading messages or refreshing the snapshot', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    const largeSnapshot = snapshotWithRooms(50);
    api.getSnapshot = vi.fn(async () => largeSnapshot);
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    await renderLineApp(api);
    await screen.findByRole('button', { name: '聊天室 49 群組' });
    vi.mocked(api.listMessages).mockClear();
    vi.mocked(api.getSnapshot).mockClear();

    const changed = { ...largeSnapshot.conversations[49]!, latestMessagePreview: '剛收到的新訊息', unreadCount: 1 };
    act(() => listeners.forEach((listener) => listener(storedEvent(changed, 'live-preview'))));

    await waitFor(() => expect(screen.getByRole('button', { name: '聊天室 49 群組' }).querySelector('.list-preview')?.getAttribute('data-preview')).toBe('剛收到的新訊息'));
    expect(api.listMessages).not.toHaveBeenCalled();
    expect(api.getSnapshot).not.toHaveBeenCalled();
  });

  it('orders the timeline from oldest to newest and follows the initial page to the bottom', async () => {
    const api = fakeApi();
    const page = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    api.listMessages = vi.fn(() => page.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 860, configurable: true });
    await act(async () => {
      page.resolve({ messages: [
        { ...message('account-A', 'newer'), occurredAt: '2026-10-16T05:40:00.000Z' },
        { ...message('account-A', 'older'), occurredAt: '2026-10-16T05:38:00.000Z' },
      ], olderCursor: null });
      await page.promise;
    });
    const older = await screen.findByText('older');
    const newer = screen.getByText('newer');
    expect(older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeline.scrollTop).toBe(860);
  });

  it('shows attachment details in user language without internal IDs, MIME types, or raw status', async () => {
    const api = fakeApi();
    api.openAttachment = vi.fn(async () => true);
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'attachment-message'), attachments: [{ id: 'attachment-secret', kind: 'file' as const, name: '估價單.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'ready' }] }], olderCursor: null }));
    await renderLineApp(api);
    expect(await screen.findByText('估價單.pdf')).toBeTruthy();
    const attachment = screen.getByText('估價單.pdf').closest('.file-attachment-card')!;
    expect(attachment.textContent).not.toContain('2 KB');
    const row = attachment.closest('.message-row')!;
    const open = within(row as HTMLElement).getByRole('button', { name: '開啟' });
    expect(attachment.contains(open)).toBe(false);
    fireEvent.click(open);
    expect(api.openAttachment).toHaveBeenCalledWith('attachment-secret');
    expect(open.compareDocumentPosition(within(row as HTMLElement).getByRole('button', { name: '回覆' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attachment.textContent).toContain('可開啟');
    expect(attachment.textContent).not.toContain('下載期限');
    expect(attachment.textContent).not.toContain('attachment-secret');
    expect(attachment.textContent).not.toContain('application/pdf');
    expect(attachment.textContent).not.toContain('ready');
    await waitFor(() => expect(api.resolveFileTypeIcon).toHaveBeenCalledWith('pdf'));
  });

  it('renders Agent lifecycle status (neutral glyph, stored custom icon ignored) below and outside the source message bubble', async () => {
    const api = fakeApi();
    api.getConversationSettings = vi.fn(async () => ({
      attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true,
      agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS, running: '★' },
      agentStatusRotationIntervalSeconds: 10,
    }));
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'agent-source'), agentJobId: 'job-source', agentJobStatus: 'running' as const }], olderCursor: null }));
    await renderLineApp(api);
    await waitFor(() => expect(document.querySelector('.agent-status-marker.running .agent-status-glyph')?.textContent).toBe(LINE_REACTION_GLYPHS.NICE));
    const marker = document.querySelector('.agent-status-marker.running')!;
    expect(marker.querySelector('[aria-hidden="true"]')?.textContent).toBe(LINE_REACTION_GLYPHS.NICE);
    expect(marker.getAttribute('aria-label')).toBe('Agent 執行中');
    expect(marker.getAttribute('title')).toBe('Agent 執行中');
    expect(marker.textContent).toBe(LINE_REACTION_GLYPHS.NICE);
    const row = marker.closest('.message-row')!;
    const bubble = row.querySelector('.message')!;
    expect(bubble.contains(marker)).toBe(false);
    expect(row.contains(marker)).toBe(true);
    expect(bubble.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows neutral reaction glyphs for running, completed and failed chat markers', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'agent-r'), agentJobId: 'job-r', agentJobStatus: 'running' as const },
      { ...message('account-A', 'agent-c'), agentJobId: 'job-c', agentJobStatus: 'completed' as const },
      { ...message('account-A', 'agent-f'), agentJobId: 'job-f', agentJobStatus: 'failed' as const },
    ], olderCursor: null }));
    await renderLineApp(api);
    await waitFor(() => expect(document.querySelectorAll('.agent-status-marker[role="status"]').length).toBe(3));
    for (const [status, reaction] of [['running', 'NICE'], ['completed', 'LOVE'], ['failed', 'SAD']] as const) {
      const marker = document.querySelector('.agent-status-marker.' + status)!;
      expect(marker.querySelector('.agent-status-glyph')?.textContent).toBe(LINE_REACTION_GLYPHS[reaction]);
    }
  });

  it('always renders the Agent marker even when the stored toggle is false', async () => {
    const api = fakeApi();
    api.getConversationSettings = vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: false, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS }, agentStatusRotationIntervalSeconds: 10 }));
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'agent-hidden'), agentJobId: 'job-hidden', agentJobStatus: 'running' as const }], olderCursor: null }));
    await renderLineApp(api);
    await waitFor(() => expect(document.querySelector('.agent-status-marker.running[role="status"]')).toBeTruthy());
  });

  it('keeps a committed terminal Agent event over an older in-flight page response', async () => {
    const api = fakeApi();
    api.listAgentStatuses = vi.fn(async () => [{ messageId: 'agent-race', jobId: 'job-race', status: 'completed' as const, revision: '100' }]);
    const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const page = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    api.listMessages = vi.fn(() => page.promise);
    await renderLineApp(api);
    await waitFor(() => expect(api.listMessages).toHaveBeenCalled());
    expect(listeners.length).toBeGreaterThan(0);
    act(() => listeners.forEach((listener) => listener({ type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', sourceMessageId: 'agent-race', jobId: 'job-race', status: 'completed', revision: '100' })));
    await act(async () => {
      page.resolve({ messages: [{ ...message('account-A', 'agent-race'), agentJobId: 'job-race', agentJobStatus: 'running' }], olderCursor: null });
      await page.promise;
    });
    await waitFor(() => expect(document.querySelector('.agent-status-marker.completed')).toBeTruthy());
    act(() => listeners.forEach((listener) => listener({ type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', sourceMessageId: 'agent-race', jobId: 'job-race', status: 'running', revision: '99' })));
    expect(document.querySelector('.agent-status-marker.completed')).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', sourceMessageId: 'agent-race', jobId: 'job-race', status: 'failed', revision: '101' })));
    expect(document.querySelector('.agent-status-marker.failed')).toBeTruthy();
    expect(screen.getByText('agent-race')).toBeTruthy();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    act(() => listeners.forEach((listener) => listener({ type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', sourceMessageId: 'agent-race', jobId: 'job-race', status: 'queued', revision: '102' })));
    expect(document.querySelector('.agent-status-marker.queued')).toBeTruthy();
  });

  it('coalesces lifecycle overflow into a bounded status read without replacing the message window', async () => {
    const api = fakeApi();
    const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const pageMessages = Array.from({ length: 150 }, (_, index) => message('account-A', `visible-${index}`));
    api.listMessages = vi.fn().mockResolvedValue({ messages: pageMessages, olderCursor: 'older' });
    await renderLineApp(api);
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(1));
    act(() => {
      for (let index = 0; index < 226; index += 1) listeners.forEach((listener) => listener({
        type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat',
        sourceMessageId: `overflow-${index}`, jobId: `overflow-job-${index}`, status: 'running', revision: `${index + 100}`,
      }));
    });
    await waitFor(() => expect(api.listAgentStatuses).toHaveBeenCalledTimes(1));
    const queriedIds = vi.mocked(api.listAgentStatuses).mock.calls[0]?.[1] ?? [];
    expect(queriedIds).toHaveLength(150);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('fresh-after-overflow')).toBeNull();
    expect(screen.getByText('visible-0')).toBeTruthy();
    expect(screen.getByText('visible-149')).toBeTruthy();
  });

  it('keeps one physical status lookup across A to B to A navigation and runs only the latest pending target', async () => {
    const api = fakeApi();
    const firstLookup = deferred<Awaited<ReturnType<DesktopApi['listAgentStatuses']>>>();
    let active = 0;
    let maximumActive = 0;
    api.listMessages = vi.fn(async (key) => ({ messages: [message(key.accountId, `${key.accountId}-visible`)], olderCursor: null }));
    api.listAgentStatuses = vi.fn(async (key, ids) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (vi.mocked(api.listAgentStatuses).mock.calls.length === 1) return await firstLookup.promise;
        return ids.map((messageId: string) => ({ messageId, jobId: `${key.accountId}-job`, status: 'running' as const, revision: '10' }));
      } finally { active -= 1; }
    });
    await renderLineApp(api);
    await screen.findByText('account-A-visible');
    await waitFor(() => expect(api.listAgentStatuses).toHaveBeenCalledTimes(1));

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-account-id="account-B"]')!);
    await screen.findByText('account-B-visible');
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-account-id="account-A"]')!);
    await screen.findByText('account-A-visible');
    expect(api.listAgentStatuses).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    await act(async () => {
      firstLookup.resolve([]);
      await firstLookup.promise;
    });
    await waitFor(() => expect(api.listAgentStatuses).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.listAgentStatuses).mock.calls[1]?.[0].accountId).toBe('account-A');
    await waitFor(() => expect(active).toBe(0));
    expect(maximumActive).toBe(1);
  });

  it('shows Download only for terminal attachment failures and sends the selected conversation scope', async () => {
    const api = fakeApi();
    const attachmentId = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'terminal-attachment'), attachments: [
      { id: attachmentId, kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'failed', canRetryManually: true },
      { id: 'attachment-queued', kind: 'image' as const, name: 'photo.png', mimeType: 'image/png', sizeBytes: 0, status: 'queued' },
      { id: 'attachment-image-failed', kind: 'image' as const, name: 'failed-photo.png', mimeType: 'image/png', sizeBytes: 0, status: 'failed', canRetryManually: true },
      { id: 'attachment-downloading', kind: 'file' as const, name: 'video.mp4', mimeType: 'video/mp4', sizeBytes: 0, status: 'downloading' },
      { id: 'attachment-expired', kind: 'image' as const, name: 'expired.png', mimeType: 'image/png', sizeBytes: 0, status: 'expired', canRetryManually: true },
    ] }], olderCursor: null }));
    await renderLineApp(api);
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    const terminal = screen.getByText('report.pdf').closest('.file-attachment-card')!;
    const button = within(terminal as HTMLElement).getByRole('button', { name: '下載' });
    fireEvent.click(button);
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith(
      { accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, attachmentId));
    const imageCards = screen.getAllByText('圖片').map((label) => label.closest('.file-attachment-card')!);
    const queued = imageCards.find((card) => card.querySelector('strong')?.getAttribute('title') === 'photo.png')!;
    expect(queued.querySelector('strong')?.getAttribute('title')).toBe('photo.png');
    expect(queued.textContent).not.toContain('photo.png');
    expect(queued.textContent).toContain('尚未下載');
    expect(queued.textContent).not.toContain('等待下載');
    expect(within(queued as HTMLElement).queryByRole('button', { name: '下載' })).toBeNull();
    expect(within(screen.getByText('video.mp4').closest('.file-attachment-card')!).queryByRole('button', { name: '下載' })).toBeNull();
    const expired = imageCards.find((card) => card.querySelector('strong')?.getAttribute('title') === 'expired.png')!;
    expect(within(expired as HTMLElement).getByRole('button', { name: '下載' })).toBeTruthy();
    expect(expired.textContent).toContain('下載重試期限已過');
    const failedImage = imageCards.find((card) => card.querySelector('strong')?.getAttribute('title') === 'failed-photo.png')!;
    fireEvent.click(within(failedImage as HTMLElement).getByRole('button', { name: '下載' }));
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith(
      { accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, 'attachment-image-failed'));
  });

  it('shows the login hint without a Download button for a disconnected account', async () => {
    const api = fakeApi();
    const getSnapshot = api.getSnapshot;
    api.getSnapshot = vi.fn(async () => {
      const state = await getSnapshot();
      return { ...state, accounts: state.accounts.map((account) => account.accountId === 'account-A'
        ? { ...account, status: 'disconnected' as const } : account) };
    });
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'offline-attachment'), attachments: [
      { id: 'offline-file', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'failed', canRetryManually: true },
    ] }], olderCursor: null }));
    await renderLineApp(api);
    const card = (await screen.findByText('report.pdf')).closest('.file-attachment-card')!;
    expect(card.textContent).toContain('下載失敗');
    expect(card.textContent).not.toContain('登入 LINE 後可下載');
    expect(card.textContent).not.toContain('12 B');
    expect(within(card as HTMLElement).queryByRole('button', { name: '下載' })).toBeNull();
  });

  it('refreshes the selected conversation after a failed manual attachment attempt', async () => {
    const api = fakeApi();
    const attachmentId = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'manual-failure'), attachments: [
      { id: attachmentId, kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'failed', canRetryManually: true },
    ] }], olderCursor: null }));
    api.downloadAttachment = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'DOWNLOAD_FAILED', message: 'attempt failed', retryable: false } as const));
    await renderLineApp(api);
    expect(await screen.findByText('report.pdf')).toBeTruthy();

    fireEvent.click(within(screen.getByText('report.pdf').closest('.file-attachment-card') as HTMLElement)
      .getByRole('button', { name: /下載/ }));

    await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
    expect(within(screen.getByText('report.pdf').closest('.file-attachment-card') as HTMLElement)
      .getByRole('button', { name: /下載/ })).toBeTruthy();
  });

  it('refreshes visible attachment state after attachmentChanged', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const attachment = { id: 'attachment-live', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'downloading' as const };
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'live-attachment'), attachments: [
      attachment,
    ] }], olderCursor: null }));
    // Page load reconciles non-terminal visible attachments (c8f62d1): that read still reports downloading,
    // and only the later attachmentChanged-driven read reports ready.
    let serviceStatus = 'downloading';
    api.listAttachmentStates = vi.fn(async () => [{ attachmentId: 'attachment-live', messageId: 'live-attachment', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: serviceStatus, canRetryManually: false }]);
    await renderLineApp(api);
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/下載中/)).toBeTruthy();

    serviceStatus = 'ready';
    act(() => listeners.forEach((listener) => listener({ type: 'attachmentChanged', attachmentId: 'attachment-live' })));

    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/可開啟/)).toBeTruthy();
  });

  it('ignores an attachment refresh response after switching chats', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const refresh = deferred<Awaited<ReturnType<DesktopApi['listAttachmentStates']>>>();
    api.listMessages = vi.fn(async (key) => {
      if (key.accountId === 'account-B') return { messages: [message('account-B', 'B-current')], olderCursor: null };
      return { messages: [{ ...message('account-A', 'A-current'), attachments: [
        { id: 'attachment-live', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'downloading' as const },
      ] }], olderCursor: null };
    });
    api.listAttachmentStates = vi.fn(() => refresh.promise);
    await renderLineApp(api);
    await screen.findByText('report.pdf');
    act(() => listeners.forEach((listener) => listener({ type: 'attachmentChanged', attachmentId: 'attachment-live' })));
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(1));

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-account-id="account-B"]')!);
    await screen.findByText('B-current');
    await act(async () => {
      refresh.resolve([{ attachmentId: 'attachment-live', messageId: 'A-current', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'ready', canRetryManually: false }]);
      await refresh.promise;
    });

    expect(screen.getByText('B-current')).toBeTruthy();
    expect(screen.queryByText(/可開啟/)).toBeNull();
  });

  it('coalesces distinct visible attachment events without losing either update', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'image-message'), attachments: [{ id: 'attachment-image', kind: 'file' as const, name: 'photo.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: 'downloading' as const }] },
      { ...message('account-A', 'pdf-message'), attachments: [{ id: 'attachment-pdf', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: 'downloading' as const }] },
    ], olderCursor: null }));
    // The page-load reconcile (c8f62d1) reads first and still reports downloading; the events then flip the states.
    let imageStatus = 'downloading'; let pdfStatus = 'downloading';
    api.listAttachmentStates = vi.fn(async () => [
      { attachmentId: 'attachment-image', messageId: 'image-message', kind: 'file' as const, name: 'photo.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: imageStatus, canRetryManually: false },
      { attachmentId: 'attachment-pdf', messageId: 'pdf-message', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12, status: pdfStatus, canRetryManually: false },
    ]);
    await renderLineApp(api);
    await screen.findByText('photo.pdf');
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(1));
    imageStatus = 'ready'; pdfStatus = 'queued';
    const initialCards = new Map(['photo.pdf', 'report.pdf'].map((name) => {
      const card = screen.getByText(name).closest('.file-attachment-card') as HTMLElement;
      return [name, card.querySelectorAll('small')[0]?.textContent ?? ''] as const;
    }));
    act(() => listeners.forEach((listener) => {
      listener({ type: 'attachmentChanged', attachmentId: 'attachment-image' });
      listener({ type: 'attachmentChanged', attachmentId: 'attachment-pdf' });
    }));

    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(2));
    for (const name of ['photo.pdf', 'report.pdf']) {
      const card = screen.getByText(name).closest('.file-attachment-card') as HTMLElement;
      await waitFor(() => expect(card.querySelectorAll('small')[0]?.textContent).not.toBe(initialCards.get(name)));
    }
  });

  it('refreshes the exact attachment on a loaded older message beyond the first 75', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const newest = Array.from({ length: 75 }, (_, index) => message('account-A', `newer-${index}`));
    const oldMessage = { ...message('account-A', 'older-with-file'), attachments: [
      { id: 'attachment-older', kind: 'file' as const, name: 'older.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'downloading' },
    ] };
    api.listMessages = vi.fn(async (_key, cursor) => cursor === null
      ? { messages: newest, olderCursor: 'older-cursor' }
      : { messages: [oldMessage], olderCursor: null });
    // Loading the older page reconciles its visible attachment (c8f62d1) and still reports downloading; the event read reports ready.
    let olderStatus = 'downloading';
    api.listAttachmentStates = vi.fn(async (_key, ids) => ids.includes('attachment-older')
      ? [{ attachmentId: 'attachment-older', messageId: 'older-with-file', kind: 'file' as const, name: 'older.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: olderStatus, canRetryManually: false }]
      : []);
    await renderLineApp(api);
    await screen.findByText("newer-74"); scrollTimelineToTop();
    await screen.findByText('older.pdf');
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledWith(
      { accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, ['attachment-older']));
    const card = screen.getByText('older.pdf').closest('.file-attachment-card') as HTMLElement;
    const initialStatus = card.querySelectorAll('small')[0]?.textContent;
    const readsBeforeEvent = vi.mocked(api.listAttachmentStates).mock.calls.filter(([, ids]) => ids.includes('attachment-older')).length;
    olderStatus = 'ready';
    act(() => listeners.forEach((listener) => listener({ type: 'attachmentChanged', attachmentId: 'attachment-older' })));
    await waitFor(() => expect(vi.mocked(api.listAttachmentStates).mock.calls.filter(([, ids]) => ids.includes('attachment-older')))
      .toHaveLength(readsBeforeEvent + 1));
    await waitFor(() => expect(card.querySelectorAll('small')[0]?.textContent).not.toBe(initialStatus));
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps a visible attachment update when an unrelated attachment event follows', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'visible-attachment'), attachments: [
      { id: 'attachment-visible', kind: 'file' as const, name: 'visible.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: 'downloading' as const },
    ] }], olderCursor: null }));
    // Page load reconciles first (c8f62d1) and still reports downloading; the event read reports ready.
    let visibleStatus = 'downloading';
    api.listAttachmentStates = vi.fn(async () => [{ attachmentId: 'attachment-visible', messageId: 'visible-attachment', kind: 'file' as const, name: 'visible.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: visibleStatus, canRetryManually: false }]);
    await renderLineApp(api);
    await screen.findByText('visible.pdf');
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(1));
    const card = screen.getByText('visible.pdf').closest('.file-attachment-card') as HTMLElement;
    const initialStatus = card.querySelectorAll('small')[0]?.textContent;
    visibleStatus = 'ready';
    act(() => listeners.forEach((listener) => {
      listener({ type: 'attachmentChanged', attachmentId: 'attachment-visible' });
      listener({ type: 'attachmentChanged', attachmentId: 'unrelated-attachment' });
    }));

    await waitFor(() => expect(card.querySelectorAll('small')[0]?.textContent).not.toBe(initialStatus));
    // One load reconcile plus exactly one event read; the unrelated attachment id never triggers its own read.
    expect(api.listAttachmentStates).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.listAttachmentStates).mock.calls.every(([, ids]) => ids.length === 1 && ids[0] === 'attachment-visible')).toBe(true);
  });

  it('serializes a burst and discards a same-route response superseded by a newer event', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    const stale = deferred<Awaited<ReturnType<DesktopApi['listAttachmentStates']>>>();
    let reads = 0; let active = 0; let maxActive = 0;
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'changing-attachment'), attachments: [
      { id: 'attachment-changing', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: 'downloading' as const },
    ] }], olderCursor: null }));
    api.listAttachmentStates = vi.fn(async () => {
      const read = ++reads; active += 1; maxActive = Math.max(maxActive, active);
      const state = (status: string) => [{ attachmentId: 'attachment-changing', messageId: 'changing-attachment', kind: 'file' as const, name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 8, status, canRetryManually: false }];
      // read 1 = page-load reconcile (c8f62d1, unchanged); read 2 = first event read (held open, becomes stale); read 3 = newer event read.
      try { return read === 1 ? state('downloading') : read === 2 ? await stale.promise : state('ready'); }
      finally { active -= 1; }
    });
    await renderLineApp(api);
    await screen.findByText('report.pdf');
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(1));
    const card = screen.getByText('report.pdf').closest('.file-attachment-card') as HTMLElement;
    const initialStatus = card.querySelectorAll('small')[0]?.textContent;
    expect(initialStatus).toContain('下載中');
    act(() => listeners.forEach((listener) => listener({ type: 'attachmentChanged', attachmentId: 'attachment-changing' })));
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(2));
    act(() => listeners.forEach((listener) => {
      for (let index = 0; index < 12; index += 1) listener({ type: 'attachmentChanged', attachmentId: 'attachment-changing' });
    }));
    // The stale response says failed; it was superseded by the burst, so it must be discarded and the newer ready read must win.
    stale.resolve([{ attachmentId: 'attachment-changing', messageId: 'changing-attachment', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 8, status: 'failed', canRetryManually: false }]);
    await act(async () => { await stale.promise; });

    await waitFor(() => expect(card.querySelectorAll('small')[0]?.textContent).toContain('可開啟'));
    await waitFor(() => expect(api.listAttachmentStates).toHaveBeenCalledTimes(3));
    expect(card.textContent).not.toContain('下載失敗');
    expect(maxActive).toBe(1);
  });

  it('does not lose the selected conversation refresh when another conversation event arrives in the same debounce window', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let readsA = 0;
    api.listMessages = vi.fn(async (key) => key.accountId === 'account-A'
      ? { messages: ++readsA === 1 ? [] : [message('account-A', 'A-live')], olderCursor: null }
      : { messages: [message('account-B', 'B-live')], olderCursor: null });
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    act(() => {
      for (const listener of listeners) {
        listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'A-live' }, 'A-live'));
        listener(storedEvent({ ...snapshot.conversations[1]!, latestMessagePreview: 'B-live' }, 'B-live'));
      }
    });
    expect(await screen.findByText('A-live')).toBeTruthy();
  });

  it('keeps a historical window stable on a live event and offers an explicit latest-message action', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.id === 'timeline') return { top: 100, bottom: 400, left: 0, right: 500, width: 500, height: 300, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      if (this instanceof HTMLElement && this.dataset.messageDate) return { top: 200, bottom: 250, left: 0, right: 300, width: 300, height: 50, x: 0, y: 200, toJSON: () => ({}) } as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const range = (prefix: string) => Array.from({ length: 75 }, (_, index) => message('account-A', `${prefix}-${index}`));
    api.listMessages = vi.fn(async (_key, cursor) => cursor === null
      ? { messages: range('latest'), olderCursor: 'older' }
      : { messages: range('history'), olderCursor: null });
    await renderLineApp(api);
    await screen.findByText('latest-74');
    scrollTimelineToTop();
    await screen.findByText('history-0');
    const readsBefore = vi.mocked(api.listMessages).mock.calls.length;
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'new-live' }, 'new-live'))));
    expect(await screen.findByRole('button', { name: /1 則新訊息/ })).toBeTruthy();
    expect(screen.getByText('history-0')).toBeTruthy();
    expect(document.querySelector('.timeline-frame > .latest-button')).toBeTruthy();
    const frame = document.querySelector('.timeline-frame');
    const timeline = document.querySelector('.timeline');
    await waitFor(() => expect(document.querySelector('.visible-message-date')).toBeTruthy());
    const dateChip = document.querySelector('.visible-message-date');
    const overlay = document.querySelector('.latest-button');
    expect(frame).toBeTruthy();
    expect(dateChip).toBeTruthy();
    expect(overlay).toBeTruthy();
    expect(frame?.contains(dateChip)).toBe(true);
    expect(frame?.contains(overlay)).toBe(true);
    expect(timeline?.contains(dateChip)).toBe(false);
    expect(timeline?.contains(overlay)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(vi.mocked(api.listMessages).mock.calls.length).toBe(readsBefore);
  });

  it('preserves a manually scrolled latest page and signals an outbound event even with zero unread growth', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let reads = 0;
    api.listMessages = vi.fn(async () => ({ messages: ++reads === 1 ? [message('account-A', 'old')]
      : [{ ...message('account-A', 'outbound-live'), direction: 'outbound' as const }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('old');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 200, configurable: true });
    timeline.scrollTop = 200;
    fireEvent.scroll(timeline);
    const readsBefore = reads;
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'outbound-live' }, 'outbound-live'))));
    expect(await screen.findByRole('button', { name: /1 則新訊息/ })).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(timeline.scrollTop).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reads).toBe(readsBefore);
    fireEvent.click(screen.getByRole('button', { name: /1 則新訊息/ }));
    expect(await screen.findByText('outbound-live')).toBeTruthy();
  });

  it('refreshes and follows a latest page when its real scroll position is near the bottom', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let reads = 0;
    api.listMessages = vi.fn(async () => ({ messages: ++reads === 1 ? [message('account-A', 'near-old')]
      : [message('account-A', 'near-live')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('near-old');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 200, configurable: true });
    timeline.scrollTop = 790;
    fireEvent.scroll(timeline);
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'near-live' }, 'near-live'))));
    expect(await screen.findByText('near-live')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /則新訊息/ })).toBeNull();
    expect(timeline.scrollTop).toBe(1000);
  });

  it('renders streamed and completed Agent output inside Agent 室 without sending LINE', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, defaultProvider: 'codex' as const }));
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    await renderAssistantApp(api);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent 訊息' }), { target: { value: 'analyze' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await screen.findByText('analyze');
    await waitFor(() => expect(api.getAgentRoomJobEvents).toHaveBeenCalledWith('job-1'));
    act(() => listeners.forEach((listener) => listener({ type: 'agentEvent', jobId: 'job-1', event: { type: 'text_delta', text: 'streaming' } })));
    expect(await screen.findByText('streaming')).toBeTruthy();
    act(() => listeners.forEach((listener) => listener({ type: 'agentEvent', jobId: 'job-1', event: { type: 'completed', finalText: 'final answer' } })));
    expect(await screen.findByText('final answer')).toBeTruthy();
    expect(api.sendText).not.toHaveBeenCalled();
  });

  it('shows the same Agent 室 and history under every account in the rail', async () => {
    const api = fakeApi();
    const job = { jobId: 'shared-job', accountId: null, chatType: null, chatId: null, provider: 'codex' as const, prompt: '共用的工作',
      status: 'completed' as const, createdAt: '2026-10-20T00:00:00.000Z' };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, jobs: [job] }));
    await renderAssistantApp(api);
    expect(await screen.findByText('共用的工作')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '還沒送出的草稿' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
    for (const label of ['查看觀察', '查看同名群組所屬帳號']) {
      const rail = screen.queryByRole('button', { name: label });
      if (!rail) continue;
      fireEvent.click(rail);
      // Switching accounts on 助理 stays on 助理: same history, draft and provider; no chat list appears.
      expect(screen.getByRole('button', { name: '助理' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByText('共用的工作')).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).value).toBe('還沒送出的草稿');
      expect((screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement).value).toBe('claude');
      expect(document.getElementById('conversation-list')).toBeNull();
    }
    expect(screen.getByRole('button', { name: '查看觀察' })).toBeTruthy();
    await waitFor(() => expect(api.getAgentRoomJobEvents).toHaveBeenCalledWith('shared-job'));
  });

  it('keeps Agent 室 out of the chat list and lists only LINE chats under 聊天', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    expect(Array.from(document.querySelectorAll('.conversation-row')).some((row) => row.textContent?.includes('Agent 室'))).toBe(false);
  });

  it('starts on Settings with no LINE account but leaves navigation free afterwards', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: [], conversations: [], jobs: [] }));
    render(<App api={api} />);
    expect((await screen.findByRole('tab', { name: '系統' })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '助理' }));
    expect(await screen.findByRole('textbox', { name: 'Agent 訊息' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '助理' }).getAttribute('aria-current')).toBe('page');
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '沒有帳號也能問' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: '沒有帳號也能問' })));
    expect(screen.queryByRole('heading', { name: '設定' })).toBeNull();
  });

  it('preserves live Agent output when an older history request resolves later', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    const history = deferred<Awaited<ReturnType<DesktopApi['getAgentRoomJobEvents']>>>();
    const job = { jobId: 'history-job', accountId: null, chatType: null, chatId: null, provider: 'codex' as const, prompt: '歷史工作', status: 'running' as const, createdAt: '2026-10-16T05:00:00.000Z' };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, jobs: [job] }));
    api.getAgentRoomJobEvents = vi.fn(() => history.promise);
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    await renderAssistantApp(api);
    await screen.findByText('歷史工作');
    await waitFor(() => expect(api.getAgentRoomJobEvents).toHaveBeenCalledOnce());
    act(() => listeners.forEach((listener) => listener({ type: 'agentEvent', jobId: 'history-job', event: { type: 'text_delta', text: '即時內容' } })));
    expect(await screen.findByText('即時內容')).toBeTruthy();
    await act(async () => history.resolve([{ type: 'started', externalSessionId: 'session-1' }]));
    expect(await screen.findByText('即時內容')).toBeTruthy();
  });

  it('maps Agent submission failures to friendly text without exposing backend codes', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, defaultProvider: 'codex' as const }));
    api.submitAgentRoomPrompt = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'AGENT_DISABLED', message: 'raw backend secret', retryable: false } as const));
    await renderAssistantApp(api);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '測試' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Agent 無法接受這次工作，請稍後再試。');
    expect(document.body.textContent).not.toContain('AGENT_DISABLED');
    expect(document.body.textContent).not.toContain('raw backend secret');
  });

  it('shows Agent submit errors in the composer slot, not the top banner, and clears them on the next success', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, defaultProvider: 'codex' as const }));
    api.submitAgentRoomPrompt = vi.fn()
      .mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'x', retryable: false })
      .mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'x', retryable: false })
      .mockResolvedValueOnce({ type: 'submitAgentRoomPrompt', requestId: 'y', ok: true, jobId: 'job-ok' });
    await renderAssistantApp(api);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '測試' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    expect(screen.getByTestId('composer-status').textContent).toBe('');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('外部監控模式不能建立 Agent 工作。');
    expect(alert.closest('.error-banner')).toBeNull();
    expect(screen.getByTestId('composer-status').contains(alert)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '清除訊息' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('composer-status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    expect((await screen.findByRole('alert')).textContent).toContain('外部監控模式');
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByTestId('composer-status').textContent).toContain('已傳送給 Codex。');
  });

  it('scrolls the LINE timeline to the newest content when the reader sends from a scrolled-up position', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const list = document.getElementById('timeline') as HTMLElement;
    let top = 100;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    fireEvent.scroll(list);
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.sendText).toHaveBeenCalled());
    expect(top).toBe(1000);
  });

  it('shows a LINE send failure in the composer slot, not the top banner, and clears it on the next submit', async () => {
    const api = fakeApi();
    api.sendText = vi.fn().mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false })
      .mockResolvedValueOnce({ type: 'accepted', requestId: 'y', ok: true });
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    expect(screen.getByTestId('composer-status').textContent).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const slotAlert = await waitFor(() => {
      const found = within(screen.getByTestId('composer-status')).getByRole('alert');
      return found;
    });
    expect(slotAlert.textContent).toContain('訊息未送出');
    expect(slotAlert.closest('.error-banner')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello again' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.sendText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByTestId('composer-status')).queryByRole('alert')).toBeNull());
    expect(screen.getByTestId('composer-status')).toBeTruthy();
  });

  it('shows a placeholder when a reply target is not in the timeline page', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'child-secret-id'), replyToMessageId: 'parent-secret-id', text: '回覆內容' }], olderCursor: null }));
    await renderLineApp(api);
    const reference = await screen.findByRole('button', { name: '回覆的訊息' });
    expect(reference.textContent).not.toContain('parent-secret-id');
    fireEvent.click(screen.getByRole('button', { name: '回覆' }));
    expect(document.querySelector('.reply-preview')?.textContent).not.toContain('child-secret-id');
    expect(document.body.textContent).not.toContain('parent-secret-id');
  });

  it('renders reply quote identity and preview and scrolls to its loaded target', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot,
      conversations: [{ ...snapshot.conversations[0]!, chatType: 'direct' as const }],
    }));
    const scrollIntoView = vi.fn();
    api.listMessages = vi.fn(async () => ({ messages: [
      { ...message('account-A', 'quoted-target'), chatType: 'direct' as const, text: 'original text' },
      { ...message('account-A', 'quoted-reply'), chatType: 'direct' as const, replyToMessageId: 'quoted-target',
        replyTo: { messageId: 'quoted-target', senderId: 'sender', senderName: 'Quoted Sender', direction: 'inbound' as const,
          senderAvatarAvailable: false, preview: 'original text' }, text: 'reply body' },
    ], olderCursor: null }));
    await renderLineApp(api);
    const reference = await screen.findByRole('button', { name: '回覆 Quoted Sender：original text' });
    expect(reference.querySelector('.reply-reference-avatar')).toBeNull();
    expect(reference.textContent).toContain('Quoted Sender');
    expect(reference.textContent).toContain('original text');
    expect(reference.className).toContain('reply-reference');
    expect(reference.closest('article.message')?.querySelector('.message-text')?.textContent).toBe('reply body');
    document.getElementById('message-quoted-target')!.scrollIntoView = scrollIntoView;
    fireEvent.click(reference);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('requests conversation, member, and account avatars for inbound direct, group, and outbound quotes', async () => {
    const cases = [
      { chatType: 'direct' as const, direction: 'inbound' as const,
        target: undefined },
      { chatType: 'group' as const, direction: 'inbound' as const,
        target: { type: 'member', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', memberId: 'sender' } },
      { chatType: 'group' as const, direction: 'outbound' as const,
        target: { type: 'account', accountId: 'account-A' } },
    ];
    for (const [index, item] of cases.entries()) {
      cleanup();
      const api = fakeApi();
      api.getSnapshot = vi.fn(async () => ({ ...snapshot,
        conversations: [{ ...snapshot.conversations[0]!, chatType: item.chatType, avatarAvailable: true }] }));
      api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', `reply-${index}`), chatType: item.chatType,
        replyToMessageId: 'quoted-target', replyTo: { messageId: 'quoted-target', senderId: 'sender', senderName: 'Quoted',
          direction: item.direction, senderAvatarAvailable: true, preview: 'quoted' } }], olderCursor: null }));
      await renderLineApp(api);
    }
  });

  it('shows a compact LINE-style reply preview and clears it from the close control', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'reply-source'), senderName: '徐佳誠', text: '這是要回覆的原始內容' }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('這是要回覆的原始內容');

    const replyButton = screen.getByRole('button', { name: '回覆' });
    const bubble = screen.getByText('這是要回覆的原始內容').closest('article.message');
    expect(replyButton.closest('article.message')).toBeNull();
    const actions = replyButton.closest('.message-actions');
    const row = replyButton.closest('.message-row');
    expect(actions).toBeTruthy();
    expect(row?.contains(bubble)).toBe(true);
    expect(bubble?.nextElementSibling?.classList.contains('message-trailing-meta')).toBe(true);
    expect(actions?.parentElement?.classList.contains('message-trailing-meta')).toBe(true);
    expect(bubble?.contains(actions!)).toBe(false);
    fireEvent.click(replyButton);

    const preview = document.querySelector('.reply-preview');
    expect(preview?.querySelector('.reply-avatar[data-avatar-placeholder="person"]')).toBeTruthy();
    expect(preview?.querySelector('.reply-name')?.textContent).toBe('徐佳誠');
    expect(preview?.querySelector('.reply-quote')?.textContent).toBe('這是要回覆的原始內容');
    const close = screen.getByRole('button', { name: '取消回覆' });
    expect(close.textContent).toBe('×');
    expect(screen.queryByText('取消回覆')).toBeNull();
    expect(preview?.textContent).not.toContain('回覆：');

    fireEvent.click(close);
    expect(document.querySelector('.reply-preview')).toBeNull();
  });

  it('uses an attachment fallback in the compact reply preview', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'attachment-source'), text: null, attachments: [{ id: 'attachment-1', kind: 'file' as const, name: '設計圖.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'ready' }] }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('設計圖.pdf');

    fireEvent.click(screen.getByRole('button', { name: '回覆' }));
    expect(document.querySelector('.reply-quote')?.textContent).toBe('附件：設計圖.pdf');
  });

  it('labels the generic [Sticker] placeholder as just 貼圖', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticker-generic'), text: null,
      kind: 'sticker' as const, sticker: { stickerId: '1', animated: false, altText: '[Sticker]' } }], olderCursor: null }));
    await renderLineApp(api);

    fireEvent.error(await screen.findByAltText('[Sticker]'));
    const fallback = await screen.findByRole('img', { name: '貼圖' });
    expect(fallback.textContent).toBe('貼圖');
  });

  it('shows a visible accessible sticker fallback without an empty message text block', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticker-message'), text: null,
      kind: 'sticker' as const, sticker: { stickerId: '123456', animated: false, altText: 'Hello sticker' } }], olderCursor: null }));
    await renderLineApp(api);

    fireEvent.error(await screen.findByAltText('Hello sticker'));
    const fallback = await screen.findByRole('img', { name: '貼圖：Hello sticker' });
    expect(fallback.textContent).toBe('貼圖：Hello sticker');
    expect(document.querySelector('#message-sticker-message .message-text')).toBeNull();
  });

  it('renders a sticker from its scoped media URL', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticker-image'), text: null,
      kind: 'sticker' as const, sticker: { stickerId: '123456', animated: true, altText: 'Animated sticker' } }], olderCursor: null }));
    await renderLineApp(api);

    const image = await screen.findByAltText('Animated sticker');
    expect(image.classList.contains('sticker-image')).toBe(true);
    expect(image.getAttribute('src')).toBe(lineMediaUrl({ type: 'sticker', accountId: 'account-A', chatType: 'group', chatId: 'same-chat', messageId: 'sticker-image' }));
    expect(document.querySelector('#message-sticker-image .message-text')).toBeNull();
  });

  it('renders sticon-only text large and bare with its indexed media target', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticon-only'), text: '(pray)',
      sticonRanges: [{ start: 0, end: 6, productId: '0123456789abcdef01234567', sticonId: '1', animated: false }] }], olderCursor: null }));
    await renderLineApp(api);

    const image = await screen.findByAltText('(pray)') as HTMLImageElement;
    expect(image.classList.contains('message-sticon-large')).toBe(true);
    expect(image.alt).toBe('(pray)');
    expect(document.querySelector('#message-sticon-only')?.classList.contains('bubble-bare')).toBe(true);
    expect(document.querySelector('#message-sticon-only .message-text')?.textContent).toBe('');
  });

  it('keeps mentions around an inline sticon image', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticon-mixed'), text: 'Hi (pray) @Ada',
      mentionRanges: [{ start: 10, end: 14, userId: 'ada' }],
      sticonRanges: [{ start: 3, end: 9, productId: '0123456789abcdef01234567', sticonId: '1', animated: false }] }], olderCursor: null }));
    await renderLineApp(api);

    const messageNode = document.querySelector('#message-sticon-mixed')!;
    expect(messageNode.querySelector('.message-text')?.textContent).toBe('Hi  @Ada');
    expect(messageNode.querySelector('.message-mention')?.textContent).toBe('@Ada');
    expect(messageNode.querySelector('.message-sticon')).not.toBeNull();
    await waitFor(() => expect(messageNode.querySelector('.message-sticon')?.tagName).toBe('IMG'));
    const children = [...messageNode.querySelector('.message-text')!.children];
    expect(children.findIndex((node) => node.classList.contains('message-sticon'))).toBeGreaterThanOrEqual(0);
    expect((messageNode.querySelector('.message-sticon') as HTMLImageElement | null)?.alt).toBe('(pray)');
  });

  it('renders remapped sticons between masked spans with mentions and links intact', async () => {
    const api = fakeApi();
    const display = '[REDACTED_VERIFICATION_CODE] (pray) @Ada https://example.test [REDACTED_AUTH_TOKEN] (wave)';
    const prayStart = display.indexOf('(pray)');
    const waveStart = display.indexOf('(wave)');
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticon-remapped'), text: display,
      mentionRanges: [{ start: display.indexOf('@Ada'), end: display.indexOf('@Ada') + 4, userId: 'ada' }],
      sticonRanges: [
        { start: prayStart, end: prayStart + 6, productId: '0123456789abcdef01234567', sticonId: 'pray', animated: false },
        { start: waveStart, end: waveStart + 6, productId: '0123456789abcdef01234567', sticonId: 'wave', animated: false },
      ] }], olderCursor: null }));
    await renderLineApp(api);
    const node = document.querySelector('#message-sticon-remapped')!;
    await waitFor(() => expect(node.querySelectorAll('img.message-sticon')).toHaveLength(2));
    const images = [...node.querySelectorAll('img.message-sticon')] as HTMLImageElement[];
    expect(images.map((img) => img.alt)).toEqual(['(pray)', '(wave)']);
    expect(node.querySelector('.message-mention')?.textContent).toBe('@Ada');
    expect(node.querySelector('a[href="https://example.test/"]')?.textContent).toBe('https://example.test');
    const fallbackApi = fakeApi();
    fallbackApi.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticon-remapped-fallback'), text: display,
      sticonRanges: [
        { start: prayStart, end: prayStart + 6, productId: '0123456789abcdef01234567', sticonId: 'pray', animated: false },
        { start: waveStart, end: waveStart + 6, productId: '0123456789abcdef01234567', sticonId: 'wave', animated: false },
      ] }], olderCursor: null }));
    await renderLineApp(fallbackApi);
    await waitFor(() => expect(document.querySelectorAll('#message-sticon-remapped-fallback img.message-sticon')).toHaveLength(2));
    document.querySelectorAll('#message-sticon-remapped-fallback img.message-sticon').forEach((image) => fireEvent.error(image));
    await waitFor(() => expect(document.querySelectorAll('#message-sticon-remapped-fallback .message-sticon[role="img"]')).toHaveLength(2));
    expect([...document.querySelectorAll('#message-sticon-remapped-fallback .message-sticon[role="img"]')].map((el) => el.getAttribute('aria-label'))).toEqual(['(pray)', '(wave)']);
  });

  it('shows the original sticon text when its media cannot be loaded', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'sticon-fallback'), text: '(pray)',
      sticonRanges: [{ start: 0, end: 6, productId: '0123456789abcdef01234567', sticonId: '1', animated: false }] }], olderCursor: null }));
    await renderLineApp(api);

    fireEvent.error(await screen.findByAltText('(pray)'));
    const fallback = await screen.findByRole('img', { name: '(pray)' });
    expect(fallback.textContent).toBe('(pray)');
    expect(fallback.classList.contains('message-sticon-large')).toBe(true);
  });

  it('leaves messages with no sticon ranges unchanged', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'ordinary-text'), text: 'plain text', sticonRanges: [] }], olderCursor: null }));
    await renderLineApp(api);
    const messageNode = document.querySelector('#message-ordinary-text')!;
    expect(messageNode.classList.contains('bubble-bare')).toBe(false);
    expect(messageNode.querySelector('.message-text')?.textContent).toBe('plain text');
    expect(messageNode.querySelector('.message-sticon')).toBeNull();
  });

  it('clears the reply preview when switching chats', async () => {
    const api = fakeApi();
    const another = { ...snapshot.conversations[0]!, chatId: 'another-chat', title: '另一聊天室', unreadCount: 0 };
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: [snapshot.conversations[0]!, another] }));
    api.listMessages = vi.fn(async (key) => ({ messages: [{ ...message('account-A', `message-${key.chatId}`), chatId: key.chatId, text: key.chatId === 'same-chat' ? '第一間訊息' : '第二間訊息' }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('第一間訊息');
    fireEvent.click(screen.getByRole('button', { name: '回覆' }));
    expect(document.querySelector('.reply-preview')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '另一聊天室 群組' }));
    await screen.findByText('第二間訊息');
    expect(document.querySelector('.reply-preview')).toBeNull();
  });

  it('clears the reply preview after a successful reply send', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'reply-source'), text: '待回覆訊息' }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('待回覆訊息');
    fireEvent.click(screen.getByRole('button', { name: '回覆' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: '收到' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));

    await waitFor(() => expect(api.replyText).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector('.reply-preview')).toBeNull());
    expect(screen.queryByText('LINE 傳送成功', { selector: '.inline-notice' })).toBeNull();
  });

  it('keeps the snapshot preview when the selected timeline page is empty', async () => {
    render(<App api={fakeApi()} />);
    const row = await screen.findByRole('button', { name: '同名群組 群組' });
    expect(row.querySelector('.list-preview')?.getAttribute('data-preview')).toBe('群組摘要');
  });

  it('keeps same-named chats scoped internally without exposing route identifiers', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    expect(await screen.findAllByRole('button', { name: /同名群組.*群組/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    expect(screen.getByTestId('address-plate').textContent).toContain('群組');
    expect(screen.getByTestId('address-plate').textContent).toContain('Agent 觸發：未啟用');
    expect(screen.getByTestId('address-plate').textContent).not.toContain('觀察');
    expect(screen.getByTestId('address-plate').textContent).not.toContain('account-B');
    expect(screen.getByTestId('address-plate').textContent).not.toContain('same-chat');
    expect(screen.queryByText('正在切換主操作帳號…')).toBeNull();
  });

  it('keeps LINE rooms LINE-only and allows manual sending in monitor mode', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-B', 'admin-source')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'LINE draft' } });
    expect(screen.queryByRole('textbox', { name: 'Agent 訊息' })).toBeNull();
    expect(screen.getByRole('button', { name: '傳送' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.sendText).toHaveBeenCalledWith({ accountId: 'account-B', chatType: 'group', chatId: 'same-chat' }, 'LINE draft'));
    fireEvent.click(await screen.findByRole('button', { name: '回覆' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'LINE reply' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.replyText).toHaveBeenCalledWith({ accountId: 'account-B', chatType: 'group', chatId: 'same-chat' }, 'admin-source', 'LINE reply'));
    expect(api.submitAgentRoomPrompt).not.toHaveBeenCalled();
  });

  it('hides LINE send controls and reply actions when manual sending is unavailable', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((account) => account.accountId === 'account-B' ? { ...account, canSendManually: false } : account) }));
    api.listMessages = vi.fn(async () => ({ messages: [message('account-B', 'monitor-message')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('monitor-message');

    expect(await screen.findByText('僅監控，無法傳送')).toBeTruthy();
    expect(within(screen.getByTestId('address-plate')).getByText('Agent 觸發：未啟用')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'LINE 訊息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '傳送' })).toBeNull();
    expect(screen.queryByRole('button', { name: '回覆' })).toBeNull();
    expect(document.getElementById('composer')).toBeNull();
  });

  it('derives the sticky composer status from the account state', () => {
    const base = { accountId: 'a', displayName: 'x', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const, canSendManually: true };
    const progress = (stage: 'monitoring' | 'complete') => ({ stage, copiedBytes: null, totalBytes: null, committedRows: '0', eligibleRows: null, message: null });
    expect(accountComposerStatus({ ...base, status: 'disconnected', externalImportProgress: progress('monitoring') }, true, 'zh-TW')).toMatchObject({ text: '監控中', severity: 'info' });
    expect(accountComposerStatus({ ...base, status: 'disconnected' }, true, 'zh-TW')).toMatchObject({ text: '未登入', severity: 'warning' });
    expect(accountComposerStatus({ ...base, status: 'reauth_required' }, true, 'zh-TW')).toMatchObject({ text: 'LINE 需要重新登入', severity: 'warning' });
    expect(accountComposerStatus({ ...base, status: 'degraded' }, true, 'zh-TW')).toMatchObject({ text: '連線異常', severity: 'warning' });
    expect(accountComposerStatus(base, true)).toBeNull();
    expect(accountComposerStatus(base, false, 'zh-TW')).toMatchObject({ text: '系統尚未就緒', severity: 'warning' });
    expect(accountComposerStatus({ ...base, mode: 'PAUSED', canSendManually: false }, true, 'zh-TW')).toMatchObject({ text: '已暫停' });
    expect(accountComposerStatus({ ...base, canSendManually: false, externalImportProgress: progress('complete') }, true, 'zh-TW')?.text).not.toBe('監控中');
    expect(accountComposerStatus({ ...base, canSendManually: false }, false, 'zh-TW')).toMatchObject({ text: '系統尚未就緒' });
    expect(accountComposerStatus({ ...base, mode: 'MONITOR_ONLY', canSendManually: false }, true, 'zh-TW')).toMatchObject({ text: '僅監控，無法傳送', severity: 'info' });
    expect(accountComposerStatus({ ...base, canSendManually: false }, true, 'zh-TW')).toMatchObject({ text: '尚未就緒，無法傳送', severity: 'warning' });
  });

  it('shows 未登入 in the composer slot for a disconnected account and lets a transient message override it', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((account) => account.accountId === 'account-B' ? { ...account, status: 'disconnected' as const } : account) }));
    api.listMessages = vi.fn(async () => ({ messages: [message('account-B', 'offline-message')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('offline-message');
    expect(within(screen.getByTestId('composer-status')).getByText('未登入')).toBeTruthy();
  });

  it('shows the database-empty copy for an empty timeline of a disconnected account', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((account) => account.accountId === 'account-B' ? { ...account, status: 'disconnected' as const } : account) }));
    api.listMessages = vi.fn(async () => ({ messages: [], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('資料庫中尚無此聊天室的訊息');
    expect(screen.queryByText('尚未收到訊息。登入 LINE 後，新訊息會自動保存在這裡。')).toBeNull();
  });

  it('keeps the original empty-timeline copy for a connected account', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((account) => account.accountId === 'account-B' ? { ...account, status: 'connected' as const } : account) }));
    api.listMessages = vi.fn(async () => ({ messages: [], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('尚未收到訊息。登入 LINE 後，新訊息會自動保存在這裡。');
    expect(screen.queryByText('資料庫中尚無此聊天室的訊息')).toBeNull();
  });

  it('fails closed when the snapshot has no manual-send capability projection', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, accounts: snapshot.accounts.map((account) => {
      if (account.accountId !== 'account-B') return account;
      const { canSendManually: _capability, ...legacyAccount } = account;
      return legacyAccount;
    }) }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));

    expect(await screen.findByText('僅監控，無法傳送')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'LINE 訊息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '傳送' })).toBeNull();
  });

  it('shows a new-message indicator without scrolling a reader away from older messages', async () => {
    const api = fakeApi();
    let publish!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publish = callback; return () => undefined; });
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 100, configurable: true });
    timeline.scrollTop = 0; fireEvent.scroll(timeline);
    publish({ ...snapshot, conversations: snapshot.conversations.map((item) => item.accountId === 'account-A' ? { ...item, unreadCount: 4 } : item) });
    await waitFor(() => expect(screen.getByRole('button', { name: /2 則新訊息/ })).toBeTruthy());
    expect(timeline.scrollTop).toBe(0);
  });

  it('bounds conversation rows in the DOM for a large archive', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: Array.from({ length: 1000 }, (_, index) => ({ ...snapshot.conversations[0]!, chatId: `chat-${index}` })) }));
    await renderLineApp(api);
    expect((await screen.findAllByRole('button', { name: /同名群組.*群組/ })).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.conversation-row').length).toBeLessThan(40);
  });

  it('cycles account rail, chat list, timeline and composer with F6', async () => {
    render(<App api={fakeApi()} />);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const ids = ['account-rail', 'conversation-list', 'timeline', 'composer'];
    for (const id of ids) {
      fireEvent.keyDown(window, { key: 'F6' });
      expect(document.activeElement?.id).toBe(id);
    }
  });

  it('keeps a late older-page response scoped to its original full ConversationKey', async () => {
    const api = fakeApi();
    const oldA = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    api.listMessages = vi.fn(async (key, cursor) => {
      if (key.accountId === 'account-A' && cursor === 'older-A') return oldA.promise;
      if (key.accountId === 'account-A') return { messages: [message('account-A', 'A-current')], olderCursor: 'older-A' };
      return { messages: [message('account-B', 'B-current')], olderCursor: null };
    });
    await renderLineApp(api);
    await screen.findByText('A-current');
    scrollTimelineToTop();
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('B-current');
    await act(async () => { oldA.resolve({ messages: [message('account-A', 'A-older')], olderCursor: null }); await oldA.promise; });
    expect(screen.queryByText('A-older')).toBeNull();
    expect(screen.getByText('B-current')).toBeTruthy();
  });

  it('discards a late latest-page response after switching accounts', async () => {
    const api = fakeApi();
    const lateA = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    let readsA = 0;
    api.listMessages = vi.fn(async (key) => key.accountId === 'account-B' ? { messages: [message('account-B', 'B-current')], olderCursor: null } : ++readsA === 1 ? { messages: [message('account-A', 'A-current')], olderCursor: null } : lateA.promise);
    let publish!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publish = callback; return () => undefined; });
    await renderLineApp(api);
    await screen.findByText('A-current');
    publish({ ...snapshot, conversations: snapshot.conversations.map((item) => item.accountId === 'account-A' ? { ...item, unreadCount: 3 } : item) });
    await waitFor(() => expect(readsA).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('B-current');
    await act(async () => { lateA.resolve({ messages: [message('account-A', 'A-late')], olderCursor: null }); await lateA.promise; });
    expect(screen.queryByText('A-late')).toBeNull();
    expect(screen.getByText('B-current')).toBeTruthy();
  });

  it('does not show a prior route send acknowledgement in a newly selected chat', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'accepted'; requestId: string; ok: true }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'reply A' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await act(async () => { send.resolve({ type: 'accepted', requestId: 'x', ok: true }); await send.promise; });
    expect(screen.queryByText('LINE 動作已交付；請留意送達狀態。')).toBeNull();
  });

  it('keeps a possibly delivered send as uncertain and prevents resubmitting its unchanged draft', async () => {
    const api = fakeApi();
    api.sendText = vi.fn(async () => { throw new Error('LINE_SEND_FAILED'); });
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));

    expect(await screen.findByText('LINE 傳送結果不確定；請先確認對話內容。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新傳送/ })).toBeNull();
    expect(api.sendText).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'LINE 訊息' }), { key: 'Enter', ctrlKey: true });
    expect(api.sendText).toHaveBeenCalledOnce();
  });

  it('shows a resend action only for a definitive not-started send and retries the captured route once', async () => {
    const api = fakeApi();
    api.sendText = vi.fn().mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false })
      .mockResolvedValueOnce({ type: 'accepted', requestId: 'retry', ok: true });
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const retry = await screen.findByRole('button', { name: '重新傳送訊息' });
    expect(retry.closest('.message-row')?.textContent).toContain('hello');
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(api.sendText).toHaveBeenCalledTimes(2));
    expect(api.sendText).toHaveBeenLastCalledWith({ accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, 'hello');
    await waitFor(() => expect(document.querySelector('.local-send-feedback')).toBeNull());
  });

  it('retains and settles send feedback when Conversations unmounts during navigation', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'error'; requestId: string; ok: false; code: string; message: string; retryable: boolean }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'offline page' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    await act(async () => { send.resolve({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false }); await send.promise; });
    fireEvent.click(screen.getByRole('button', { name: '聊天' }));
    expect(await screen.findByRole('button', { name: '重新傳送訊息' })).toBeTruthy();
    expect(api.sendText).toHaveBeenCalledOnce();
  });

  it('settles a late failure under its original conversation after a route change', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'error'; requestId: string; ok: false; code: string; message: string; retryable: boolean }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'route A payload' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    expect(screen.queryByText('route A payload')).toBeNull();
    await act(async () => { send.resolve({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false }); await send.promise; });
    expect(screen.queryByRole('button', { name: '重新傳送訊息' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看工作' }));
    expect(await screen.findByText('route A payload')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '重新傳送訊息' })).toBeTruthy();
  });

  it('preserves a newer reply selection and draft after an older A-B-A send settles', async () => {
    const api = fakeApi();
    const reply = deferred<{ type: 'accepted'; requestId: string; ok: true }>();
    api.listMessages = vi.fn(async (key) => key.accountId === 'account-A'
      ? { messages: [message('account-A', 'target-one'), message('account-A', 'target-two')], olderCursor: null }
      : { messages: [], olderCursor: null });
    api.replyText = vi.fn(() => reply.promise);
    await renderLineApp(api);
    await screen.findByText('target-one');
    fireEvent.click(screen.getAllByRole('button', { name: '回覆' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'old reply' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.replyText).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    fireEvent.click(screen.getByRole('button', { name: '查看工作' }));
    await screen.findByText('target-one');
    fireEvent.click(screen.getAllByRole('button', { name: '回覆' })[1]!);
    const input = screen.getByRole('textbox', { name: 'LINE 訊息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'new reply' } });
    await act(async () => { reply.resolve({ type: 'accepted', requestId: 'old', ok: true }); await reply.promise; });
    expect(input.value).toBe('new reply');
    expect(document.querySelector('.reply-quote')?.textContent).toBe('target-two');
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    await waitFor(() => expect(api.replyText).toHaveBeenCalledTimes(2));
    expect(api.replyText).toHaveBeenLastCalledWith({ accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, 'target-two', 'new reply');
  });

  it('disables a failed resend when manual-send capability is revoked', async () => {
    const api = fakeApi();
    let publish!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publish = callback; return () => undefined; });
    api.sendText = vi.fn(async () => ({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false } as const));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const retry = await screen.findByRole('button', { name: '重新傳送訊息' });
    publish({ ...snapshot, accounts: snapshot.accounts.map((item) => item.accountId === 'account-A' ? { ...item, canSendManually: false } : item) });
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(true));
    fireEvent.click(retry);
    expect(api.sendText).toHaveBeenCalledOnce();
  });

  it('retries the original reply target and removes the local bubble after retry success', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'reply-target')], olderCursor: null }));
    api.replyText = vi.fn().mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'denied', retryable: false })
      .mockResolvedValueOnce({ type: 'accepted', requestId: 'retry', ok: true });
    await renderLineApp(api);
    await screen.findByText('reply-target');
    fireEvent.click(screen.getByRole('button', { name: '回覆' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'LINE 訊息' }), { target: { value: 'reply body' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    const retry = await screen.findByRole('button', { name: '重新傳送訊息' });
    fireEvent.click(retry);
    await waitFor(() => expect(api.replyText).toHaveBeenCalledTimes(2));
    expect(api.replyText).toHaveBeenLastCalledWith({ accountId: 'account-A', chatType: 'group', chatId: 'same-chat' }, 'reply-target', 'reply body');
    await waitFor(() => expect(document.querySelector('.local-send-feedback')).toBeNull());
  });

  it('does not let a prior send acknowledgement clear a newer draft after leaving and returning', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'accepted'; requestId: string; ok: true }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const input = () => screen.getByRole('textbox', { name: 'LINE 訊息' }) as HTMLTextAreaElement;
    fireEvent.change(input(), { target: { value: 'first draft' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    fireEvent.click(screen.getByRole('button', { name: '查看工作' }));
    fireEvent.change(input(), { target: { value: 'new draft' } });
    await act(async () => { send.resolve({ type: 'accepted', requestId: 'old', ok: true }); await send.promise; });
    expect(input().value).toBe('new draft');
  });

  it('preserves a revised draft typed while the same route send is pending', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'accepted'; requestId: string; ok: true }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const input = screen.getByRole('textbox', { name: 'LINE 訊息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.change(input, { target: { value: 'new draft' } });
    await act(async () => { send.resolve({ type: 'accepted', requestId: 'old', ok: true }); await send.promise; });
    expect(input.value).toBe('new draft');
  });

  it('preserves a revised draft even when its text returns to the submitted value', async () => {
    const api = fakeApi();
    const send = deferred<{ type: 'accepted'; requestId: string; ok: true }>();
    api.sendText = vi.fn(() => send.promise);
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    const input = screen.getByRole('textbox', { name: 'LINE 訊息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '傳送' }));
    fireEvent.change(input, { target: { value: 'temporary edit' } });
    fireEvent.change(input, { target: { value: 'submitted' } });
    await act(async () => { send.resolve({ type: 'accepted', requestId: 'old', ok: true }); await send.promise; });
    expect(input.value).toBe('submitted');
  });

  it('rejects a page whose messages carry a different chat type under the same account and Chat ID', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [{ ...message('account-A', 'wrong-scope'), chatType: 'direct' as const }], olderCursor: null }));
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    await waitFor(() => expect(api.listMessages).toHaveBeenCalled());
    expect(screen.queryByText('wrong-scope')).toBeNull();
  });

  it('does not show an old route attachment error after switching chats', async () => {
    const api = fakeApi();
    const attachment = deferred<boolean>();
    api.openAttachment = vi.fn(() => attachment.promise);
    api.listMessages = vi.fn(async (key) => ({ messages: key.accountId === 'account-A' ? [{ ...message('account-A', 'A-attachment'), attachments: [{ id: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', kind: 'file' as const, name: 'file.pdf', mimeType: 'application/pdf', sizeBytes: 4, status: 'ready' }] }] : [message('account-B', 'B-current')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('A-attachment');
    fireEvent.click(screen.getByRole('button', { name: '開啟' }));
    fireEvent.click(screen.getByRole('button', { name: '查看觀察' }));
    await screen.findByText('B-current');
    await act(async () => { attachment.reject(new Error('open failed')); await attachment.promise.catch(() => undefined); });
    expect(screen.queryByText('無法開啟附件，請確認檔案仍可用且已設定 Windows 預設應用程式。')).toBeNull();
  });

  it('fetches latest messages before clearing the unread indicator', async () => {
    const api = fakeApi();
    const newest = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    let reads = 0;
    api.listMessages = vi.fn(async () => ++reads === 1 ? { messages: [message('account-A', 'A-old')], olderCursor: null } : newest.promise);
    let publish!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publish = callback; return () => undefined; });
    await renderLineApp(api);
    await screen.findByText('A-old');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 100, configurable: true });
    timeline.scrollTop = 50; fireEvent.scroll(timeline);
    publish({ ...snapshot, conversations: snapshot.conversations.map((item) => item.accountId === 'account-A' ? { ...item, unreadCount: 3 } : item) });
    const button = await screen.findByRole('button', { name: /1 則新訊息/ });
    fireEvent.click(button);
    expect(button).toBeTruthy();
    newest.resolve({ messages: [message('account-A', 'A-old'), message('account-A', 'A-new')], olderCursor: null });
    await screen.findByText('A-new');
    await waitFor(() => expect(screen.queryByRole('button', { name: /則新訊息/ })).toBeNull());
  });


  it('auto-loads exactly one older page while scroll events repeat, with no manual load buttons', async () => {
    const api = fakeApi();
    const older = deferred<{ messages: TimelineMessage[]; olderCursor: string | null }>();
    api.listMessages = vi.fn(async (_key, cursor) => cursor === null
      ? { messages: Array.from({ length: 75 }, (_, index) => message('account-A', `N-${index}`)), olderCursor: 'older-1' }
      : older.promise);
    await renderLineApp(api);
    await screen.findByText('N-74');
    expect(screen.queryByRole('button', { name: '載入較早訊息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '顯示較早訊息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '顯示較新訊息' })).toBeNull();
    scrollTimelineToTop();
    await waitFor(() => expect(api.listMessages).toHaveBeenCalledTimes(2));
    scrollTimelineToTop(); scrollTimelineToTop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    scrollTimelineToTop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.listMessages).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.listMessages).mock.calls.filter(([, cursor]) => cursor === 'older-1')).toHaveLength(1);
    expect(screen.getByText('載入中…')).toBeTruthy();
    await act(async () => { older.resolve({ messages: [message('account-A', 'O-0')], olderCursor: null }); await older.promise; });
    await screen.findByText('O-0');
    expect(screen.queryByText('載入中…')).toBeNull();
  });

  it('does not fetch when scrolled to the top with no older cursor and the window at the start', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'ONLY-1'), message('account-A', 'ONLY-2')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('ONLY-2');
    scrollTimelineToTop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('載入中…')).toBeNull();
  });

  it('renders a 300-message window, shifting it by scroll without fetching and returning to the latest on demand', async () => {
    const api = fakeApi();
    const range = (start: number) => Array.from({ length: 75 }, (_, index) => message('account-A', `M-${start + index}`));
    api.listMessages = vi.fn(async (_key, cursor) => {
      const index = cursor === null ? 4 : Number(cursor);
      return { messages: range(index * 75 + 1), olderCursor: index > 0 ? String(index - 1) : null };
    });
    await renderLineApp(api);
    await screen.findByText('M-375');
    for (const first of [226, 151, 76, 1]) {
      scrollTimelineToTop();
      await screen.findByText(`M-${first}`);
    }
    expect(api.listMessages).toHaveBeenCalledTimes(5);
    expect(document.querySelectorAll('.message').length).toBe(300);
    expect(screen.queryByText('M-375')).toBeNull();
    expect(screen.getByRole('button', { name: '跳到最新訊息' })).toBeTruthy();
    scrollTimelineToBottom();
    await screen.findByText('M-375');
    expect(screen.queryByText('M-1')).toBeNull();
    expect(document.querySelectorAll('.message').length).toBe(300);
    expect(screen.queryByRole('button', { name: '跳到最新訊息' })).toBeNull();
    scrollTimelineToTop();
    await screen.findByText('M-1');
    expect(screen.queryByText('M-375')).toBeNull();
    expect(api.listMessages).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole('button', { name: '跳到最新訊息' }));
    expect(screen.getByText('M-375')).toBeTruthy();
    expect(document.querySelectorAll('.message').length).toBeLessThanOrEqual(300);
  });

  it('shows the floating latest button only after scrolling away from the bottom and scrolls down on click', async () => {
    const api = fakeApi();
    api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'float-1')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('float-1');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 400, configurable: true });
    timeline.scrollTop = 1600;
    fireEvent.scroll(timeline);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('.latest-button')).toBeNull();
    timeline.scrollTop = 500;
    fireEvent.scroll(timeline);
    const button = await screen.findByRole('button', { name: '跳到最新訊息' });
    expect(button.textContent).toContain('最新訊息');
    expect(screen.queryByRole('button', { name: '顯示最新訊息' })).toBeNull();
    fireEvent.click(button);
    expect(timeline.scrollTop).toBe(2000);
    await waitFor(() => expect(document.querySelector('.latest-button')).toBeNull());
  });

  it('keeps an opened chat pinned to the bottom while content grows, until the reader scrolls away', async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    try {
      const api = fakeApi();
      api.listMessages = vi.fn(async () => ({ messages: [message('account-A', 'pin-1')], olderCursor: null }));
      await renderLineApp(api);
      await screen.findByText('pin-1');
      const timeline = document.getElementById('timeline')!;
      let height = 1000;
      Object.defineProperty(timeline, 'scrollHeight', { get: () => height, configurable: true });
      Object.defineProperty(timeline, 'clientHeight', { value: 400, configurable: true });
      const grow = (next: number) => { height = next; act(() => observers.forEach((callback) => callback())); };
      grow(1000);
      expect(timeline.scrollTop).toBe(1000);
      grow(1500);
      expect(timeline.scrollTop).toBe(1500);
      timeline.scrollTop = 300;
      fireEvent.scroll(timeline);
      grow(2000);
      expect(timeline.scrollTop).toBe(300);
      fireEvent.click(await screen.findByRole('button', { name: '跳到最新訊息' }));
      expect(timeline.scrollTop).toBe(2000);
      grow(2500);
      expect(timeline.scrollTop).toBe(2500);
    } finally { vi.unstubAllGlobals(); }
  });

  it('loads the latest page instead of counting a new message while pinned to the bottom', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let reads = 0;
    api.listMessages = vi.fn(async () => ({ messages: ++reads === 1 ? [message('account-A', 'pinr-old')] : [message('account-A', 'pinr-old'), message('account-A', 'pinr-new')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('pinr-old');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 200, configurable: true });
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'pinr-new' }, 'pinr-new'))));
    expect(await screen.findByText('pinr-new')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /則新訊息/ })).toBeNull();
  });

  it('virtualizes the conversation list with 66px rows', async () => {
    const api = fakeApi();
    const many = Array.from({ length: 150 }, (_, index) => ({ ...snapshot.conversations[0]!, chatId: `row-${index}`, title: `Row ${index}` }));
    api.getSnapshot = vi.fn(async () => ({ ...snapshot, conversations: many }));
    await renderLineApp(api);
    await waitFor(() => expect(document.querySelector('.virtual-list')).toBeTruthy());
    expect((document.querySelector('.virtual-list') as HTMLElement).style.height).toBe(`${150 * 66}px`);
  });

  it('shows the unread count on the floating latest button and loads the latest page when clicked', async () => {
    const api = fakeApi(); const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let reads = 0;
    api.listMessages = vi.fn(async () => ({ messages: ++reads === 1 ? [message('account-A', 'cnt-old')] : [message('account-A', 'cnt-old'), message('account-A', 'cnt-new')], olderCursor: null }));
    await renderLineApp(api);
    await screen.findByText('cnt-old');
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 200, configurable: true });
    timeline.scrollTop = 100;
    fireEvent.scroll(timeline);
    act(() => listeners.forEach((listener) => listener(storedEvent({ ...snapshot.conversations[0]!, latestMessagePreview: 'cnt-new' }, 'cnt-new'))));
    const button = await screen.findByRole('button', { name: '跳到最新訊息，1 則新訊息' });
    expect(button.textContent).toContain('1 則新訊息');
    expect(document.querySelectorAll('.latest-button').length).toBe(1);
    fireEvent.click(button);
    expect(await screen.findByText('cnt-new')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.latest-button')).toBeNull());
  });

  it('keeps status events for the oldest visible window after four history pages', async () => {
    const api = fakeApi();
    const listeners: Parameters<DesktopApi['onEvent']>[0][] = [];
    api.onEvent = vi.fn((next) => { listeners.push(next); return () => undefined; });
    let publishSnapshot!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publishSnapshot = callback; return () => undefined; });
    const range = (start: number) => Array.from({ length: 75 }, (_, index) => message('account-A', `M-${start + index}`));
    api.listMessages = vi.fn(async (_key, cursor) => {
      const page = cursor === null ? 4 : Number(cursor);
      return { messages: range(page * 75 + 1), olderCursor: page > 0 ? String(page - 1) : null };
    });
    await renderLineApp(api);
    await screen.findByText('M-375');
    for (const first of [226, 151, 76, 1]) {
      scrollTimelineToTop();
      await screen.findByText(`M-${first}`);
    }
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 300, configurable: true });
    timeline.scrollTop = 240;
    publishSnapshot({ ...snapshot, conversations: snapshot.conversations.map((item) => item.accountId === 'account-A' ? { ...item, unreadCount: 3 } : item) });
    await waitFor(() => expect(document.querySelector('.latest-button')?.textContent).toContain('1 則新訊息'));
    const unreadIndicator = document.querySelector('.latest-button')!.textContent;
    act(() => listeners.forEach((listener) => listener({
      type: 'agentJobStatusChanged', accountId: 'account-A', chatType: 'group', chatId: 'same-chat',
      sourceMessageId: 'M-100', jobId: 'job-oldest-window', status: 'running', revision: '9000000000000001',
    })));
    await waitFor(() => expect(document.querySelector('#message-M-100')?.closest('.message-row')?.querySelector('.agent-status-marker.running')).toBeTruthy());
    expect(timeline.scrollTop).toBe(240);
    expect(document.querySelector('.latest-button')?.textContent).toBe(unreadIndicator);
    expect(api.listMessages).toHaveBeenCalledTimes(5);
    expect(screen.getByText('M-1')).toBeTruthy();
    expect(screen.getByText('M-150')).toBeTruthy();
  });

  it('keeps an older loaded window in place when unread grows at that window bottom', async () => {
    const api = fakeApi();
    const range = (start: number) => Array.from({ length: 75 }, (_, index) => message('account-A', `M-${start + index}`));
    api.listMessages = vi.fn(async (_key, cursor) => {
      const index = cursor === null ? 4 : Number(cursor);
      return { messages: range(index * 75 + 1), olderCursor: index > 0 ? String(index - 1) : null };
    });
    let publish!: (value: typeof snapshot) => void;
    api.onSnapshot = vi.fn((callback) => { publish = callback; return () => undefined; });
    await renderLineApp(api);
    await screen.findByText('M-375');
    for (const first of [226, 151, 76, 1]) {
      scrollTimelineToTop();
      await screen.findByText(`M-${first}`);
    }
    const timeline = document.getElementById('timeline')!;
    Object.defineProperty(timeline, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(timeline, 'clientHeight', { value: 100, configurable: true });
    timeline.scrollTop = 500;
    publish({ ...snapshot, conversations: snapshot.conversations.map((item) => item.accountId === 'account-A' ? { ...item, unreadCount: 3 } : item) });
    await screen.findByRole('button', { name: /1 則新訊息/ }, { timeout: 10_000 });
    expect(screen.getByText('M-1')).toBeTruthy();
    expect(timeline.scrollTop).toBe(500);
    await waitFor(() => expect(api.listAgentStatuses).toHaveBeenCalled());
    const statusReads = vi.mocked(api.listAgentStatuses).mock.calls;
    expect(statusReads.length).toBeGreaterThanOrEqual(4);
    expect(statusReads.every(([key, ids]) => key.accountId === 'account-A' && key.chatId === 'same-chat' && ids.length <= 450)).toBe(true);
    expect(statusReads.some(([, ids]) => ids.length === 300)).toBe(true);
  });

  it('renders fixed Agent and Primary Admin slots vertically, including the vacant role slot', () => {
    const api = fakeApi();
    const headingRef = React.createRef<HTMLHeadingElement>();
    const accounts = [
      { ...snapshot.accounts[0]!, productRole: 'AGENT' as const },
      { accountId: 'account-pending-admin', displayName: 'Primary Admin', status: 'disconnected' as const,
        lastSyncedAt: null, mode: 'MONITOR_ONLY' as const, productRole: 'PRIMARY_ADMIN' as const },
      { accountId: 'account-legacy', displayName: 'Legacy', status: 'degraded' as const,
        lastSyncedAt: null, mode: 'MONITOR_ONLY' as const, productRole: null },
    ];
    render(<LineLogin api={api} accounts={accounts} headingRef={headingRef} />);

    const agentSlot = screen.getByRole('region', { name: 'Agent 帳號欄位' });
    const adminSlot = screen.getByRole('region', { name: '主要管理員帳號欄位' });
    expect(agentSlot.compareDocumentPosition(adminSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agentSlot.querySelector('[data-account-id="account-A"]')).toBeTruthy();
    expect(adminSlot.querySelector('[data-account-id="account-pending-admin"]')).toBeTruthy();
    // A logged-out slot offers 登入, not 重新登入.
    expect(screen.getByRole('button', { name: '登入 Primary Admin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新登入 Primary Admin' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Unclassified legacy accounts' })).toBeNull();
    expect(document.querySelector('[data-account-id="account-legacy"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /切換為主操作|設為主操作/ })).toBeNull();
  });

  it('shows the startup auto-login checkbox per account, calls the IPC, and reports failure', async () => {
    const api = fakeApi();
    const onNotice = vi.fn();
    const accounts = [
      { ...snapshot.accounts[0]!, displayName: 'Agent', productRole: 'AGENT' as const, autoLoginOnStartup: false },
      { ...snapshot.accounts[1]!, displayName: 'Primary Admin', productRole: 'PRIMARY_ADMIN' as const, autoLoginOnStartup: true },
    ];
    render(<LineLogin api={api} accounts={accounts} headingRef={React.createRef<HTMLHeadingElement>()} onNotice={onNotice} />);
    const boxes = screen.getAllByRole('checkbox', { name: '啟動時自動登入' }) as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    fireEvent.click(boxes[0]!);
    await waitFor(() => expect(api.lineSetAutoLogin).toHaveBeenCalledWith(accounts[0]!.accountId, true));
    (api.lineSetAutoLogin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ type: 'error', requestId: 'x', ok: false, code: 'SERVICE_ERROR', message: '儲存失敗', retryable: true });
    fireEvent.click(boxes[1]!);
    await waitFor(() => expect(api.lineSetAutoLogin).toHaveBeenCalledWith(accounts[1]!.accountId, false));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(extraTextFor('zh-TW', 'operationFailed')));
  });

  it('disables logout for a logged-out Primary Admin while connected Agent logout remains usable', async () => {
    const api = fakeApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const accounts = [
        { ...snapshot.accounts[0]!, displayName: 'Agent', productRole: 'AGENT' as const },
        { ...snapshot.accounts[1]!, displayName: 'Primary Admin', productRole: 'PRIMARY_ADMIN' as const, status: 'disconnected' as const },
      ];
      const { rerender } = render(<LineLogin api={api} accounts={accounts} headingRef={React.createRef<HTMLHeadingElement>()} />);
      const adminLogout = screen.getByRole('button', { name: '登出 Primary Admin' });
      expect(adminLogout).toHaveProperty('disabled', true);
      fireEvent.click(adminLogout);
      expect(confirm).not.toHaveBeenCalled();
      expect(api.lineLogout).not.toHaveBeenCalled();

      const agentLogout = screen.getByRole('button', { name: '登出 Agent' });
      expect(agentLogout).toHaveProperty('disabled', false);
      fireEvent.click(agentLogout);
      await waitFor(() => expect(api.lineLogout).toHaveBeenCalledWith(accounts[0]!.accountId));
      expect(confirm).toHaveBeenCalledOnce();

      for (const status of ['connected', 'degraded', 'reauth_required', 'disconnected'] as const) {
        rerender(<LineLogin api={api} accounts={accounts.map((account) => ({ ...account, status }))} headingRef={React.createRef<HTMLHeadingElement>()} />);
        expect(screen.getByRole('button', { name: '登出 Agent' })).toHaveProperty('disabled', status === 'disconnected');
        expect(screen.getByRole('button', { name: '登出 Primary Admin' })).toHaveProperty('disabled', status === 'disconnected');
      }
    } finally {
      confirm.mockRestore();
    }
  });

  it('offers adding an Agent in its vacant slot and keeps Primary Admin gated until Agent binding', () => {
    const api = fakeApi();
    const headingRef = React.createRef<HTMLHeadingElement>();
    const { rerender } = render(<LineLogin api={api} accounts={[]} headingRef={headingRef} />);
    expect((screen.getByRole('button', { name: '登入 Agent LINE 帳號' }) as HTMLButtonElement).disabled).toBe(false);
    const adminLogin = screen.getByRole('button', { name: '登入 Primary Admin LINE 帳號' }) as HTMLButtonElement;
    expect(adminLogin.disabled).toBe(true);
    expect(adminLogin.title).toBe('');
    expect(screen.queryByText('Agent 帳號槽位待登入')).toBeNull();
    expect(screen.queryByText('Primary Admin 帳號槽位待登入')).toBeNull();
    expect(screen.queryByText('請先完成 Agent 管理者綁定，之後才能登入 Primary Admin。')).toBeNull();

    rerender(<LineLogin api={api} accounts={[{ ...snapshot.accounts[0]!, hasPrimaryAdmin: true }]} headingRef={headingRef} />);
    expect((screen.getByRole('button', { name: '登入 Primary Admin LINE 帳號' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Agent 已完成管理者綁定，可以登入 Primary Admin。')).toBeNull();
  });

  it('shows no add controls once both fixed role slots are occupied', () => {
    const accounts = [
      { ...snapshot.accounts[0]!, productRole: 'AGENT' as const },
      { ...snapshot.accounts[1]!, productRole: 'PRIMARY_ADMIN' as const },
    ];
    render(<LineLogin api={fakeApi()} accounts={accounts} headingRef={React.createRef<HTMLHeadingElement>()} />);
    expect(screen.queryByRole('button', { name: '登入 Agent LINE 帳號' })).toBeNull();
    expect(screen.queryByRole('button', { name: '登入 Primary Admin LINE 帳號' })).toBeNull();
  });

  it('keeps account selection view-only and exposes no control-switch dialog', async () => {
    const api = fakeApi();
    await renderLineApp(api);
    await screen.findAllByRole('button', { name: /同名群組.*群組/ });
    expect(screen.queryByRole('dialog')).toBeNull();
    await openSystemTab();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /設為主操作|切換主操作/ })).toBeNull();
  });
});

describe('conversation list view toggle and sorting', () => {
  const chat = (chatId: string, title: string, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
    accountId: 'account-A', chatType: 'direct', chatId, title, unreadCount: 0, agentEnabled: false, defaultProvider: 'claude',
    latestMessagePreview: `${title} 的訊息`, latestMessageAt: '2026-10-15T10:00:00.000Z', latestAttachmentStatus: null, ...over });
  const friendSnapshot: AppSnapshot = { ...snapshot, conversations: [
    chat('u1', '王小明', { unreadCount: 3, latestMessageAt: '2026-10-15T10:00:00.000Z' }),
    chat('u2', 'Bob', { latestMessageAt: '2026-10-15T12:00:00.000Z' }),
    chat('g1', '10 號群組', { chatType: 'group', latestMessageAt: '2026-10-15T09:00:00.000Z' }),
    chat('g2', '2 號群組', { chatType: 'group', latestMessageAt: '2026-10-15T08:00:00.000Z', unreadCount: 1 }),
    chat('g3', '李四群', { chatType: 'group', latestMessageAt: '2026-10-15T07:00:00.000Z' }),
  ] };
  const friendRows = [
    { mid: 'u1', name: '王小明', avatarAvailable: false, hasConversation: true },
    { mid: 'u2', name: 'Bob', avatarAvailable: false, hasConversation: true },
    { mid: 'u3', name: 'Amy', avatarAvailable: true, hasConversation: false },
    { mid: 'u4', name: '9 樓', avatarAvailable: false, hasConversation: false },
  ];
  const zh = (left: string, right: string) => left.localeCompare(right, 'zh-TW', { sensitivity: 'base', numeric: true });
  const names = () => [...document.querySelectorAll('.conversation-list .conversation-row strong')].map((node) => node.textContent ?? '');
  const sortButton = () => screen.getByRole('button', { name: /^排序：/ });
  const chooseSort = (label: string) => { fireEvent.click(sortButton()); fireEvent.click(screen.getByRole('option', { name: label })); };
  async function renderList() {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => friendSnapshot);
    api.listFriends = vi.fn(async () => friendRows);
    render(<App api={api} />);
    await waitFor(() => expect(names()).toContain('王小明'));
    return api;
  }
  const openFriends = async () => { fireEvent.click(screen.getByRole('radio', { name: '好友' })); await screen.findByText('Amy'); };

  it('puts the 聊天/好友 toggle left of the sort control and defaults to 聊天', async () => {
    const api = await renderList();
    const toggle = screen.getByRole('radiogroup', { name: '清單類型' });
    const sort = sortButton();
    expect(toggle.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.parentElement).toBe(sort.closest('.conversation-sort'));
    expect(screen.getByRole('radio', { name: '聊天' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '好友' }).getAttribute('aria-checked')).toBe('false');
    expect(api.listFriends).not.toHaveBeenCalled();
    expect(names()).toEqual(['Bob', '王小明', '10 號群組', '2 號群組', '李四群']);
  });

  it('lists friends with conversation previews, empty-history friends last, and restores the chat list', async () => {
    const api = await renderList();
    await openFriends();
    expect(api.listFriends).toHaveBeenCalledWith('account-A');
    expect(names()).toEqual(['Bob', '王小明', '9 樓', 'Amy']);
    const previews = [...document.querySelectorAll('.conversation-row .list-preview')].map((node) => node.getAttribute('data-preview'));
    expect(previews).toEqual(['Bob 的訊息', '王小明 的訊息', '尚無聊天記錄', '尚無聊天記錄']);
    expect(document.querySelectorAll('.conversation-row .unread')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: '聊天' }));
    expect(names()).toEqual(['Bob', '王小明', '10 號群組', '2 號群組', '李四群']);
  });

  it('opens the conversation of a friend, and shows friends without history as non-clickable rows', async () => {
    await renderList();
    await openFriends();
    fireEvent.click(screen.getByRole('button', { name: '王小明 好友' }));
    await waitFor(() => expect(document.querySelector('.chat-header h2')?.textContent).toBe('王小明'));
    expect(screen.queryByRole('button', { name: /^Amy 好友/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'Amy 好友，尚無聊天記錄' })).toBeTruthy();
  });

  it('caps a friend row unread badge at 999+ while the label keeps the true count', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => ({ ...friendSnapshot, conversations: [chat('u1', '王小明', { unreadCount: 1200 })] }));
    api.listFriends = vi.fn(async () => friendRows);
    render(<App api={api} />);
    await waitFor(() => expect(names()).toContain('王小明'));
    await openFriends();
    const badge = screen.getByRole('button', { name: '王小明 好友' }).querySelector('.unread')!;
    expect(badge.textContent).toBe('999+');
    expect(badge.getAttribute('aria-label')).toBe('1,200 則未讀');
  });

  it('filters friends by name in friends mode', async () => {
    await renderList();
    await openFriends();
    fireEvent.change(screen.getByPlaceholderText('搜尋好友'), { target: { value: 'am' } });
    expect(names()).toEqual(['Amy']);
    fireEvent.change(screen.getByPlaceholderText('搜尋好友'), { target: { value: '不存在' } });
    expect(screen.getByText('找不到符合的好友。')).toBeTruthy();
  });

  it('sorts by received time and unread, then reverses when the active option is chosen again', async () => {
    await renderList();
    expect(sortButton().getAttribute('aria-label')).toBe('排序：收到的時間，由新到舊');
    expect(sortButton().textContent).toContain('收到的時間 ↓');
    chooseSort('收到的時間');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：收到的時間，由舊到新');
    expect(sortButton().textContent).toContain('收到的時間 ↑');
    expect(names()).toEqual(['李四群', '2 號群組', '10 號群組', '王小明', 'Bob']);
    chooseSort('未讀訊息');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：未讀訊息，未讀優先');
    expect(names()).toEqual(['王小明', '2 號群組', 'Bob', '10 號群組', '李四群']);
    chooseSort('未讀訊息');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：未讀訊息，未讀在後');
    expect(names()).toEqual(['李四群', '10 號群組', 'Bob', '2 號群組', '王小明']);
    chooseSort('收到的時間');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：收到的時間，由新到舊');
  });

  it('sorts chats by name with numeric, latin and CJK titles, and reverses on a second choice', async () => {
    await renderList();
    chooseSort('名稱');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：名稱，A 到 Z');
    expect(sortButton().textContent).toContain('名稱 ↑');
    const expected = [...names()].sort(zh);
    expect(names()).toEqual(expected);
    expect(names().indexOf('2 號群組')).toBeLessThan(names().indexOf('10 號群組'));
    expect(names().indexOf('10 號群組')).toBeLessThan(names().indexOf('Bob'));
    chooseSort('名稱');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：名稱，Z 到 A');
    expect(names()).toEqual([...expected].reverse());
  });

  it('applies the same sorting and direction in friends mode', async () => {
    await renderList();
    await openFriends();
    chooseSort('名稱');
    const expected = ['王小明', 'Bob', 'Amy', '9 樓'].sort(zh);
    expect(names()).toEqual(expected);
    chooseSort('名稱');
    expect(names()).toEqual([...expected].reverse());
    chooseSort('未讀訊息');
    expect(sortButton().getAttribute('aria-label')).toBe('排序：未讀訊息，未讀優先');
    expect(names()).toEqual(['王小明', 'Bob', '9 樓', 'Amy']);
    chooseSort('收到的時間');
    chooseSort('收到的時間');
    expect(names()).toEqual(['Amy', '9 樓', '王小明', 'Bob']);
  });

  it('supports the keyboard, closes on Escape and outside click, and only listens while open', async () => {
    await renderList();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const count = (spy: typeof add) => spy.mock.calls.filter((call) => call[0] === 'mousedown').length;
    expect(count(add)).toBe(0);
    fireEvent.click(sortButton());
    expect(sortButton().getAttribute('aria-expanded')).toBe('true');
    expect(count(add)).toBe(1);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(sortButton());
    expect(count(remove)).toBe(1);
    fireEvent.click(sortButton());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(sortButton(), { key: 'ArrowDown' });
    const open = screen.getByRole('listbox');
    expect(screen.getByRole('option', { name: '收到的時間' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(open, { key: 'ArrowDown' });
    fireEvent.keyDown(open, { key: 'ArrowDown' });
    fireEvent.keyDown(open, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sortButton().getAttribute('aria-label')).toBe('排序：名稱，A 到 Z');
    fireEvent.keyDown(sortButton(), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: ' ' });
    expect(sortButton().getAttribute('aria-label')).toBe('排序：名稱，Z 到 A');
    expect(count(add)).toBe(count(remove));
  });

  it('keeps at most one friend request in flight and refetches once for snapshots that arrive meanwhile', async () => {
    const api = fakeApi();
    api.getSnapshot = vi.fn(async () => friendSnapshot);
    const first = deferred<typeof friendRows>();
    api.listFriends = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(friendRows);
    const handlers: Array<(event: IpcEvent) => void> = [];
    const emit = (event: IpcEvent) => { for (const handler of [...handlers]) handler(event); };
    api.onEvent = vi.fn((handler) => { handlers.push(handler); return () => { handlers.splice(handlers.indexOf(handler), 1); }; });
    render(<App api={api} />);
    await waitFor(() => expect(names()).toContain('王小明'));
    fireEvent.click(screen.getByRole('radio', { name: '好友' }));
    await waitFor(() => expect(api.listFriends).toHaveBeenCalledTimes(1));
    act(() => { emit({ type: 'snapshotChanged', snapshot: { ...friendSnapshot } }); emit({ type: 'snapshotChanged', snapshot: { ...friendSnapshot } }); });
    expect(api.listFriends).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(friendRows); await first.promise; });
    await waitFor(() => expect(api.listFriends).toHaveBeenCalledTimes(2));
    await screen.findByText('Amy');
    act(() => { emit({ type: 'snapshotChanged', snapshot: { ...friendSnapshot } }); });
    await waitFor(() => expect(api.listFriends).toHaveBeenCalledTimes(3));
  });
});
