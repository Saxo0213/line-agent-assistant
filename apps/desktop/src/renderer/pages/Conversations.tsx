import { safeErrorTextFor, desktopTextFor, generatedPreviewFor, useDesktopLocale, useDesktopText } from '../desktop-i18n.js';
import type { Locale } from '../../locale.js';
import { AgentStatusMarker } from '../AgentStatusMarker.js';
import { MessageReactions } from './MessageReactions.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AGENT_ATTACHMENT_LIMITS, type AgentAttachmentUpload, type AppSnapshot, type ConversationSummary, type LineAccountSummary, type ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { TimelineMessage } from '../../main/service-facade.js';
import { ComposerStatus, useComposerStatus, type ComposerMessage } from './ComposerStatus.js';
import { pinPaneToBottom, useTimelineStickToBottom } from '../useTimelineStickToBottom.js';

const ATTACHMENT_WARNING_KEY = 'attachment-refresh';
const sticky = (severity: 'info' | 'warning', text: string): ComposerMessage => ({ severity, text, sticky: true });

/**
 * Persistent composer status derived from the room's account; mirrors whether sending is enabled
 * (connected + canSendManually + core ready). A disabled composer always states its reason.
 * Transient messages temporarily override it in the slot.
 */
export function accountComposerStatus(account: LineAccountSummary, coreReady: boolean, locale: Locale = 'en'): ComposerMessage {
  const stage = account.externalImportProgress?.stage;
  if (stage === 'monitoring' || stage === 'syncing') return sticky('info', desktopTextFor(locale, 'monitoring'));
  if (account.status === 'reauth_required') return sticky('warning', desktopTextFor(locale, 'lineLoginRequiredAgain'));
  if (account.status === 'disconnected') return sticky('warning', desktopTextFor(locale, 'notLoggedIn182'));
  if (account.status === 'degraded') return sticky('warning', desktopTextFor(locale, 'connectionError'));
  if (!coreReady) return sticky('warning', desktopTextFor(locale, 'systemNotReady'));
  if (account.mode === 'PAUSED') return sticky('info', desktopTextFor(locale, 'paused'));
  if (account.mode === 'MONITOR_ONLY' && account.canSendManually !== true) return sticky('info', desktopTextFor(locale, 'monitoringOnlyCannotSend'));
  if (account.canSendManually !== true) return sticky('warning', desktopTextFor(locale, 'notReadyCannotSend'));
  return null;
}
import { AvatarPlaceholder, LineMediaImage } from '../LineMediaImage.js';
import { chatTypeLabel as chatTypeLabelFor, conversationFallbackTitle as conversationFallbackTitleFor } from '../chatTypeLabels.js';
import { AvatarWithTypeBadge } from '../ChatTypeIcon.js';
import { toWritableConversationKey } from '../writableChatRoute.js';
import { addManualSendFeedback, MANUAL_SEND_FEEDBACK_LIMIT, type ManualSendFeedback } from '../manual-send-feedback.js';
import { FileAttachmentCard } from '../FileAttachmentCard.js';
import { ConversationSortMenu, DEFAULT_SORT, type SortState } from './ConversationSortMenu.js';
import { useFriends } from '../useFriends.js';
import { MessageReadReceipt } from './MessageReadReceipt.js';
import { ChatResources, type ChatResourceApi } from './ChatResources.js';

const nameCompare = (left: string, right: string, locale: Locale) => left.localeCompare(right, locale, { sensitivity: 'base', numeric: true });

const keyOf = (item: ConversationKey) => JSON.stringify([item.accountId, item.chatType, item.chatId]);
export const formatMessageTimeFor = (timestamp: string, locale: Locale) => new Date(timestamp).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/(上午|下午)(?=\d)/, '$1 ');
/** @deprecated Compatibility for consumers not yet migrated to explicit locale helpers. */
export const formatMessageTime = (timestamp: string, locale: Locale = 'en') => formatMessageTimeFor(timestamp, locale);
export function formatVisibleMessageDate(timestamp: string, now = new Date(), locale: Locale = 'en'): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}
const MAX_PENDING_ATTACHMENT_REFRESHES = 225;
const RENDER_WINDOW = 300;
const WINDOW_STEP = 100;
const OWNERSHIP_CAP = Math.round(RENDER_WINDOW * 1.5);
const AUTO_LOAD_EDGE_PX = 200;
const LATEST_BUTTON_DISTANCE_PX = 300;
const keyFor = (item: ConversationSummary): ConversationKey => ({ accountId: item.accountId, chatType: item.chatType, chatId: item.chatId });
const hasRecalledOriginal = (message: TimelineMessage) => Boolean(message.text?.trim()) || (message.deletedAtSource === true && (message.kind === 'sticker' || (message.content != null && message.content.type !== 'unsent'))) || message.recalledContent != null || message.recalledKind === 'sticker' || message.attachments.some((attachment) => attachment.status === 'ready');
function readManualFile(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment'));
    reader.readAsArrayBuffer(file);
  });
}
// The marker sits in the message metadata immediately above its timestamp; only the label differs.
const recalledMarkerLabel = (message: TimelineMessage, locale: Locale) => desktopTextFor(locale, message.deletedAtSource ? 'deleted' : 'unsent');
const scopedMessages = (messages: TimelineMessage[], key: ConversationKey) => messages.filter((item) => item.accountId === key.accountId && item.chatType === key.chatType && item.chatId === key.chatId);
const chronological = (messages: TimelineMessage[]) => [...messages].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
const compareRevision = (left: string, right: string) => left.length === right.length ? left.localeCompare(right) : left.length - right.length;
export function accountHeaderStatusFor(account: LineAccountSummary, locale: Locale): string {
  if (account.mode === 'MONITOR_ONLY') return desktopTextFor(locale, 'monitoring');
  if (account.mode === 'PAUSED') return desktopTextFor(locale, 'paused');
  if (account.status === 'connected') return desktopTextFor(locale, 'connected');
  if (account.status === 'disconnected') return desktopTextFor(locale, 'notLoggedIn182');
  if (account.status === 'reauth_required') return desktopTextFor(locale, 'lineLoginRequiredAgain');
  return desktopTextFor(locale, 'connectionError');
}
export function formatLatestMessageTime(timestamp: string | null | undefined, now = new Date(), locale: Locale = 'en'): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const dayNumber = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
  const daysAgo = dayNumber(now) - dayNumber(date);
  if (daysAgo === 0 || daysAgo < 0) {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  }
  if (daysAgo === 1) return desktopTextFor(locale, 'yesterday');
  return new Intl.DateTimeFormat(locale, date.getFullYear() === now.getFullYear()
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}
/** Sticker fallback label: 「貼圖」, plus the sticker text unless it is the generic native placeholder. */
const stickerLabel = (locale: Locale, altText: string | null | undefined) => {
  const text = altText?.trim();
  return !text || /^\[?sticker\]?$/i.test(text) ? desktopTextFor(locale, 'sticker') : desktopTextFor(locale, 'stickerArg0', { arg0: text });
};

function ConversationTime({ timestamp }: { timestamp: string | null | undefined }) {
  const locale = useDesktopLocale();
  const formatted = formatLatestMessageTime(timestamp, new Date(), locale);
  return formatted ? <time className="conversation-time" dateTime={timestamp ?? undefined}>{formatted}</time> : null;
}
type MessageMentionRange = { start: number; end: number; userId: string };
type MessageSticonRange = NonNullable<TimelineMessage['sticonRanges']>[number];
function trimUrlPunctuation(value: string): { url: string; suffix: string } {
  let end = value.length;
  while (end > 0 && /[.,!?;:，。！？；：、…"'”’]/u.test(value[end - 1]!)) end -= 1;
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (end > 0 && value[end - 1] === close) {
      const candidate = value.slice(0, end);
      if ([...candidate].filter((character) => character === close).length <= [...candidate].filter((character) => character === open).length) break;
      end -= 1;
    }
  }
  return { url: value.slice(0, end), suffix: value.slice(end) };
}
function isHttpUrl(value: string): boolean {
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch { return false; }
}
function normalizeMentionRanges(text: string, ranges: readonly MessageMentionRange[] | undefined): MessageMentionRange[] {
  if (!Array.isArray(ranges)) return [];
  const sorted = [...ranges].filter((range) => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.start < range.end && range.end <= text.length && typeof range.userId === 'string' && range.userId.trim().length > 0)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: MessageMentionRange[] = [];
  let previousEnd = 0;
  const splitsSurrogatePair = (offset: number) => offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
  for (const range of sorted) {
    if (range.start < previousEnd || splitsSurrogatePair(range.start) || splitsSurrogatePair(range.end)) continue;
    normalized.push(range);
    previousEnd = range.end;
  }
  return normalized;
}
function renderMessageText(text: string, onOpenUrl: (url: string) => void, mentionRanges?: readonly MessageMentionRange[]): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const appendLinkifiedText = (segment: string, offset: number) => {
    const urlPattern = /https?:\/\/[^\s<>]+/giu;
    let cursor = 0;
    for (const match of segment.matchAll(urlPattern)) {
      const start = match.index;
      const raw = match[0];
      if (start === undefined) continue;
      const { url, suffix } = trimUrlPunctuation(raw);
      if (!url || !isHttpUrl(url)) continue;
      if (start > cursor) parts.push(segment.slice(cursor, start));
      let parsedUrl: string;
      try { parsedUrl = new URL(url).href; } catch { continue; }
      parts.push(<React.Fragment key={`link-${offset + start}`}><a href={parsedUrl} onClick={(event) => { event.preventDefault(); onOpenUrl(parsedUrl); }} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}>{url}</a>{suffix}</React.Fragment>);
      cursor = start + raw.length;
    }
    if (cursor < segment.length) parts.push(segment.slice(cursor));
  };
  let cursor = 0;
  for (const [index, range] of normalizeMentionRanges(text, mentionRanges).entries()) {
    appendLinkifiedText(text.slice(cursor, range.start), cursor);
    parts.push(<span className="message-mention" key={`mention-${range.start}-${range.end}-${index}`}>{text.slice(range.start, range.end)}</span>);
    cursor = range.end;
  }
  appendLinkifiedText(text.slice(cursor), cursor);
  return parts.length ? parts : text;
}
function validSticonRanges(text: string, ranges: readonly MessageSticonRange[] | undefined): MessageSticonRange[] {
  if (!Array.isArray(ranges)) return [];
  const sorted = [...ranges].filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.start < range.end && range.end <= text.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result: MessageSticonRange[] = [];
  for (const range of sorted) if (range.start >= (result.at(-1)?.end ?? 0)) result.push(range);
  return result;
}
function sticonOnly(text: string, ranges: readonly MessageSticonRange[]): boolean {
  if (ranges.length === 0) return false;
  let cursor = 0;
  for (const range of ranges) {
    if (text.slice(cursor, range.start).trim()) return false;
    cursor = range.end;
  }
  return !text.slice(cursor).trim();
}
function renderTextWithSticons(text: string, onOpenUrl: (url: string) => void, mentionRanges: readonly MessageMentionRange[] | undefined,
  ranges: readonly MessageSticonRange[], api: DesktopApi, message: TimelineMessage, large = false): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const mentions = normalizeMentionRanges(text, mentionRanges);
  const appendText = (start: number, end: number) => {
    if (start >= end) return;
    const localMentions = mentions.filter((range) => range.start >= start && range.end <= end)
      .map((range) => ({ ...range, start: range.start - start, end: range.end - start }));
    parts.push(<React.Fragment key={`text-${start}`}>{renderMessageText(text.slice(start, end), onOpenUrl, localMentions)}</React.Fragment>);
  };
  let cursor = 0;
  const size = ranges.length === 1 ? 'large' : ranges.length <= 3 ? 'medium' : 'small';
  for (const [index, range] of ranges.entries()) {
    appendText(cursor, range.start);
    const original = text.slice(range.start, range.end);
    parts.push(<LineMediaImage key={`sticon-${index}`} api={api} enabled
      target={{ type: 'sticon', accountId: message.accountId, chatType: message.chatType, chatId: message.chatId, messageId: message.messageId, index }}
      className={`message-sticon${large ? ` message-sticon-${size}` : ''}`} alt={original} title={original} fallback={original} accessibleFallback />);
    cursor = range.end;
  }
  appendText(cursor, text.length);
  return parts;
}
/** Unread badge text shared by chat and friend rows; the aria-label keeps the true count. */
const unreadBadgeText = (count: number) => count > 999 ? '999+' : String(count);
const PRIVATE_USE_SUPPLEMENTARY =/[\u{F0000}-\u{10FFFF}]/gu;
const withoutPrivateUse = (text: string) => text.replace(PRIVATE_USE_SUPPLEMENTARY, '');
/** Chat-list preview: sticons as 16px inline images (same media target as the timeline); never shows private-use code points. */
function ListPreview({ api, chat, preview }: { api: DesktopApi; chat: ConversationSummary | null | undefined; preview: string }) {
  const locale = useDesktopLocale();
  const desktopText = useDesktopText();
  const ranges = chat?.latestMessageId && preview === generatedPreviewFor(locale, chat.latestMessageDisplay, chat.latestMessagePreview).trim() ? validSticonRanges(preview, chat.latestSticonRanges) : [];
  if (!chat || !chat.latestMessageId || ranges.length === 0) {
    const clean = withoutPrivateUse(preview);
    return <span className="list-preview" data-preview={clean} aria-label={desktopText('latestMessageArg0', { arg0: clean })} />;
  }
  const parts: React.ReactNode[] = [];
  let label = '';
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    const before = withoutPrivateUse(preview.slice(cursor, range.start));
    parts.push(before);
    label += desktopText('arg0Emoji', { arg0: before });
    parts.push(<LineMediaImage key={`sticon-${index}`} api={api} enabled
      target={{ type: 'sticon', accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId, messageId: chat.latestMessageId, index }}
      className="list-sticon" alt={desktopText('emoji')} fallback={desktopText('emoji201')} accessibleFallback />);
    cursor = range.end;
  }
  const rest = withoutPrivateUse(preview.slice(cursor));
  parts.push(rest);
  label += rest;
  return <span className="list-preview list-preview-rich" data-preview={withoutPrivateUse(preview)} aria-label={desktopText('latestMessageArg0', { arg0: label })}>{parts}</span>;
}
/** A bubble run: consecutive messages from one sender, on one local day, each within this gap of the previous. */
const RUN_GAP_MS = 5 * 60_000;
const BARE_CONTENT_TYPES: ReadonlySet<string> = new Set(['event', 'contact', 'location', 'rich', 'unsupported']);
function PinIcon() {
  return <svg className="location-pin-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" /></svg>;
}
function systemEventLabel(locale: Locale, nativeContentType: number | null, text: string | null, postNotificationType?: 'note' | 'album' | null): string {
  // A chat event with LINE's own rendered line shows only that line; without it the generic label remains.
  if (nativeContentType === 18 && text?.trim()) return text.trim();
  const renderedText = nativeContentType === 16 && text?.trim().toUpperCase() === 'POSTNOTIFICATION' ? null : text;
  const label = nativeContentType === 6 ? desktopTextFor(locale, 'call') : nativeContentType === 9 ? desktopTextFor(locale, 'gift')
    : nativeContentType === 16 && postNotificationType === 'note' ? desktopTextFor(locale, 'postNoteNotification')
      : nativeContentType === 16 && postNotificationType === 'album' ? desktopTextFor(locale, 'postAlbumNotification')
    : nativeContentType === 16 ? desktopTextFor(locale, 'postNotification') : nativeContentType === 18 ? desktopTextFor(locale, 'chatEvent') : undefined;
  return [label, renderedText?.trim() || undefined].filter(Boolean).join(' ') || desktopTextFor(locale, 'systemMessage');
}

