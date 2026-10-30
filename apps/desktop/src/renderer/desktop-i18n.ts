import { useCallback } from 'react';
import { ENGLISH_DESKTOP_COPY, TRADITIONAL_CHINESE_DESKTOP_COPY } from '../desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART1 } from '../desktop-copy-ja-part1.js';
import { JAPANESE_DESKTOP_COPY_PART2 } from '../desktop-copy-ja-part2.js';
import { JAPANESE_DESKTOP_COPY_PART3 } from '../desktop-copy-ja-part3.js';
import { JAPANESE_DESKTOP_COPY_PART4 } from '../desktop-copy-ja-part4.js';
import { JAPANESE_DESKTOP_COPY_PART5 } from '../desktop-copy-ja-part5.js';
import { JAPANESE_DESKTOP_COPY_PART6 } from '../desktop-copy-ja-part6.js';
import { JAPANESE_DESKTOP_COPY_PART7 } from '../desktop-copy-ja-part7.js';
import { JAPANESE_DESKTOP_COPY_PART8 } from '../desktop-copy-ja-part8.js';
import { JAPANESE_DESKTOP_COPY_PART9 } from '../desktop-copy-ja-part9.js';
import { KOREAN_DESKTOP_COPY_PART1 } from '../desktop-copy-ko-part1.js';
import { KOREAN_DESKTOP_COPY_PART2 } from '../desktop-copy-ko-part2.js';
import { KOREAN_DESKTOP_COPY_PART3 } from '../desktop-copy-ko-part3.js';
import { KOREAN_DESKTOP_COPY_PART4 } from '../desktop-copy-ko-part4.js';
import { KOREAN_DESKTOP_COPY_PART5 } from '../desktop-copy-ko-part5.js';
import { KOREAN_DESKTOP_COPY_PART6 } from '../desktop-copy-ko-part6.js';
import { KOREAN_DESKTOP_COPY_PART7 } from '../desktop-copy-ko-part7.js';
import { KOREAN_DESKTOP_COPY_PART8 } from '../desktop-copy-ko-part8.js';
import { KOREAN_DESKTOP_COPY_PART9 } from '../desktop-copy-ko-part9.js';
import type { Locale } from '../locale.js';
import type { AttachmentBlockReason, GeneratedPreview } from '@line-agent/contracts';
import { EXTRA_DESKTOP_COPY, EXTRA_TRADITIONAL_COPY, EXTRA_JAPANESE_COPY, EXTRA_KOREAN_COPY, SYSTEM_DISPLAY_COPY, SYSTEM_LABELS } from '../desktop-system-copy.js';
import { DESKTOP_ERROR_COPY, desktopErrorText } from '../desktop-error-copy.js';
import { lineServerErrorText } from './line-server-error-copy.js';
import { localeFromState, useLocale } from './locale-context.js';

export type DesktopCopyKey = keyof typeof ENGLISH_DESKTOP_COPY;
type Slots<S extends string> = S extends `${string}{${infer K}}${infer Rest}` ? K | Slots<Rest> : never;
type Arguments<K extends DesktopCopyKey> = [Slots<(typeof ENGLISH_DESKTOP_COPY)[K]>] extends [never]
  ? [] : [values: Record<Slots<(typeof ENGLISH_DESKTOP_COPY)[K]>, unknown>];
type PlainCopyKey = { [K in DesktopCopyKey]: Slots<(typeof ENGLISH_DESKTOP_COPY)[K]> extends never ? K : never }[DesktopCopyKey];
export const JAPANESE_DESKTOP_COPY = { ...JAPANESE_DESKTOP_COPY_PART1, ...JAPANESE_DESKTOP_COPY_PART2, ...JAPANESE_DESKTOP_COPY_PART3, ...JAPANESE_DESKTOP_COPY_PART4, ...JAPANESE_DESKTOP_COPY_PART5, ...JAPANESE_DESKTOP_COPY_PART6, ...JAPANESE_DESKTOP_COPY_PART7, ...JAPANESE_DESKTOP_COPY_PART8, ...JAPANESE_DESKTOP_COPY_PART9 } as Record<keyof typeof ENGLISH_DESKTOP_COPY, string>;
export const KOREAN_DESKTOP_COPY = { ...KOREAN_DESKTOP_COPY_PART1, ...KOREAN_DESKTOP_COPY_PART2, ...KOREAN_DESKTOP_COPY_PART3, ...KOREAN_DESKTOP_COPY_PART4, ...KOREAN_DESKTOP_COPY_PART5, ...KOREAN_DESKTOP_COPY_PART6, ...KOREAN_DESKTOP_COPY_PART7, ...KOREAN_DESKTOP_COPY_PART8, ...KOREAN_DESKTOP_COPY_PART9 } as Record<keyof typeof ENGLISH_DESKTOP_COPY, string>;
type CopyTable = typeof ENGLISH_DESKTOP_COPY | typeof TRADITIONAL_CHINESE_DESKTOP_COPY | typeof JAPANESE_DESKTOP_COPY | typeof KOREAN_DESKTOP_COPY;