export function formatCallLabelFor(locale: Locale, call: { media: 'audio' | 'video' | null; result: string | null; durationMs: number | null } | null | undefined,
  direction: 'inbound' | 'outbound', nativeContentType: number | null, text: string | null): string {
  if (!call) return systemEventLabel(locale, nativeContentType, text);
  if (call.result === 'CANCELED') return direction === 'outbound' ? desktopTextFor(locale, 'cancelledCall') : desktopTextFor(locale, 'missedCall');
  if (call.result === 'NORMAL' && call.durationMs !== null) {
    const totalSeconds = Math.floor(call.durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const duration = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return desktopTextFor(locale, 'arg0DurationArg1', { arg0: call.media === 'video' ? desktopTextFor(locale, 'videoCall') : desktopTextFor(locale, 'voiceCall'), arg1: duration });
  }
  return direction === 'outbound' ? desktopTextFor(locale, 'noAnswer') : desktopTextFor(locale, 'missedCall');
}
/** @deprecated Compatibility for pages not yet migrated to locale-bound helpers. */
export function formatCallLabel(call: Parameters<typeof formatCallLabelFor>[1], direction: 'inbound' | 'outbound', nativeContentType: number | null, text: string | null): string {
  return formatCallLabelFor('en', call, direction, nativeContentType, text);
}

export function Conversations({ api, snapshot, conversation, selected, onSelect, account, coreReady, showCoreWarning, messageRevisions,
  sendFeedback, sendFeedbackRef, setSendFeedback, pendingSubmitRoutes, snapshotToken }: {
  api: DesktopApi; snapshot: AppSnapshot; conversation: ConversationSummary | null; selected: string | null; onSelect: (key: string) => void;
  account: LineAccountSummary | null; coreReady: boolean; showCoreWarning: boolean; messageRevisions: Record<string, number>;
  sendFeedback: ManualSendFeedback[]; sendFeedbackRef: React.MutableRefObject<ManualSendFeedback[]>;
  setSendFeedback: React.Dispatch<React.SetStateAction<ManualSendFeedback[]>>;
  pendingSubmitRoutes: React.MutableRefObject<Set<string>>;
  /** Changes with every snapshot revision; the 好友 view refetches when it changes. */
  snapshotToken?: unknown;
}) {
  const locale = useDesktopLocale();
  const desktopText = useDesktopText();
  const chatTypeLabel = (chatType: string) => chatTypeLabelFor(locale, chatType);
  const conversationFallbackTitle = (chatType: string) => conversationFallbackTitleFor(locale, chatType);
  const formatMessageTime = (timestamp: string) => formatMessageTimeFor(timestamp, locale);
  const nameCompareLocale = (left: string, right: string) => nameCompare(left, right, locale);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [listView, setListView] = useState<'chats' | 'friends'>('chats');
  const friendsView = listView === 'friends';
  const { friends, error: friendsError } = useFriends(api, account?.accountId ?? null, friendsView, snapshotToken);
  const [listOpen, setListOpen] = useState(false);
  const [listTop, setListTop] = useState(0);
  const [listHeight, setListHeight] = useState(720);
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({});
  const [manualFiles, setManualFiles] = useState<Record<string, Array<{ id: string; file: File }>>>({});
  const manualFileInput = useRef<HTMLInputElement>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileCounter = useRef(0);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const messagesRef = useRef<TimelineMessage[]>(messages);
  messagesRef.current = messages;
  const [windowStart, setWindowStart] = useState(Number.MAX_SAFE_INTEGER);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reply, setReply] = useState<TimelineMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [visibleMessageDate, setVisibleMessageDate] = useState<string | null>(null);
  const { message: composerStatus, setError: setComposerError, setWarning: setComposerWarning, setNotice: setComposerNotice, clear: clearComposerStatus, clearKey: clearComposerKey } = useComposerStatus();
  // Chat-room system messages all go to the composer status slot.
  const notify = (message: string) => setComposerError(message);
  async function openMessageUrl(url: string) {
    try {
      const result = await api.openExternalUrl(url);
      if (result.type !== 'openExternalUrl') notify(result.type === 'error' ? safeErrorTextFor(locale, result, desktopText('unableToOpenLink')) : desktopText('unableToOpenLink'));
    } catch (error) {
      notify(safeErrorTextFor(locale, error, desktopText('unableToOpenLink')));
    }
  }
  type JobStatus = { jobId: string; status: NonNullable<TimelineMessage['agentJobStatus']>; revision: string };
  type StatusTarget = { generation: number; key: ConversationKey; ids: string[] };
  type AttachmentProjection = { routeKey: string; messageId: string } & Omit<TimelineMessage['attachments'][number], 'id'>;
  const lifecycleOverlay = useRef(new Map<string, { jobId: string; status: NonNullable<TimelineMessage['agentJobStatus']>; revision: string }>());
  const recoveredStatuses = useRef(new Map<string, JobStatus>());
  const pendingOlderIds = useRef<string[]>([]);
  const pendingAttachmentRefreshes = useRef(new Map<string, { routeKey: string; messageId: string }>());
  const reconciledAttachments = useRef(new Map<string, AttachmentProjection>());
  const failedAttachmentRefreshes = useRef(new Map<string, { routeKey: string; messageId: string }>());
  const attachmentRefreshActive = useRef(false);
  const attachmentRefreshScheduled = useRef(false);
  const [attachmentRefreshErrorRoute, setAttachmentRefreshErrorRoute] = useState<string | null>(null);
  const attachmentWindowSignature = useRef('');
  const attachmentPageWindowSignature = useRef('');
  const attachmentSummarySignature = useRef('');
  const visibleWindowOwnership = useRef<{ routeKey: string; ids: string[] }>({ routeKey: '', ids: [] });
  const olderRequest = useRef<number | null>(null);
  const statusLookup = useRef<{ active: boolean; pending: StatusTarget | null; dirtyRoute: string | null }>({ active: false, pending: null, dirtyRoute: null });
  const statusWindowSignature = useRef('');
  const timeline = useRef<HTMLDivElement>(null);
  const timelineContent = useRef<HTMLDivElement>(null);
  const dateFrame = useRef<number | null>(null);
  const listNode = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number; elementId?: string; offset?: number } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const autoLoad = useRef<() => void>(() => undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unsendMenu, setUnsendMenu] = useState<{ messageId: string; x: number; y: number; routeKey: string } | null>(null);
  const [unsendBusy, setUnsendBusy] = useState(false);
  const [manualUnsendWindow, setManualUnsendWindow] = useState<'1h' | '7d'>('1h');
  useEffect(() => { if (typeof api.getManualUnsendWindow !== 'function') return; let live = true; void api.getManualUnsendWindow().then((window) => { if (live) setManualUnsendWindow(window); }).catch(() => undefined); return () => { live = false; }; }, [api]);
  const requestGeneration = useRef(0);
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  const draftRevisions = useRef<Record<string, number>>({});
  const replyRevision = useRef(0);
  const currentRoute = useRef('');
  const currentRouteValue = useRef<ConversationKey | null>(null);
  const jumpToBottom = useRef(false);
  const scrollOnSend = useRef(false);
  const nearBottom = useRef(true);
  const pinTop = useRef<number | null>(null);
  const previousUnread = useRef<Record<string, number>>({});
  const seenRevisions = useRef<Record<string, number>>({});
  const pendingUnreadRevisions = useRef<Record<string, number>>({});
  const unreadObservedRevisions = useRef<Record<string, number>>({});
  const observedUnreadConversations = useRef<Record<string, ConversationSummary | undefined>>({});
  const route = conversation ? keyFor(conversation) : null;
  const writableRoute = route ? toWritableConversationKey(route) : null;
  const routeKey = route ? keyOf(route) : '';
  useTimelineStickToBottom(timeline, timelineContent, routeKey, nearBottom, anchor, pinTop);
  const retryAttachmentRefreshRef = useRef<() => void>(() => undefined);
  retryAttachmentRefreshRef.current = retryVisibleAttachmentRefreshes;
  const attachmentWarningShown = useRef(false);
  function updateVisibleMessageDate() {
    const pane = timeline.current;
    if (!pane) { setVisibleMessageDate(null); return; }
    const paneTop = pane.getBoundingClientRect().top;
    const paneBottom = pane.getBoundingClientRect().bottom;
    const first = [...pane.querySelectorAll<HTMLElement>('[data-message-date]')]
      .filter((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > paneTop && rect.top < paneBottom; })
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
    setVisibleMessageDate(first?.dataset.messageDate ?? null);
  }
  useEffect(() => {
    setVisibleMessageDate(null);
    const pane = timeline.current;
    if (!pane || !messages.length || !route) return;
    const update = () => {
      if (dateFrame.current !== null) cancelAnimationFrame(dateFrame.current);
      dateFrame.current = requestAnimationFrame(() => { dateFrame.current = null; updateVisibleMessageDate(); });
    };
    update();
    pane.addEventListener('scroll', update, { passive: true });
    return () => {
      pane.removeEventListener('scroll', update);
      if (dateFrame.current !== null) cancelAnimationFrame(dateFrame.current);
      dateFrame.current = null;
    };
  }, [routeKey, messages, windowStart]);
  useEffect(() => {
    if (attachmentRefreshErrorRoute !== null && attachmentRefreshErrorRoute === routeKey) {
      attachmentWarningShown.current = true;
      setComposerWarning(desktopText('attachmentStatusIsTemporarilyUnavailable'), { label: desktopText('refresh'), run: () => { clearComposerKey(ATTACHMENT_WARNING_KEY); retryAttachmentRefreshRef.current(); } }, ATTACHMENT_WARNING_KEY);
    } else if (attachmentWarningShown.current) {
      attachmentWarningShown.current = false;
      clearComposerKey(ATTACHMENT_WARNING_KEY);
    }
  }, [attachmentRefreshErrorRoute, routeKey]);
  const refreshRevision = messageRevisions[routeKey] ?? 0;
  const lineRevisionKey = `line:${routeKey}`;
  currentRoute.current = routeKey;
  currentRouteValue.current = route;
  useEffect(() => { setUnsendMenu(null); }, [routeKey]);
  const lineDraft = lineDrafts[routeKey] ?? '';
  const routeFiles = manualFiles[routeKey] ?? [];
  const canAttachMedia = !!writableRoute && route?.chatType !== 'room';
  const canSendLine = !!writableRoute && !!account && account.canSendManually === true && account.status === 'connected' && coreReady;
  function addManualFiles(incoming: File[]) {
    if (sending || incoming.length === 0 || !canAttachMedia) return;
    let total = routeFiles.reduce((sum, item) => sum + item.file.size, 0);
    let count = routeFiles.length;
    let problem: string | null = null;
    const accepted: Array<{ id: string; file: File }> = [];
    for (const file of incoming) {
      if (count >= AGENT_ATTACHMENT_LIMITS.maxFiles) { problem = desktopText('upToArg0Files', { arg0: AGENT_ATTACHMENT_LIMITS.maxFiles }); continue; }
      if (file.size < 1 || file.size > AGENT_ATTACHMENT_LIMITS.maxFileBytes) { problem = desktopText('maximumArg0MbPerFile', { arg0: 20 }); continue; }
      if (total + file.size > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) { problem = desktopText('maximumArg0MbInAttachments', { arg0: 50 }); continue; }
      fileCounter.current += 1;
      accepted.push({ id: `line-file-${fileCounter.current}`, file });
      count += 1;
      total += file.size;
    }
    if (accepted.length) setManualFiles((current) => ({ ...current, [routeKey]: [...(current[routeKey] ?? []), ...accepted] }));
    if (problem) notify(problem);
  }
  function removeManualFile(id: string) {
    setManualFiles((current) => ({ ...current, [routeKey]: (current[routeKey] ?? []).filter((item) => item.id !== id) }));
  }
  function canShowUnsend(message: TimelineMessage): boolean {
    const age = Date.now() - Date.parse(message.occurredAt);
    return canSendLine && message.direction === 'outbound' && !message.deleted && message.content?.type !== 'unsent'
      && Number.isFinite(age) && age >= 0 && age <= (manualUnsendWindow === '7d' ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  }
  async function runUnsend() {
    const selectedMessage = unsendMenu;
    setUnsendMenu(null);
    if (!selectedMessage || !route || !canSendLine || selectedMessage.routeKey !== routeKey || unsendBusy) return;
    const message = messagesRef.current.find((item) => item.messageId === selectedMessage.messageId);
    if (!message || !canShowUnsend(message)) return;
    if (!window.confirm(desktopText('unsendConfirm'))) return;
    const generation = requestGeneration.current;
    const capturedRouteKey = routeKey;
    const capturedRoute = route;
    setUnsendBusy(true);
    try {
      const result = await api.unsendMessage(capturedRoute, message.messageId);
      if (result.type !== 'accepted') {
        if (generation === requestGeneration.current && currentRoute.current === capturedRouteKey) {
          notify(safeErrorTextFor(locale, result, desktopText('unsendFailed')));
        }
        return;
      }
      if (generation !== requestGeneration.current || currentRoute.current !== capturedRouteKey || capturedRouteKey !== routeKey) return;
      const projected = await api.listMessages(capturedRoute, null, 1, message.messageId);
      if (generation !== requestGeneration.current || currentRoute.current !== capturedRouteKey || capturedRouteKey !== routeKey) return;
      const updated = projected.messages.find((item) => item.messageId === message.messageId);
      if (!updated) throw new Error(desktopText('unsendFailed'));
      setMessages((current) => current.map((item) => item.messageId === updated.messageId ? updated : item));
    } catch (error) {
      if (generation === requestGeneration.current && currentRoute.current === capturedRouteKey) notify(safeErrorTextFor(locale, error, desktopText('unsendFailed')));
    } finally { setUnsendBusy(false); }
  }
  function chooseReply(target: TimelineMessage | null) { replyRevision.current += 1; setReply(target); }
  function visibleMessageIds(items = messagesRef.current, start = windowStart): string[] {
    const first = Math.min(start, Math.max(0, items.length - RENDER_WINDOW));
    return items.slice(first, first + RENDER_WINDOW).map((item) => item.messageId);
  }
  visibleWindowOwnership.current = {
    routeKey,
    ids: [...new Set([...visibleMessageIds(messages, windowStart), ...pendingOlderIds.current])].slice(0, OWNERSHIP_CAP),
  };
  function mergeStatus(item: TimelineMessage, loaded?: TimelineMessage): TimelineMessage {
    const candidates: Array<JobStatus | null> = [
      item.agentJobId && item.agentJobStatus && item.agentJobRevision
        ? { jobId: item.agentJobId, status: item.agentJobStatus, revision: item.agentJobRevision } : null,
      loaded?.agentJobId && loaded.agentJobStatus && loaded.agentJobRevision
        ? { jobId: loaded.agentJobId, status: loaded.agentJobStatus, revision: loaded.agentJobRevision } : null,
      lifecycleOverlay.current.get(item.messageId) ?? null, recoveredStatuses.current.get(item.messageId) ?? null,
    ];
    const winner = candidates.filter((candidate): candidate is JobStatus => !!candidate && (!item.agentJobId || candidate.jobId === item.agentJobId))
      .reduce<JobStatus | null>((best, candidate) => !best || compareRevision(candidate.revision, best.revision) > 0 ? candidate : best, null);
    if (!winner || (item.agentJobId === winner.jobId && item.agentJobStatus === winner.status && item.agentJobRevision === winner.revision)) return item;
    return { ...item, agentJobId: winner.jobId, agentJobStatus: winner.status, agentJobRevision: winner.revision };
  }
  function mergePage(items: TimelineMessage[], loaded = messagesRef.current) {
    const existing = new Map(loaded.map((item) => [item.messageId, item]));
    return items.map((item) => {
      const merged = mergeStatus(item, existing.get(item.messageId));
      let changed = false;
      const attachments = merged.attachments.map((attachment) => {
        const state = reconciledAttachments.current.get(attachment.id);
        if (!state || state.routeKey !== routeKey || state.messageId !== merged.messageId) return attachment;
        changed = true;
        return { ...attachment, kind: state.kind, name: state.name, mimeType: state.mimeType,
          sizeBytes: state.sizeBytes, status: state.status, canRetryManually: state.canRetryManually };
      });
      return changed ? { ...merged, attachments } : merged;
    });
  }
  function pruneStatusMaps(tracked = new Set(visibleWindowOwnership.current.ids)) {
    for (const id of lifecycleOverlay.current.keys()) if (!tracked.has(id)) lifecycleOverlay.current.delete(id);
    for (const id of recoveredStatuses.current.keys()) if (!tracked.has(id)) recoveredStatuses.current.delete(id);
  }
  function requestStatusReconcile(generation: number, key: ConversationKey, ids: string[]) {
    statusLookup.current.pending = { generation, key, ids: [...new Set(ids)].slice(0, OWNERSHIP_CAP) };
    if (statusLookup.current.active) return;
    statusLookup.current.active = true;
    void (async () => {
      try {
        while (statusLookup.current.pending) {
          const target = statusLookup.current.pending;
          statusLookup.current.pending = null;
          try {
            const statuses = await api.listAgentStatuses(target.key, target.ids);
            if (target.generation !== requestGeneration.current || currentRoute.current !== keyOf(target.key)) continue;
            for (const row of statuses) {
              const prior = recoveredStatuses.current.get(row.messageId);
              if (!prior || prior.jobId !== row.jobId || compareRevision(row.revision, prior.revision) > 0) recoveredStatuses.current.set(row.messageId, row);
            }
            setMessages((current) => current.map((item) => mergeStatus(item)));
            for (const row of statuses) {
              const event = lifecycleOverlay.current.get(row.messageId);
              const loaded = messagesRef.current.find((item) => item.messageId === row.messageId);
              const represented = loaded?.agentJobId === row.jobId && !!loaded.agentJobRevision
                && compareRevision(loaded.agentJobRevision, event?.revision ?? row.revision) >= 0;
              if (event?.jobId === row.jobId && compareRevision(row.revision, event.revision) >= 0 && represented) lifecycleOverlay.current.delete(row.messageId);
            }
            statusLookup.current.dirtyRoute = null;
          } catch { statusLookup.current.dirtyRoute = keyOf(target.key); }
        }
      } finally {
        statusLookup.current.active = false;
        const pending = statusLookup.current.pending;
        if (pending) requestStatusReconcile(pending.generation, pending.key, pending.ids);
      }
    })();
  }
  async function fetchPage(key: ConversationKey, before: string | null, limit: number, generation = requestGeneration.current) {
    try {
      const page = await api.listMessages(key, before, limit);
      if (generation === requestGeneration.current && currentRoute.current === keyOf(key) && before !== null) pendingOlderIds.current = page.messages.map((item) => item.messageId).slice(0, 75);
      return { page };
    } finally { if (before !== null && olderRequest.current === generation) olderRequest.current = null; }
  }
  async function drainAttachmentRefreshes() {
    if (attachmentRefreshActive.current) return;
    attachmentRefreshActive.current = true;
    try {
      while (pendingAttachmentRefreshes.current.size > 0) {
        const key = currentRouteValue.current;
        const keyString = key ? keyOf(key) : '';
        if (!key || !keyString || visibleWindowOwnership.current.routeKey !== keyString) {
          pendingAttachmentRefreshes.current.clear();
          return;
        }
        const generation = requestGeneration.current;
        const batch = new Map(pendingAttachmentRefreshes.current);
        pendingAttachmentRefreshes.current.clear();
        const loaded = messagesRef.current;
        const visible = new Set(visibleWindowOwnership.current.ids);
        const attachmentIds: string[] = [];
        for (const [attachmentId, target] of batch) {
          if (target.routeKey !== keyString) continue;
          const isVisible = loaded.some((item) => visible.has(item.messageId) && item.messageId === target.messageId
            && item.attachments.some((attachment) => attachment.id === attachmentId));
          if (isVisible) attachmentIds.push(attachmentId);
        }
        if (!attachmentIds.length) continue;
        const targetById = new Map([...batch].map(([id, target]) => [id, target]));
        let states;
        try { states = await api.listAttachmentStates(key, attachmentIds); }
        catch {
          try { states = await api.listAttachmentStates(key, attachmentIds); }
          catch {
            if (generation === requestGeneration.current && currentRoute.current === keyString) {
              const currentVisible = new Set(visibleWindowOwnership.current.routeKey === keyString ? visibleWindowOwnership.current.ids : []);
              for (const attachmentId of attachmentIds) {
                const target = targetById.get(attachmentId);
                if (!target || !currentVisible.has(target.messageId)) continue;
                if (!failedAttachmentRefreshes.current.has(attachmentId) && failedAttachmentRefreshes.current.size >= MAX_PENDING_ATTACHMENT_REFRESHES) {
                  const oldest = failedAttachmentRefreshes.current.keys().next().value;
                  if (oldest !== undefined) failedAttachmentRefreshes.current.delete(oldest);
                }
                failedAttachmentRefreshes.current.set(attachmentId, target);
              }
              if (failedAttachmentRefreshes.current.size > 0) setAttachmentRefreshErrorRoute(keyString);
            }
            continue;
          }
        }
        if (generation !== requestGeneration.current || currentRoute.current !== keyString) break;
        const currentVisible = new Set(visibleWindowOwnership.current.routeKey === keyString ? visibleWindowOwnership.current.ids : []);
        const refreshed = new Map(states.filter((state) => targetById.get(state.attachmentId)?.messageId === state.messageId
          && currentVisible.has(state.messageId)
          && !pendingAttachmentRefreshes.current.has(state.attachmentId)).map((state) => [state.attachmentId, state]));
        if (refreshed.size) {
          for (const [attachmentId, state] of refreshed) {
            const target = targetById.get(attachmentId)!;
            if (!reconciledAttachments.current.has(attachmentId) && reconciledAttachments.current.size >= MAX_PENDING_ATTACHMENT_REFRESHES) {
              const oldest = reconciledAttachments.current.keys().next().value;
              if (oldest !== undefined) reconciledAttachments.current.delete(oldest);
            }
            reconciledAttachments.current.set(attachmentId, { routeKey: keyString, messageId: target.messageId,
              kind: state.kind, name: state.name, mimeType: state.mimeType, sizeBytes: state.sizeBytes,
              status: state.status, canRetryManually: state.canRetryManually });
            failedAttachmentRefreshes.current.delete(attachmentId);
          }
          setAttachmentRefreshErrorRoute((current) => current === keyString && failedAttachmentRefreshes.current.size === 0 ? null : current);
          setMessages((current) => {
            if (generation !== requestGeneration.current || currentRoute.current !== keyString) return current;
            return current.map((item) => {
              const matching = [...refreshed.values()].filter((state) => state.messageId === item.messageId);
              if (!matching.length || !currentVisible.has(item.messageId)) return item;
              const byId = new Map(matching.map((state) => [state.attachmentId, state]));
              let messageChanged = false;
              const attachments = item.attachments.map((attachment) => {
                const state = byId.get(attachment.id);
                const next = state && !pendingAttachmentRefreshes.current.has(attachment.id)
                  ? { ...attachment, kind: state.kind, name: state.name, mimeType: state.mimeType,
                    sizeBytes: state.sizeBytes, status: state.status, canRetryManually: state.canRetryManually }
                  : attachment;
                if (next !== attachment && (next.kind !== attachment.kind || next.name !== attachment.name || next.mimeType !== attachment.mimeType
                  || next.sizeBytes !== attachment.sizeBytes || next.status !== attachment.status || next.canRetryManually !== attachment.canRetryManually)) messageChanged = true;
                return next;
              });
              return messageChanged ? { ...item, attachments } : item;
            });
          });
        }
      }
    } finally {
      attachmentRefreshActive.current = false;
      if (pendingAttachmentRefreshes.current.size > 0) void drainAttachmentRefreshes();
    }
  }
  function scheduleAttachmentRefreshDrain() {
    if (attachmentRefreshScheduled.current) return;
    attachmentRefreshScheduled.current = true;
    queueMicrotask(() => {
      attachmentRefreshScheduled.current = false;
      void drainAttachmentRefreshes();
    });
  }
  function enqueueAttachmentRefresh(attachmentId: string, target: { routeKey: string; messageId: string }) {
    if (!pendingAttachmentRefreshes.current.has(attachmentId) && pendingAttachmentRefreshes.current.size >= MAX_PENDING_ATTACHMENT_REFRESHES) return;
    pendingAttachmentRefreshes.current.set(attachmentId, target);
    scheduleAttachmentRefreshDrain();
  }
  function enqueueVisibleAttachmentRefreshes(ids = visibleWindowOwnership.current.ids, force = false) {
    if (!route || conversation?.localOnly || visibleWindowOwnership.current.routeKey !== routeKey) return;
    const visible = new Set(ids);
    let remaining = MAX_PENDING_ATTACHMENT_REFRESHES - pendingAttachmentRefreshes.current.size;
    for (const item of messagesRef.current) {
      if (remaining <= 0) break;
      if (!visible.has(item.messageId)) continue;
      for (const attachment of item.attachments) {
        if (remaining <= 0) break;
        if (attachment.status === 'ready' || attachment.status === 'failed' || attachment.status === 'expired') continue;
        if (!force && reconciledAttachments.current.get(attachment.id)?.routeKey === routeKey) continue;
        if (force) reconciledAttachments.current.delete(attachment.id);
        if (!pendingAttachmentRefreshes.current.has(attachment.id)) remaining -= 1;
        enqueueAttachmentRefresh(attachment.id, { routeKey, messageId: item.messageId });
      }
    }
  }
  function retryVisibleAttachmentRefreshes() {
    if (!route || currentRoute.current !== routeKey) return;
    const visible = new Set(visibleWindowOwnership.current.routeKey === routeKey ? visibleWindowOwnership.current.ids : []);
    const current = new Map(messagesRef.current.filter((item) => visible.has(item.messageId))
      .map((item) => [item.messageId, new Set(item.attachments.map((attachment) => attachment.id))]));
    for (const [attachmentId, target] of failedAttachmentRefreshes.current) {
      if (target.routeKey === routeKey && current.get(target.messageId)?.has(attachmentId)) enqueueAttachmentRefresh(attachmentId, target);
    }
    enqueueVisibleAttachmentRefreshes();
  }
  useEffect(() => api.onEvent((event) => {
    if (event.type !== 'attachmentChanged' || !route || conversation?.localOnly || currentRoute.current !== routeKey
      || visibleWindowOwnership.current.routeKey !== routeKey) return;
    const visible = new Set(visibleWindowOwnership.current.ids);
    const target = messagesRef.current.find((item) => visible.has(item.messageId)
      && item.attachments.some((attachment) => attachment.id === event.attachmentId));
    if (!target) return;
    enqueueAttachmentRefresh(event.attachmentId, { routeKey, messageId: target.messageId });
  }), [api, routeKey, conversation?.localOnly]);
  useEffect(() => api.onEvent((event) => {
    if (event.type !== 'agentJobStatusChanged' || !route || event.accountId !== route.accountId || event.chatType !== route.chatType || event.chatId !== route.chatId) return;
    if (visibleWindowOwnership.current.routeKey !== routeKey) return;
    const prior = lifecycleOverlay.current.get(event.sourceMessageId);
    const visible = messagesRef.current.find((item) => item.messageId === event.sourceMessageId);
    if (visible?.agentJobId && visible.agentJobId !== event.jobId) return;
    if (prior && prior.jobId !== event.jobId) return;
    if (prior && compareRevision(event.revision, prior.revision) <= 0) return;
    if (visible?.agentJobRevision && visible.agentJobId === event.jobId && compareRevision(event.revision, visible.agentJobRevision) <= 0) return;
    const tracked = new Set(visibleWindowOwnership.current.ids);
    if (!tracked.has(event.sourceMessageId)) return;
    pruneStatusMaps(tracked);
    lifecycleOverlay.current.set(event.sourceMessageId, { jobId: event.jobId, status: event.status, revision: event.revision });
    setMessages((current) => current.map((item) => item.messageId === event.sourceMessageId ? mergeStatus(item) : item));
    if (statusLookup.current.dirtyRoute === routeKey) requestStatusReconcile(requestGeneration.current, route, [...tracked]);
  }), [api, routeKey]);
  function replaceFeedback(entries: ManualSendFeedback[]) { sendFeedbackRef.current = entries; setSendFeedback(entries); }
  function settleFeedback(id: string, status: ManualSendFeedback['status'] | 'remove') {
    replaceFeedback(sendFeedbackRef.current.flatMap((entry) => entry.id !== id ? [entry] : status === 'remove' ? [] : [{ ...entry, status }]));
  }

  async function retryFeedback(entry: ManualSendFeedback) {
    if (!writableRoute || keyOf(writableRoute) !== entry.routeKey || !canSendLine) return;
    const current = sendFeedbackRef.current.find((item) => item.id === entry.id);
    if (!current || current.status !== 'failed') return;
    replaceFeedback(sendFeedbackRef.current.map((item) => item.id === entry.id ? { ...item, status: 'pending' } : item));
    try {
      const result = current.replyToMessageId
        ? await api.replyText(writableRoute, current.replyToMessageId, current.text)
        : await api.sendText(writableRoute, current.text);
      if (result.ok) settleFeedback(current.id, 'remove');
      else settleFeedback(current.id, result.type === 'error' && result.code === 'LINE_SEND_NOT_STARTED' ? 'failed' : 'unknown');
    } catch { settleFeedback(current.id, 'unknown'); }
  }

  useEffect(() => {
    if (!route || conversation?.localOnly) {
      requestGeneration.current += 1;
      olderRequest.current = null; setLoadingOlder(false);
      pendingOlderIds.current = [];
      lifecycleOverlay.current.clear(); recoveredStatuses.current.clear();
      pendingAttachmentRefreshes.current.clear(); reconciledAttachments.current.clear(); failedAttachmentRefreshes.current.clear();
      attachmentWindowSignature.current = ''; attachmentPageWindowSignature.current = ''; attachmentSummarySignature.current = ''; setAttachmentRefreshErrorRoute(null);
      statusLookup.current.pending = null; statusLookup.current.dirtyRoute = null;
      visibleWindowOwnership.current = { routeKey, ids: [] };
      setMessages([]); setCursor(null); return;
    }
    const generation = ++requestGeneration.current;
    olderRequest.current = null; setLoadingOlder(false);
    seenRevisions.current[routeKey] = refreshRevision;
    anchor.current = null; jumpToBottom.current = false; nearBottom.current = true; pinTop.current = null; setFarFromBottom(false);
    lifecycleOverlay.current.clear(); recoveredStatuses.current.clear(); pendingOlderIds.current = [];
    pendingAttachmentRefreshes.current.clear(); reconciledAttachments.current.clear(); failedAttachmentRefreshes.current.clear();
    attachmentWindowSignature.current = ''; attachmentPageWindowSignature.current = ''; attachmentSummarySignature.current = ''; setAttachmentRefreshErrorRoute(null);
    statusLookup.current.pending = null; statusLookup.current.dirtyRoute = null; statusWindowSignature.current = '';
    setMessages([]); setWindowStart(Number.MAX_SAFE_INTEGER); setCursor(null); chooseReply(null); setNewCount(0); clearComposerStatus(); setSending(false);
    void fetchPage(route, null, 75, generation).then(({ page }) => { if (generation === requestGeneration.current && currentRoute.current === routeKey) { const initial = chronological(mergePage(scopedMessages(page.messages, route), [])); jumpToBottom.current = initial.length > 0; setMessages(initial); setCursor(page.olderCursor); } }).catch(() => { if (generation === requestGeneration.current && currentRoute.current === routeKey) notify(desktopText('unableToLoadMessagesExistingChatsRemainAvailable')); });
    return () => { requestGeneration.current += 1; };
  }, [api, routeKey, conversation?.localOnly]);

  useEffect(() => {
    if (!route || conversation?.localOnly || !messages.length) return;
    const generation = requestGeneration.current;
    const ids = [...new Set([...visibleMessageIds(messages, windowStart), ...pendingOlderIds.current])].slice(0, OWNERSHIP_CAP);
    const tracked = new Set(ids);
    visibleWindowOwnership.current = { routeKey, ids };
    pruneStatusMaps(tracked);
    const visible = new Set(ids);
    const pageWindowSignature = `${generation}:${ids.join('|')}`;
    if (pageWindowSignature !== attachmentPageWindowSignature.current) {
      attachmentPageWindowSignature.current = pageWindowSignature;
      for (const [attachmentId, target] of pendingAttachmentRefreshes.current) if (target.routeKey === routeKey && !visible.has(target.messageId)) pendingAttachmentRefreshes.current.delete(attachmentId);
      for (const [attachmentId, state] of reconciledAttachments.current) if (state.routeKey === routeKey && !visible.has(state.messageId)) reconciledAttachments.current.delete(attachmentId);
      for (const [attachmentId, target] of failedAttachmentRefreshes.current) if (target.routeKey === routeKey && !visible.has(target.messageId)) failedAttachmentRefreshes.current.delete(attachmentId);
      if (failedAttachmentRefreshes.current.size === 0) setAttachmentRefreshErrorRoute((current) => current === routeKey ? null : current);
    }
    const signature = `${generation}:${ids.join('|')}`;
    if (signature !== statusWindowSignature.current || statusLookup.current.dirtyRoute === routeKey) {
      statusWindowSignature.current = signature;
      requestStatusReconcile(generation, route, ids);
    }
    const nonterminal = messages.flatMap((item) => visible.has(item.messageId)
      ? item.attachments.filter((attachment) => attachment.status !== 'ready' && attachment.status !== 'failed' && attachment.status !== 'expired')
        .map((attachment) => `${item.messageId}:${attachment.id}:${attachment.status}`)
      : []);
    const attachmentSignature = `${generation}:${nonterminal.join('|')}`;
    if (attachmentSignature !== attachmentWindowSignature.current) {
      attachmentWindowSignature.current = attachmentSignature;
      enqueueVisibleAttachmentRefreshes(ids);
    }
    const summarySignature = `${conversation?.latestAttachmentStatus ?? ''}:${conversation?.latestMessagePreview ?? ''}`;
    if (summarySignature !== attachmentSummarySignature.current) {
      if (attachmentSummarySignature.current && summarySignature !== attachmentSummarySignature.current) enqueueVisibleAttachmentRefreshes(ids, true);
      attachmentSummarySignature.current = summarySignature;
    }
  }, [messages, windowStart, routeKey, conversation?.localOnly, conversation?.latestAttachmentStatus, conversation?.latestMessagePreview]);

  useEffect(() => {
    if (!route || conversation?.localOnly) return;
    const previous = seenRevisions.current[routeKey] ?? 0;
    const pending = refreshRevision - previous;
    if (pending <= 0) return;
    seenRevisions.current[routeKey] = refreshRevision;
    pendingUnreadRevisions.current[routeKey] = (pendingUnreadRevisions.current[routeKey] ?? 0) + pending;
    const node = timeline.current;
    const atBottom = nearBottom.current || (node ? node.scrollHeight - node.scrollTop - node.clientHeight <= 40 : false);
    nearBottom.current = atBottom;
    if (windowStart !== Number.MAX_SAFE_INTEGER || !atBottom) { setNewCount((count) => count + pending); return; }
    const timer = setTimeout(() => void loadLatest(), 50);
    return () => clearTimeout(timer);
  }, [refreshRevision, routeKey, windowStart]);

  // A manual send always reveals the newest content, even if the reader had scrolled up.
  useLayoutEffect(() => {
    if (!scrollOnSend.current || !timeline.current) return;
    scrollOnSend.current = false;
    pinPaneToBottom(timeline.current, pinTop);
    nearBottom.current = true;
  }, [sendFeedback, windowStart]);

  useLayoutEffect(() => {
    if (!timeline.current) return;
    if (anchor.current) {
      const pending = anchor.current;
      const target = pending.elementId ? document.getElementById(pending.elementId) : null;
      if (target && timeline.current.contains(target)) timeline.current.scrollTop += target.getBoundingClientRect().top - timeline.current.getBoundingClientRect().top - (pending.offset ?? 0);
      else if (!pending.elementId) timeline.current.scrollTop += timeline.current.scrollHeight - pending.height;
      anchor.current = null;
    } else if (jumpToBottom.current) {
      pinPaneToBottom(timeline.current, pinTop); nearBottom.current = true;
      jumpToBottom.current = false;
    }
  }, [messages, windowStart]);

  useEffect(() => {
    if (!route || conversation?.localOnly) return;
    const snapshotChanged = observedUnreadConversations.current[routeKey] !== conversation;
    observedUnreadConversations.current[routeKey] = conversation ?? undefined;
    const previous = previousUnread.current[routeKey];
    previousUnread.current[routeKey] = conversation?.unreadCount ?? 0;
    const increase = (conversation?.unreadCount ?? 0) - (previous ?? conversation?.unreadCount ?? 0);
    const previousRevision = unreadObservedRevisions.current[routeKey] ?? 0;
    const revisionIncrease = refreshRevision - previousRevision;
    unreadObservedRevisions.current[routeKey] = refreshRevision;
    if (increase <= 0) {
      if (snapshotChanged && previous !== undefined && revisionIncrease <= 0) pendingUnreadRevisions.current[routeKey] = 0;
      return;
    }
    const covered = Math.min(increase, pendingUnreadRevisions.current[routeKey] ?? 0);
    pendingUnreadRevisions.current[routeKey] = Math.max(0, (pendingUnreadRevisions.current[routeKey] ?? 0) - covered);
    const unmatchedIncrease = increase - covered;
    if (unmatchedIncrease <= 0) return;
    const node = timeline.current;
    const latestWindowStart = Math.min(windowStart, Math.max(0, messages.length - RENDER_WINDOW));
    const atLatestLoadedWindow = latestWindowStart + RENDER_WINDOW >= messages.length;
    if (!node || !atLatestLoadedWindow || (!nearBottom.current && node.scrollHeight - node.scrollTop - node.clientHeight > 40)) { setNewCount((count) => count + unmatchedIncrease); return; }
    const generation = requestGeneration.current;
    void fetchPage(route, null, 75, generation).then(({ page }) => {
      if (generation !== requestGeneration.current || currentRoute.current !== routeKey) return;
      setMessages((current) => chronological([...current, ...mergePage(scopedMessages(page.messages, route), current).filter((item) => !current.some((existing) => existing.messageId === item.messageId && existing.accountId === item.accountId))]));
      setWindowStart(Number.MAX_SAFE_INTEGER); jumpToBottom.current = true; setNewCount(0);
    }).catch(() => { if (generation === requestGeneration.current && currentRoute.current === routeKey) notify(desktopText('newMessagesAreTemporarilyUnavailable')); });
  }, [api, routeKey, conversation, refreshRevision, windowStart, messages.length]);

  function captureAnchor(heightFallback: boolean): boolean {
    const pane = timeline.current;
    if (!pane) return false;
    const paneTop = pane.getBoundingClientRect().top;
    const first = [...pane.querySelectorAll<HTMLElement>('article[id^="message-"]')].find((element) => element.getBoundingClientRect().bottom > paneTop);
    if (first) { anchor.current = { height: pane.scrollHeight, top: pane.scrollTop, elementId: first.id, offset: first.getBoundingClientRect().top - paneTop }; return true; }
    if (heightFallback) { anchor.current = { height: pane.scrollHeight, top: pane.scrollTop }; return true; }
    return false;
  }
  function shiftWindow(next: number) {
    const latest = Math.max(0, messagesRef.current.length - RENDER_WINDOW);
    const clamped = Math.max(0, Math.min(next, latest));
    const target = clamped >= latest ? Number.MAX_SAFE_INTEGER : clamped;
    if (target === windowStart || (target === Number.MAX_SAFE_INTEGER && windowStart >= latest)) return;
    captureAnchor(false);
    setWindowStart(target);
  }
  autoLoad.current = () => {
    const pane = timeline.current;
    if (!pane || !route || anchor.current) return;
    if (pane.scrollTop < AUTO_LOAD_EDGE_PX) {
      if (visibleStart > 0) shiftWindow(visibleStart - WINDOW_STEP);
      else if (cursor) void older();
    } else if (hasNewerLoaded && pane.scrollHeight - pane.scrollTop - pane.clientHeight < AUTO_LOAD_EDGE_PX) {
      shiftWindow(visibleStart + WINDOW_STEP);
    }
  };
  function handleTimelineScroll() {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null; autoLoad.current();
      const pane = timeline.current;
      if (pane) setFarFromBottom(pane.scrollHeight - pane.scrollTop - pane.clientHeight > LATEST_BUTTON_DISTANCE_PX);
    });
  }
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; }, [routeKey]);

  async function older() {
    const generation = requestGeneration.current;
    if (!route || !cursor || !timeline.current || olderRequest.current === generation) return;
    olderRequest.current = generation;
    setLoadingOlder(true);
    const old = cursor;
    try { const { page } = await fetchPage(route, old, 75, generation); if (generation !== requestGeneration.current || currentRoute.current !== routeKey) return; captureAnchor(true); setMessages((current) => chronological([...mergePage(scopedMessages(page.messages, route), current).filter((item) => !current.some((existing) => existing.messageId === item.messageId && existing.accountId === item.accountId)), ...current])); setWindowStart(0); setCursor(page.olderCursor); pendingOlderIds.current = []; }
    catch { if (generation === requestGeneration.current && currentRoute.current === routeKey) { anchor.current = null; notify(desktopText('olderMessagesAreTemporarilyUnavailable')); } }
    finally { if (generation === requestGeneration.current) setLoadingOlder(false); }
  }

  async function loadLatest() {
    if (!route) return;
    const generation = requestGeneration.current;
    try {
      const { page } = await fetchPage(route, null, 75, generation);
      if (generation !== requestGeneration.current || currentRoute.current !== routeKey) return;
      setMessages((current) => { const latest = mergePage(scopedMessages(page.messages, route), current); return chronological([...current.filter((item) => !latest.some((fresh) => fresh.messageId === item.messageId && fresh.accountId === item.accountId)), ...latest]); });
      setWindowStart(Number.MAX_SAFE_INTEGER); nearBottom.current = true; jumpToBottom.current = true; setNewCount(0);
    } catch { if (generation === requestGeneration.current && currentRoute.current === routeKey) notify(desktopText('latestMessagesHaveNotLoadedTryAgain')); }
  }

  function jumpToLatest() {
    setFarFromBottom(false);
    if (newCount > 0) { void loadLatest(); return; }
    nearBottom.current = true;
    if (hasNewerLoaded) {
      setWindowStart(Number.MAX_SAFE_INTEGER); jumpToBottom.current = true;
      requestAnimationFrame(() => { if (timeline.current) pinPaneToBottom(timeline.current, pinTop); jumpToBottom.current = false; });
    } else if (timeline.current) pinPaneToBottom(timeline.current, pinTop);
  }

  async function openAttachment(id: string) {
    const generation = requestGeneration.current;
    try { if (!await api.openAttachment(id)) throw new Error('Attachment was not opened'); }
    catch { if (generation === requestGeneration.current && currentRoute.current === routeKey) notify(desktopText('unableToOpenAttachmentCheckThatTheFileExists')); }
  }

  async function downloadAttachment(id: string) {
    if (!writableRoute) return;
    const generation = requestGeneration.current;
    try {
      const result = await api.downloadAttachment(writableRoute, id);
      if (generation !== requestGeneration.current || currentRoute.current !== routeKey) return;
      await loadLatest();
      if (!result.ok && generation === requestGeneration.current && currentRoute.current === routeKey) {
        notify(desktopText('unableToDownloadAttachmentTryAgainLater'));
      }
    } catch {
      if (generation === requestGeneration.current && currentRoute.current === routeKey) {
        notify(desktopText('unableToDownloadAttachmentTryAgainLater'));
        await loadLatest();
      }
    }
  }

  async function submit() {
    if (!writableRoute || sending || pendingSubmitRoutes.current.has(routeKey)) return;
    const generation = requestGeneration.current;
    const revisionKey = lineRevisionKey;
    const submittedRevision = draftRevisions.current[revisionKey] ?? 0;
    const text = lineDraft.trim();
    const submittedFiles = [...routeFiles];
    if (!text && submittedFiles.length === 0) return;
    if (!canSendLine) return;
    const capturedRoute = writableRoute;
    const capturedReplyId = reply?.messageId ?? null;
    const submittedReplyRevision = replyRevision.current;
    const id = text ? crypto.randomUUID() : null;
    if (text) {
      const currentEntries = sendFeedbackRef.current;
      if (currentEntries.length >= MANUAL_SEND_FEEDBACK_LIMIT && currentEntries.every((entry) => entry.status === 'pending')) {
        setComposerError(desktopText('sendFeedbackIsFullTrySendingAgainLater')); return;
      }
      const pendingEntry: ManualSendFeedback = { id: id!, key: capturedRoute, routeKey, text, replyToMessageId: capturedReplyId,
        createdAt: new Date().toISOString(), status: 'pending' };
      const nextEntries = addManualSendFeedback(currentEntries, pendingEntry);
      if (!nextEntries) { setComposerError(desktopText('sendFeedbackIsFullTrySendingAgainLater')); return; }
      sendFeedbackRef.current = nextEntries;
      setSendFeedback(nextEntries);
      scrollOnSend.current = true; jumpToBottom.current = true; setWindowStart(Number.MAX_SAFE_INTEGER);
    }
    pendingSubmitRoutes.current.add(routeKey);
    setSending(true); clearComposerStatus();
    try {
      if (text && id) {
        const result = capturedReplyId ? await api.replyText(capturedRoute, capturedReplyId, text) : await api.sendText(capturedRoute, text);
        if (result.ok) {
          settleFeedback(id, 'remove');
          if (currentRoute.current === routeKey) setComposerNotice(desktopText('sentToLine'));
        } else {
          const notStarted = result.type === 'error' && result.code === 'LINE_SEND_NOT_STARTED';
          settleFeedback(id, notStarted ? 'failed' : 'unknown');
          if (currentRoute.current === routeKey) setComposerError(notStarted
            ? safeErrorTextFor(locale, result, desktopText('messageWasNotSentTryAgain'))
            : desktopText('deliveryCouldNotBeConfirmedCheckLineBeforeRetrying'));
          setLineDrafts((drafts) => draftRevisions.current[revisionKey] === submittedRevision && drafts[routeKey] === lineDraft ? { ...drafts, [routeKey]: '' } : drafts);
          return;
        }
        setLineDrafts((drafts) => draftRevisions.current[revisionKey] === submittedRevision && drafts[routeKey] === lineDraft ? { ...drafts, [routeKey]: '' } : drafts);
        if (capturedReplyId && currentRoute.current === routeKey && replyRevision.current === submittedReplyRevision) chooseReply(null);
      }
      for (const item of submittedFiles) {
        const upload: AgentAttachmentUpload = { name: item.file.name, bytes: await readManualFile(item.file) };
        if (!api.sendManualMedia) throw new Error('Manual media sending is unavailable');
        const result = await api.sendManualMedia(capturedRoute, [upload]);
        if (!result.ok) {
          const notStarted = result.type === 'error' && ['LINE_SEND_NOT_STARTED', 'LINE_MEDIA_BUSY', 'LINE_MEDIA_UNAVAILABLE',
            'LINE_MEDIA_UNSUPPORTED_CHAT', 'ACCOUNT_NOT_READY', 'ACCOUNT_NOT_ACTIVE', 'EXTERNAL_MONITOR_READ_ONLY',
            'MANUAL_MEDIA_INVALID', 'MANUAL_MEDIA_LIMIT', 'MANUAL_MEDIA_STAGE_FAILED', 'SERVICE_CLOSING'].includes(result.code);
          if (currentRoute.current === routeKey) setComposerError(notStarted
            ? safeErrorTextFor(locale, result, desktopText('mediaWasNotSentTryAgain'))
            : desktopText('deliveryCouldNotBeConfirmedCheckLineBeforeRetrying'));
          return;
        }
        setManualFiles((current) => ({ ...current, [routeKey]: (current[routeKey] ?? []).filter((candidate) => candidate.id !== item.id) }));
      }
      if (submittedFiles.length > 0 && currentRoute.current === routeKey) setComposerNotice(desktopText('sentToLine'));
    } catch {
      if (id) settleFeedback(id, 'unknown');
      if (currentRoute.current === routeKey) setComposerError(desktopText('deliveryCouldNotBeConfirmedCheckLineBeforeRetrying'));
      if (text) setLineDrafts((drafts) => draftRevisions.current[revisionKey] === submittedRevision && drafts[routeKey] === lineDraft ? { ...drafts, [routeKey]: '' } : drafts);
    }
    finally {
      pendingSubmitRoutes.current.delete(routeKey);
      if (generation === requestGeneration.current && currentRoute.current === routeKey) setSending(false);
    }
  }

  // 'desc' is the default direction of 收到的時間 / 未讀訊息 and 'asc' of 名稱; the opposite direction reverses the whole order.
  const directionSign = (sort.direction === (sort.mode === 'name' ? 'asc' : 'desc') ? 1 : -1);
  const receivedAt = (value: string | null | undefined) => Date.parse(value ?? '') || 0;
  const filtered = snapshot.conversations
    .filter((item) => item.localOnly || item.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((left, right) => {
      const localOnlyOrder = Number(Boolean(right.localOnly)) - Number(Boolean(left.localOnly));
      if (localOnlyOrder) return localOnlyOrder;
      const stableOrder = left.accountId.localeCompare(right.accountId)
        || left.chatType.localeCompare(right.chatType)
        || left.chatId.localeCompare(right.chatId);
      if (sort.mode === 'name') return directionSign * (nameCompare(left.title, right.title, locale) || stableOrder);
      if (sort.mode === 'unread') {
        const unreadOrder = Number(right.unreadCount > 0) - Number(left.unreadCount > 0);
        if (unreadOrder) return directionSign * unreadOrder;
      }
      return directionSign * ((receivedAt(right.latestMessageAt) - receivedAt(left.latestMessageAt)) || stableOrder);
    });
  const conversationByMid = new Map<string, ConversationSummary>();
  if (friendsView) for (const item of snapshot.conversations) if (item.chatType === 'direct' && !item.localOnly) conversationByMid.set(item.chatId, item);
  const friendItems = !friendsView || !friends ? [] : friends
    .map((friend) => ({ friend, conversation: friend.hasConversation ? conversationByMid.get(friend.mid) ?? null : null, name: friend.name || desktopText('unnamedFriend') }))
    .filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((left, right) => {
      const stableOrder = left.friend.mid.localeCompare(right.friend.mid);
      const byName = nameCompare(left.name, right.name, locale);
      if (sort.mode === 'name') return directionSign * (byName || stableOrder);
      if (sort.mode === 'unread') {
        const unreadOrder = Number((right.conversation?.unreadCount ?? 0) > 0) - Number((left.conversation?.unreadCount ?? 0) > 0);
        if (unreadOrder) return directionSign * unreadOrder;
      }
      const leftAt = receivedAt(left.conversation?.latestMessageAt);
      const rightAt = receivedAt(right.conversation?.latestMessageAt);
      return directionSign * ((rightAt - leftAt) || byName || stableOrder);
    });
  const virtual = filtered.length > 100;
  const rowHeight = 66;
  const first = virtual ? Math.max(0, Math.floor(listTop / rowHeight) - 4) : 0;
  const last = virtual ? Math.min(filtered.length, first + Math.ceil(listHeight / rowHeight) + 8) : filtered.length;
  const visibleRows = filtered.slice(first, last).map((item, offset) => ({ item, index: first + offset }));
  if (virtual && focusedRow) {
    const focusedIndex = filtered.findIndex((item) => keyOf(item) === focusedRow);
    if (focusedIndex >= 0 && (focusedIndex < first || focusedIndex >= last)) visibleRows.push({ item: filtered[focusedIndex]!, index: focusedIndex });
  }
  const friendVirtual = friendItems.length > 100;
  const friendFirst = friendVirtual ? Math.max(0, Math.floor(listTop / 66) - 4) : 0;
  const friendLast = friendVirtual ? Math.min(friendItems.length, friendFirst + Math.ceil(listHeight / 66) + 8) : friendItems.length;
  const friendRows = friendItems.slice(friendFirst, friendLast).map((entry, offset) => ({ entry, index: friendFirst + offset }));
  const visibleStart = Math.min(windowStart, Math.max(0, messages.length - RENDER_WINDOW));
  const visibleMessages = messages.slice(visibleStart, visibleStart + RENDER_WINDOW);
  const hasNewerLoaded = visibleStart + visibleMessages.length < messages.length;
  const replyName = reply ? (reply.senderName === reply.senderId ? (reply.direction === 'outbound' ? desktopText('me') : desktopText('otherPerson')) : reply.senderName) : '';
  const replyContent = reply ? (reply.deleted ? desktopText('thisMessageWasUnsent') : reply.text?.trim() || (reply.attachments.length ? desktopText('attachmentArg0', { arg0: reply.attachments[0]?.name ? `：${reply.attachments[0].name}` : '' }) : desktopText('messageContent'))) : '';
  const replyLeadingTrim = reply?.text ? reply.text.length - reply.text.trimStart().length : 0;
  const replyMentionRanges = reply?.text && replyContent === reply.text.trim()
    ? reply.mentionRanges?.map((range) => ({ ...range, start: range.start - replyLeadingTrim, end: range.end - replyLeadingTrim }))
    : undefined;
  return <div className="conversation-layout">
    <section className={`conversation-list ${listOpen ? 'open' : ''}`} id="conversation-list" tabIndex={-1} aria-label={desktopText('chatList')}><div className="conversation-search-top"><label className="search-field"><span className="sr-only">{friendsView ? desktopText('searchFriends') : desktopText('searchChats')}</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={friendsView ? desktopText('searchFriends') : desktopText('searchChats')} /></label></div>
      <div className="conversation-sort"><div className="conversation-view-toggle" role="radiogroup" aria-label={desktopText('listType')}>{(['chats', 'friends'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={listView === value} className={listView === value ? 'active' : undefined} onClick={() => { if (listView === value) return; setListView(value); if (listNode.current) listNode.current.scrollTop = 0; setListTop(0); }}>{value === 'chats' ? desktopText('chats') : desktopText('friends')}</button>)}</div><ConversationSortMenu value={sort} onChange={(next) => { setSort(next); if (listNode.current) listNode.current.scrollTop = 0; setListTop(0); }} /></div>
       {friendsView ? <div className="list-scroll" ref={listNode} onScroll={(event) => { setListTop(event.currentTarget.scrollTop); setListHeight(event.currentTarget.clientHeight || 720); }}><div className="friend-list" style={friendItems.length > 100 ? { height: friendItems.length * 66 } : undefined}>{friendRows.map(({ entry, index }) => {
        const { friend, conversation: chat, name } = entry;
        const rowStyle = friendItems.length > 100 ? { position: 'absolute' as const, top: index * 66, height: 66 } : undefined;
        const body = <>
          <AvatarWithTypeBadge chatType="direct">{chat ? <LineMediaImage api={api} enabled={chat.avatarAvailable === true} target={{ type: 'conversation', accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId }} fallbackKind="person" className="conversation-avatar" /> : <AvatarPlaceholder kind="person" className="conversation-avatar" />}</AvatarWithTypeBadge>
          <span className="conversation-copy">
            <span className="conversation-title-line"><strong>{name}</strong><ConversationTime timestamp={chat?.latestMessageAt} /></span>
          <span className="list-row-sub">{(() => { const preview = chat ? generatedPreviewFor(locale, chat.latestMessageDisplay, chat.latestMessagePreview).trim() || (chat.latestAttachmentStatus ? desktopText('attachments') : desktopText('noMessagesYet')) : desktopText('noChatHistoryYet'); return <ListPreview api={api} chat={chat} preview={preview} />; })()}{chat && chat.unreadCount > 0 && <b className="unread" aria-label={desktopText('arg0Unread', { arg0: chat.unreadCount })}>{unreadBadgeText(chat.unreadCount)}</b>}</span>
          </span>
        </>;
        return chat
          ? <button key={friend.mid} data-row-index={index} style={rowStyle} className={keyOf(chat) === (selected ?? keyOf(conversation ?? chat)) ? 'conversation-row selected' : 'conversation-row'} onClick={() => { onSelect(keyOf(chat)); setListOpen(false); }} aria-label={desktopText('arg0Friend', { arg0: name })}>{body}</button>
          : <div key={friend.mid} data-row-index={index} style={rowStyle} className="conversation-row friend-row-static" role="group" aria-label={desktopText('arg0FriendWithNoChatHistory', { arg0: name })}>{body}</div>;
      })}{friends === null && !friendsError && <p className="empty">{desktopText('loadingFriends')}</p>}{friendsError && friends === null && <p className="empty">{desktopText('unableToLoadFriends')}</p>}{friends !== null && !friendItems.length && <p className="empty">{filter ? desktopText('noMatchingFriends') : desktopText('noFriends')}</p>}</div></div> : <div className="list-scroll" ref={listNode} onScroll={(event) => { setListTop(event.currentTarget.scrollTop); setListHeight(event.currentTarget.clientHeight || 720); }}><div className={virtual ? 'virtual-list' : undefined} style={virtual ? { height: filtered.length * rowHeight } : undefined}>{visibleRows.map(({ item, index }) => { const category = item.localOnly ? 'Agent' : chatTypeLabel(item.chatType); const title = item.title || conversationFallbackTitle(item.chatType); return <button key={keyOf(item)} data-row-index={index} style={virtual ? { position: 'absolute', top: index * rowHeight, height: rowHeight } : undefined} className={keyOf(item) === (selected ?? keyOf(conversation ?? item)) ? 'conversation-row selected' : 'conversation-row'} onClick={() => { onSelect(keyOf(item)); setListOpen(false); }} onFocus={() => setFocusedRow(keyOf(item))} onBlur={() => { if (focusedRow === keyOf(item)) setFocusedRow(null); }} onKeyDown={(event) => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault(); const nextIndex = Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); listNode.current?.scrollTo({ top: nextIndex * rowHeight }); setListTop(nextIndex * rowHeight); requestAnimationFrame(() => listNode.current?.querySelector<HTMLButtonElement>(`[data-row-index="${nextIndex}"]`)?.focus()); }} aria-setsize={filtered.length} aria-posinset={index + 1} aria-label={`${title} ${category}`}>
        <AvatarWithTypeBadge chatType={item.localOnly ? undefined : item.chatType}>{item.localOnly ? <AvatarPlaceholder kind="person" className="conversation-avatar" /> : <LineMediaImage api={api} enabled={item.avatarAvailable === true} target={{ type: 'conversation', accountId: item.accountId, chatType: item.chatType, chatId: item.chatId }} fallbackKind={item.chatType === 'direct' ? 'person' : 'group'} className="conversation-avatar" />}</AvatarWithTypeBadge>
        <span className="conversation-copy">
          <span className="conversation-title-line"><strong>{title}</strong><ConversationTime timestamp={item.latestMessageAt} /></span>
          <span className="list-row-sub">{(() => { const preview = item.localOnly ? desktopText('chatWithArg0', { arg0: item.defaultProvider === 'codex' ? 'Codex' : 'Claude' }) : generatedPreviewFor(locale, item.latestMessageDisplay, item.latestMessagePreview).trim() || (item.latestAttachmentStatus ? desktopText('attachments') : desktopText('noMessagesYet')); return <ListPreview api={api} chat={item.localOnly ? null : item} preview={preview} />; })()}{item.unreadCount > 0 && <b className="unread" aria-label={desktopText('arg0Unread', { arg0: item.unreadCount })}>{unreadBadgeText(item.unreadCount)}</b>}</span>
        </span>
      </button>; })}{!filtered.length && <p className="empty">{desktopText('noMessagesYetAfterLineLoginNewMessagesAre')}</p>}</div></div>}
    </section>
    <section className="chat-panel" id="active-chat-panel"><button className="mobile-list-toggle" onClick={() => setListOpen(!listOpen)}>{desktopText('chatList')}</button>
      {route && account ? <>
        <header className={`chat-header line-chat-header route-${account.mode}`} data-testid="address-plate"><div className="chat-title-wrap"><AvatarWithTypeBadge chatType={route.chatType}><LineMediaImage api={api} enabled={conversation!.avatarAvailable === true} target={{ type: 'conversation', accountId: route.accountId, chatType: route.chatType, chatId: route.chatId }} fallbackKind={route.chatType === 'direct' ? 'person' : 'group'} className="chat-conversation-avatar" /></AvatarWithTypeBadge><h2>{conversation!.title || conversationFallbackTitle(route.chatType)}</h2></div><div className="chat-header-meta"><div className={`agent-trigger-status ${conversation!.agentEnabled ? 'enabled' : 'disabled'}`} role="status">{desktopText('agentTrigger')}{conversation!.agentEnabled ? desktopText('enabled') : desktopText('disabled')}</div><ChatResources key={`${routeKey}:${account.mode}:${account.status}`} api={api as DesktopApi & ChatResourceApi} route={route} accountStatus={account.status} accountMode={account.mode} /></div></header>
        <div className="timeline-frame">
        <div className="timeline" id="timeline" tabIndex={-1} ref={timeline} onScroll={(event) => {
          const own = pinTop.current !== null && Math.abs(event.currentTarget.scrollTop - pinTop.current) < 1;
          if (!own) { pinTop.current = null; nearBottom.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight <= 40; }
          handleTimelineScroll();
        }}>
          <div className="timeline-content" ref={timelineContent}>
          {loadingOlder && <p className="older-loading muted" role="status">{desktopText('loading251')}</p>}
          {!messages.length && <p className="empty">{account.status === 'connected' ? desktopText('noMessagesYetAfterLineLoginNewMessagesAre') : desktopText('noMessagesForThisChatInTheDatabase')}</p>}
          {visibleMessages.map((message, index) => {
            const previous = visibleMessages[index - 1];
            const quoted = message.replyTo;
            const recalledOriginal = message.deleted && hasRecalledOriginal(message);
            // A recalled row keeps `unsent` as its content; show the preserved original through the normal renderers.
            const shown = recalledOriginal && message.content?.type === 'unsent' ? { ...message, content: message.recalledContent ?? null, kind: message.recalledKind ?? message.kind } : message;
            const senderNotification = message.content?.type === 'event' && message.content.nativeContentType === 16
              && (message.postNotificationType === 'note' || message.postNotificationType === 'album');
            const systemLike = message.content?.type === 'event' && !senderNotification;
            const quotedSenderName = quoted && quoted.senderName === quoted.senderId
              ? quoted.direction === 'outbound' ? desktopText('me') : desktopText('otherPerson') : quoted?.senderName;
            const dateChanged = !previous || previous.occurredAt.slice(0, 10) !== message.occurredAt.slice(0, 10);
            const gapMs = previous ? Date.parse(message.occurredAt) - Date.parse(previous.occurredAt) : Number.NaN;
            const runStart = !previous || dateChanged || previous.direction !== message.direction || previous.senderId !== message.senderId
              || new Date(previous.occurredAt).toDateString() !== new Date(message.occurredAt).toDateString()
              || previous.content?.type === 'event' || systemLike || !(gapMs >= 0 && gapMs <= RUN_GAP_MS);
            const isEvent = systemLike;
            const showIdentity = message.direction === 'inbound' && runStart && !isEvent;
            const showSenderName = showIdentity && route.chatType !== 'direct';
            // Media, stickers, cards and system events sit on the pane without a coloured bubble.
            const sticons = message.text === null ? [] : validSticonRanges(message.text, message.sticonRanges);
            const bareSticons = (!shown.content || recalledOriginal) && message.text !== null && sticonOnly(message.text, sticons);
            const bare = (bareSticons || shown.kind === 'sticker' || (!senderNotification && shown.content !== undefined && shown.content !== null && BARE_CONTENT_TYPES.has(shown.content.type))
              || (message.attachments.length > 0 && !message.text?.trim() && (!message.content || message.content.type === 'media')));
            const bubbleTail = runStart && !bare;
            const recalledMarker = message.deleted
              ? <span className="message-recalled-label">{recalledOriginal ? recalledMarkerLabel(message, locale) : desktopText('arg0NoData', { arg0: recalledMarkerLabel(message, locale) })}</span>
              : null;
            return <React.Fragment key={`${message.accountId}/${message.messageId}`}>
            {dateChanged && <div className="date-separator">{new Date(message.occurredAt).toLocaleDateString(locale)}</div>}
            <div className={`message-row ${message.direction} ${route.chatType}${showIdentity ? ' has-inbound-identity' : ''}${showSenderName ? ' has-sender-name' : ''}${runStart ? ' run-start' : ' run-cont'}${message.reactions?.length ? ' has-reactions' : ''}`} data-message-date={message.occurredAt}
              onContextMenu={(event) => {
                if (account?.canSendManually !== true) { event.preventDefault(); setUnsendMenu(null); return; }
                if (!canShowUnsend(message)) return;
                event.preventDefault(); setUnsendMenu({ messageId: message.messageId, x: event.clientX, y: event.clientY, routeKey });
              }}>
              {message.direction === 'inbound' && !isEvent && (showIdentity
                ? <div className="message-identity"><LineMediaImage api={api} enabled={route.chatType === 'direct' ? conversation!.avatarAvailable === true : message.senderAvatarAvailable === true}
                  target={route.chatType === 'direct' ? { type: 'conversation', accountId: route.accountId, chatType: route.chatType, chatId: route.chatId }
                    : { type: 'member', accountId: route.accountId, chatType: route.chatType, chatId: route.chatId, memberId: message.senderId }}
                  fallbackKind="person" className="sender-avatar" />{route.chatType !== 'direct' && <span className="message-sender-name">{message.senderName === message.senderId ? desktopText('otherPerson') : message.senderName}</span>}</div>
                : <div className="inbound-avatar-spacer" aria-hidden="true" />)}
              <article className={`message ${message.direction}${message.kind === 'sticker' ? ' sticker-message' : ''}${systemLike ? ' system-event-message' : ''}${bare ? ' bubble-bare' : ''}${bubbleTail ? ' bubble-tail' : ''}`} tabIndex={0} id={`message-${message.messageId}`}>
                {message.replyToMessageId && <button className="reply-reference" title={generatedPreviewFor(locale, quoted?.display, quoted?.preview) || desktopText('quotedMessage')}
                  aria-label={quoted ? desktopText('replyToArg0Arg1', { arg0: quotedSenderName, arg1: generatedPreviewFor(locale, quoted.display, quoted.preview) }) : desktopText('quotedMessage')}
                  onClick={() => document.getElementById(`message-${quoted?.messageId ?? message.replyToMessageId}`)?.scrollIntoView({ block: 'center' })}>
                  {quoted ? <>
                    {route.chatType !== 'direct' && <LineMediaImage api={api} enabled={quoted.senderAvatarAvailable}
                      target={quoted.direction === 'outbound' ? { type: 'account', accountId: route.accountId }
                        : { type: 'member', accountId: route.accountId, chatType: route.chatType, chatId: route.chatId, memberId: quoted.senderId }}
                      fallbackKind="person" className="reply-reference-avatar" />}
                    <span className="reply-reference-copy"><strong>{quotedSenderName}</strong>
                      <span className="reply-reference-preview" title={generatedPreviewFor(locale, quoted.display, quoted.preview)}>{generatedPreviewFor(locale, quoted.display, quoted.preview)}</span></span>
                  </> : <span className="reply-reference-placeholder">{desktopText('quotedMessage')}</span>}
                </button>}
                {message.deleted && !recalledOriginal ? null
                  : <>{(!shown.content || recalledOriginal) && message.text !== null && <div className={`message-text${bareSticons ? ' message-text-sticon-only' : ''}`}>{sticons.length
                    ? renderTextWithSticons(message.text, openMessageUrl, message.mentionRanges, sticons, api, message, bareSticons)
                    : renderMessageText(message.text, openMessageUrl, message.mentionRanges)}</div>}
                    {shown.content?.type === 'contact' && <div className="message-content-card contact-content-card"><AvatarPlaceholder kind="person" className="content-contact-avatar" /><strong>{shown.content.displayName ?? desktopText('sharedLineContact')}</strong>{shown.content.displayName !== null && <span>{desktopText('lineContact')}</span>}</div>}
                    {shown.content?.type === 'location' && <div className="message-content-card location-content-card"><PinIcon /><strong>{shown.content.title || message.text || desktopText('location')}</strong>{shown.content.address && <span>{shown.content.address}</span>}</div>}
                    {shown.content?.type === 'rich' && <div className="message-content-card rich-content-card">{shown.content.altText || desktopText('richMessage')}</div>}
                {shown.content?.type === 'event' && (senderNotification ? <div className="message-text">{systemEventLabel(locale, shown.content.nativeContentType, shown.content.text, shown.postNotificationType)}</div> : <div className="message-system-event">{shown.content.nativeContentType === 6 && shown.content.call
                      ? formatCallLabelFor(locale, shown.content.call, message.direction, shown.content.nativeContentType, shown.content.text)
                  : systemEventLabel(locale, shown.content.nativeContentType, shown.content.text, shown.postNotificationType)}</div>)}
                    {shown.content?.type === 'unsupported' && <div className="message-content-card unsupported-content-card">{shown.content.fallbackText || desktopText('unsupportedMessageTypeArg0', { arg0: shown.content.nativeContentType ?? '?' })}</div>}
                    {!shown.content && shown.kind === 'contact' && !message.text?.trim() && <div className="message-text contact-placeholder">{desktopText('sharedLineContact')}</div>}
                    {shown.kind === 'sticker' && (!message.deleted || recalledOriginal) && <div className="message-sticker">
                      {message.sticker
                        ? <LineMediaImage api={api} enabled target={{ type: 'sticker', accountId: message.accountId,
                          chatType: message.chatType, chatId: message.chatId, messageId: message.messageId }}
                          fallback={stickerLabel(locale, message.sticker.altText)}
                          accessibleFallback className="sticker-image" alt={message.sticker.altText || desktopText('lineSticker')} />
                        : <span className="sticker-fallback" role="img" aria-label={desktopText('sticker')}>{desktopText('sticker')}</span>}
                    </div>}</>}
                {(!message.deleted || recalledOriginal) && message.attachments.filter((attachment) => !message.deleted || attachment.status === 'ready').map((attachment) => <div className={`attachment-wrap${attachment.status === 'ready' ? ' ready' : ''}`} key={attachment.id}>
                  {attachment.kind === 'image' && attachment.status === 'ready' && <LineMediaImage api={api} enabled attachment={{ key: route, attachmentId: attachment.id }} fallback={desktopText('imagePreviewUnavailable')} className="inline-attachment-image" alt={attachment.name || desktopText('imageAttachment')} />}
                  {attachment.kind === 'image' && attachment.status === 'ready'
                    ? null
                    : <FileAttachmentCard attachment={{ ...attachment, durationMs: message.content?.type === 'media' ? message.content.durationMs : null, canRetryManually: attachment.canRetryManually === true && writableRoute !== null }} accountConnected={account.status === 'connected'} api={api}
                      onDownload={() => void downloadAttachment(attachment.id)} onOpen={() => void openAttachment(attachment.id)} showOpenAction={false} />}
                </div>)}
              </article>
              <div className="message-trailing-meta">
                {(message.attachments.some((attachment) => attachment.status === 'ready') || canSendLine) && <div className="message-actions">
                  {message.attachments.filter((attachment) => attachment.status === 'ready').map((attachment) => <button key={attachment.id} className="reply-action" onClick={() => void openAttachment(attachment.id)}>{desktopText('open')}</button>)}
                  {canSendLine && <button className="reply-action" disabled={message.direction === 'outbound'} onClick={() => chooseReply(message)}>{desktopText('reply')}</button>}
                </div>}
                <div className="message-meta">
                  {message.direction === 'outbound' && message.readCount !== undefined && message.readCount > 0 && !isEvent
                    ? <MessageReadReceipt api={api} route={route} messageId={message.messageId} count={message.readCount} /> : null}
                  {recalledMarker}<time className="message-time" dateTime={message.occurredAt}>{formatMessageTime(message.occurredAt)}</time>
                </div>
              </div>
              {message.reactions && message.reactions.length > 0 && <MessageReactions api={api} message={message} />}
              {message.agentJobStatus && <AgentStatusMarker status={message.agentJobStatus} />}
            </div>
          </React.Fragment>;
          })}
          {sendFeedback.filter((entry) => entry.routeKey === routeKey).map((entry) => <div className="message-row outbound run-cont" key={`local-send-${entry.id}`}>
            <time className="message-time" dateTime={entry.createdAt}>{formatMessageTime(entry.createdAt)}</time>
            <article className={`message outbound local-send-feedback ${entry.status}`}>
              <div className="message-text">{renderMessageText(entry.text, openMessageUrl)}</div>
              {entry.status === 'pending' && <p role="status">{desktopText('sending')}</p>}
              {entry.status === 'failed' && <div className="send-feedback-status"><span role="status">{desktopText('sendFailed')}</span><button disabled={!canSendLine} aria-label={desktopText('resendMessage')} title={desktopText('resendMessage')} onClick={() => void retryFeedback(entry)}>↻</button></div>}
              {entry.status === 'unknown' && <p role="status">{desktopText('lineDeliveryIsUncertainCheckTheConversationFirst')}</p>}
            </article>
          </div>)}
          </div>
        </div>
        {visibleMessageDate && messages.length > 0 && <div className="visible-message-date" aria-hidden="true">{formatVisibleMessageDate(visibleMessageDate, new Date(), locale)}</div>}
        {unsendMenu?.routeKey === routeKey && <div role="menu" className="message-context-menu" style={{ position: 'fixed', left: unsendMenu.x, top: unsendMenu.y, zIndex: 60 }} onContextMenu={(event) => event.preventDefault()}>
          <button type="button" role="menuitem" disabled={unsendBusy} onClick={() => void runUnsend()}>{unsendBusy ? desktopText('processing160') : desktopText('unsendMessage')}</button>
          <button type="button" role="menuitem" onClick={() => setUnsendMenu(null)}>{desktopText('cancel')}</button>
        </div>}
        {(farFromBottom || hasNewerLoaded || newCount > 0) && <button className="latest-button" aria-label={newCount > 0 ? desktopText('jumpToLatestMessageArg0NewMessages', { arg0: newCount }) : desktopText('jumpToLatestMessage')} onClick={jumpToLatest}><span aria-hidden="true">↓</span> {newCount > 0 ? desktopText('arg0NewMessages', { arg0: newCount }) : desktopText('latestMessage')}</button>}
        </div>
        {canSendLine ? <div className={`composer route-${account.mode}`} id="composer" tabIndex={-1}>
          {reply && <div className="reply-preview"><LineMediaImage api={api} enabled={reply.senderAvatarAvailable === true} target={reply.direction === 'outbound' ? { type: 'account', accountId: reply.accountId } : { type: 'member', accountId: route.accountId, chatType: route.chatType, chatId: route.chatId, memberId: reply.senderId }} fallbackKind="person" className="reply-avatar" /><span className="reply-copy"><strong className="reply-name">{replyName}</strong><span className="reply-quote">{renderMessageText(replyContent, openMessageUrl, replyMentionRanges)}</span></span><button className="reply-cancel" aria-label={desktopText('cancelReply')} onClick={() => chooseReply(null)}><span aria-hidden="true">×</span></button></div>}
          <label className="sr-only" htmlFor="line-draft">{desktopText('lineMessage')}</label><textarea id="line-draft" className={fileDragActive ? 'composer-drop-active' : undefined} aria-label={desktopText('lineMessage')} value={lineDraft} onChange={(event) => { draftRevisions.current[lineRevisionKey] = (draftRevisions.current[lineRevisionKey] ?? 0) + 1; setLineDrafts((drafts) => ({ ...drafts, [routeKey]: event.target.value })); }} onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void submit(); } }} onDragOver={(event) => { if (!canAttachMedia || !Array.from(event.dataTransfer.types).includes('Files')) return; event.preventDefault(); setFileDragActive(true); }} onDragLeave={() => setFileDragActive(false)} onDrop={(event) => { if (!canAttachMedia) return; event.preventDefault(); setFileDragActive(false); addManualFiles(Array.from(event.dataTransfer.files)); }} placeholder={desktopText('enterAMessageToSendToLine')} />
          {routeFiles.length > 0 && <ul className="manual-media-chips" aria-label={desktopText('pendingAttachments')}>{routeFiles.map(({ id: fileId, file }) => <li key={fileId}><span aria-hidden="true">{file.type.startsWith('image/') ? '▧' : '▤'}</span><span title={file.name}>{file.name}</span><small>{new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(file.size / (1024 * 1024))} MB</small><button type="button" aria-label={desktopText('removeArg0', { arg0: file.name })} disabled={sending} onClick={() => removeManualFile(fileId)}>×</button></li>)}</ul>}
          <div className="composer-actions"><span className="composer-actions-hint">{desktopText('ctrlEnterToSendEnterForANewLine')}</span><ComposerStatus message={composerStatus ?? accountComposerStatus(account, coreReady, locale)} onDismiss={clearComposerStatus} />{showCoreWarning && <span className="health bad" role="status">{desktopText('coreFeaturesNeedAttention')}</span>}{route?.chatType === 'room' && <span className="muted" role="status">{desktopText('mediaSendingRequiresDirectOrGroupChat')}</span>}<input ref={manualFileInput} className="sr-only" type="file" multiple data-testid="line-media-file-input" aria-label={desktopText('attachFiles')} onChange={(event) => { addManualFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} /><button type="button" className="attach-button" aria-label={desktopText('attachFiles')} title={canAttachMedia ? desktopText('attachFiles') : desktopText('mediaSendingRequiresDirectOrGroupChat')} disabled={!canSendLine || !canAttachMedia || sending} onClick={() => manualFileInput.current?.click()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg></button><button className="primary" disabled={!canSendLine || (!lineDraft.trim() && routeFiles.length === 0) || sending} onClick={() => void submit()}>{sending ? desktopText('sending') : desktopText('sendToLine')}</button></div>
        </div> : <div className={`composer route-${account.mode}`}><div className="composer-actions"><ComposerStatus message={composerStatus ?? accountComposerStatus(account, coreReady, locale)} onDismiss={clearComposerStatus} />{showCoreWarning && <span className="health bad" role="status">{desktopText('coreFeaturesNeedAttention')}</span>}</div></div>}
      </> : <div className="empty-screen"><h2>{desktopText('selectAChat')}</h2><p>{desktopText('messagesAppearHereAfterAnAccountLogsIn')}</p></div>}
    </section>
  </div>;
}