/** Pure lookup against the immutable startup locale supplied by the caller. */
export function desktopTextFor<K extends DesktopCopyKey>(locale: Locale, key: K, ...args: Arguments<K>): string {
  const catalogs: Record<Locale, CopyTable> = { en: ENGLISH_DESKTOP_COPY, 'zh-TW': TRADITIONAL_CHINESE_DESKTOP_COPY, ja: JAPANESE_DESKTOP_COPY, ko: KOREAN_DESKTOP_COPY };
  const catalog = catalogs[locale] ?? ENGLISH_DESKTOP_COPY;
  const template = catalog[key];
  const values = args[0] as Record<string, unknown> | undefined;
  return template.replace(/\{(arg\d+)\}/g, (slot, name: string) => {
    const value = values?.[name];
    return typeof value === 'number' || typeof value === 'bigint' ? new Intl.NumberFormat(locale).format(value) : String(value ?? slot);
  });
}

export function useDesktopLocale(): Locale { return localeFromState(useLocale()); }
/** @deprecated Temporary English fallback shim for unmigrated pages. */
export function desktopLocale(): Locale { return 'en'; }
export function useDesktopText() {
  const locale = useDesktopLocale();
  return useCallback(<K extends DesktopCopyKey>(key: K, ...args: Arguments<K>) => desktopTextFor(locale, key, ...args), [locale]);
}

/** @deprecated Temporary compile shim for unmigrated pages; always resolves English. */
export function desktopText<K extends DesktopCopyKey>(key: K, ...args: Arguments<K>): string {
  return desktopTextFor('en', key, ...args);
}

/** Finite machine codes choose copy; backend prose, paths and stacks never become UI text. */
export function safeErrorTextFor(locale: Locale, error: unknown, fallback?: string): string {
  const serverErrorCode = typeof error === 'object' && error !== null
    ? (error as { serverErrorCode?: unknown }).serverErrorCode : undefined;
  const serverText = lineServerErrorText(locale, serverErrorCode);
  if (serverText) return serverText;
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown; errorCode?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode : error;
  if (code === 'AUTORESPONDER_VERSION_CONFLICT') return desktopTextFor(locale, 'settingsChangedElsewhereAndHaveBeenReloaded');
  const errorCopy = desktopErrorText(locale, code);
  if (errorCopy) return errorCopy;
  const keys: Record<string, PlainCopyKey> = {
    EXTERNAL_MONITOR_READ_ONLY: 'agentJobsCannotBeCreatedInExternalMonitoringMode', PERMISSION_VERSION_CONFLICT: 'settingsChangedElsewhereAndHaveBeenReloaded',
    AGENT_ACCOUNT_REQUIRED: 'logInToTheAgentAccountFirst', PRIMARY_ADMIN_ALREADY_BOUND: 'aPrimaryAdministratorIsAlreadyConfigured',
    EXTERNAL_IMPORT_BUSY: 'lineIsBeingReadTryAgainShortly', OFFICIAL_IDENTITY_UNAVAILABLE: 'unableToReadTheCurrentLineAccountOpenLine',
    OFFICIAL_IDENTITY_CHANGED: 'theCurrentLineAccountChangedTryAgain', ADMIN_SLOT_CONFLICT: 'theCurrentLineAccountCannotBeThePrimaryAdministrator',
    QUEUE_FULL: 'lineWorkerQueueFull', AUTH_INVALIDATED: 'lineLoginIsNoLongerValid', ATTACHMENT_EXPIRED: 'attachmentExpired',
    PERMISSION_TARGET_NOT_ELIGIBLE: 'thisChatOrAllowlistedUserIsNoLongerEligible', INVALID_CHAT: 'thisChatOrAllowlistedUserIsNoLongerEligible',
  };
  const key = typeof code === 'string' && Object.hasOwn(keys, code) ? keys[code] : undefined;
  return key ? desktopTextFor(locale, key) : fallback ?? extraTextFor(locale, 'operationFailed');
}
export function useSafeErrorText() {
  const locale = useDesktopLocale();
  return useCallback((error: unknown, fallback?: string) => safeErrorTextFor(locale, error, fallback), [locale]);
}
/** @deprecated Temporary English fallback shim for unmigrated pages. */
export function safeErrorText(error: unknown, fallback?: string): string { return safeErrorTextFor('en', error, fallback); }

export function systemLabelFor(locale: Locale, value: keyof typeof SYSTEM_DISPLAY_COPY): string {
  return SYSTEM_LABELS[locale]?.[value] ?? SYSTEM_DISPLAY_COPY[value];
}
export function extraTextFor(locale: Locale, key: keyof typeof EXTRA_DESKTOP_COPY): string {
  const catalogs = { en: EXTRA_DESKTOP_COPY, 'zh-TW': EXTRA_TRADITIONAL_COPY, ja: EXTRA_JAPANESE_COPY, ko: EXTRA_KOREAN_COPY };
  return catalogs[locale]?.[key] ?? EXTRA_DESKTOP_COPY[key];
}
export function useSystemLabel() {
  const locale = useDesktopLocale();
  return useCallback((value: keyof typeof SYSTEM_DISPLAY_COPY) => systemLabelFor(locale, value), [locale]);
}
export function useExtraText() {
  const locale = useDesktopLocale();
  return useCallback((key: keyof typeof EXTRA_DESKTOP_COPY) => extraTextFor(locale, key), [locale]);
}
/** @deprecated Temporary English fallback shim for unmigrated pages. */
export function systemLabel(value: keyof typeof SYSTEM_DISPLAY_COPY): string { return systemLabelFor('en', value); }
export function extraText(key: keyof typeof EXTRA_DESKTOP_COPY): string { return extraTextFor('en', key); }

/** Transient composed messages are preserved verbatim until callers migrate to typed keys. */
export function generatedMessageText(message: string): string { return message; }

export function jobStatusLabelFor(locale: Locale, status: string): string {
  const keys = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
  const key = keys.find((candidate) => candidate === status);
  return key ? extraTextFor(locale, key) : desktopTextFor(locale, 'unknown');
}
export function useJobStatusLabel() {
  const locale = useDesktopLocale();
  return useCallback((status: string) => jobStatusLabelFor(locale, status), [locale]);
}
/** @deprecated Temporary English fallback shim for unmigrated pages. */
export function jobStatusLabel(status: string): string { return jobStatusLabelFor('en', status); }

const PREVIEW_KEYS: Record<GeneratedPreview['kind'], PlainCopyKey> = {
  deleted: 'deleted', unsent: 'thisMessageWasUnsent', image: 'image', video: 'video', audio: 'voice', file: 'file730',
  sticker: 'sticker', contact: 'lineContact', location: 'location', rich: 'richMessage', unsupported: 'messageContent',
  call: 'call', gift: 'gift', post: 'postNotification', post_note: 'postNoteNotification', post_album: 'postAlbumNotification', chat_event: 'chatEvent', system: 'systemMessage', message: 'messageContent',
};
/** Copy key of the cause text for a queued attachment that cannot download now. */
export function attachmentBlockReasonKey(reason: AttachmentBlockReason): PlainCopyKey {
  return reason === 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' ? 'attachmentBlockExternalSource'
    : reason === 'ATTACHMENT_WORKER_UNAVAILABLE' ? 'attachmentBlockWorkerUnavailable' : 'attachmentBlockWorkerNotReady';
}

/** Call text shared by the chat timeline and the chat-list preview: same wording and duration format in every locale. */
export function callSummaryFor(locale: Locale, call: { media: 'audio' | 'video' | null; result: string | null; durationMs: number | null },
  direction: 'inbound' | 'outbound'): string {
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

export function generatedPreviewFor(locale: Locale, display: GeneratedPreview | undefined, original: string | null | undefined): string {
  if (!display) return original ?? '';
  if (display.kind === 'call' && display.call) return callSummaryFor(locale, display.call, display.call.direction);
  const label = display.name || desktopTextFor(locale, PREVIEW_KEYS[display.kind]);
  const statuses: Record<NonNullable<GeneratedPreview['status']>, PlainCopyKey | null> = {
    queued: 'notDownloaded', downloading: 'downloading', ready: null, failed: 'downloadFailed', expired: 'attachmentExpired',
  };
  const status = display.status === 'queued' && display.blockReason ? attachmentBlockReasonKey(display.blockReason)
    : display.status ? statuses[display.status] : null;
  return status ? `${label} (${desktopTextFor(locale, status)})` : label;
}
export function useGeneratedPreview() {
  const locale = useDesktopLocale();
  return useCallback((display: GeneratedPreview | undefined, original: string | null | undefined) => generatedPreviewFor(locale, display, original), [locale]);
}
/** @deprecated Temporary English fallback shim for unmigrated pages. */
export function generatedPreview(display: GeneratedPreview | undefined, original: string | null | undefined): string {
  return generatedPreviewFor('en', display, original);
}

export function formatNumberFor(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
export function formatDateFor(locale: Locale, value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}
export function useLocaleFormatters() {
  const locale = useDesktopLocale();
  return {
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumberFor(locale, value, options),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => formatDateFor(locale, value, options),
  };
}
