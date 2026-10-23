import { z } from 'zod';

export const SUPPORTED_LOCALES = ['en', 'zh-TW', 'ja', 'ko'] as const;
export const LocaleSchema = z.enum(SUPPORTED_LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;
export const LocalePreferenceSchema = z.union([z.literal('automatic'), LocaleSchema]);
export type LocalePreference = z.infer<typeof LocalePreferenceSchema>;
export const LocaleSnapshotSchema = z.strictObject({ preference: LocalePreferenceSchema, effectiveLocale: LocaleSchema });
export type LocaleSnapshot = z.infer<typeof LocaleSnapshotSchema>;
export const LocaleRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getLocale') }),
  z.strictObject({ type: z.literal('setLocale'), preference: LocalePreferenceSchema }),
]);
export type LocaleRequest = z.infer<typeof LocaleRequestSchema>;

export function resolveSystemLocale(preferred: readonly string[]): Locale {
  for (const language of preferred) {
    const normalized = language.trim().replaceAll('_', '-').toLowerCase();
    if (/^zh-hant(?:-|$)/.test(normalized) || /^zh-(tw|hk|mo)(-|$)/.test(normalized)) return 'zh-TW';
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja';
    if (normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
  }
  return 'en';
}

export const MESSAGE_CATALOG = {
  en: { systemTitle: 'System Settings', language: 'Language', automatic: 'Automatic', english: 'English', traditionalChinese: '繁體中文', japanese: '日本語', korean: '한국어', effectiveLanguage: 'Current language', saveFailed: 'Unable to save language setting.', loadFailed: 'Unable to load language setting.', restartNeeded: 'Language saved. Restart the application to apply it.', restartChoice: 'Restart the application now to apply the saved language?', restartNow: 'Restart now', restartLater: 'Later', retry: 'Retry', loading: 'Loading language setting…' },
  'zh-TW': { systemTitle: '系統設定', language: '語言', automatic: '自動', english: 'English', traditionalChinese: '繁體中文', japanese: '日本語', korean: '한국어', effectiveLanguage: '目前語言', saveFailed: '無法儲存語言設定。', loadFailed: '無法載入語言設定。', restartNeeded: '語言設定已儲存。請重新啟動應用程式以套用。', restartChoice: '要立即重新啟動應用程式以套用已儲存的語言嗎？', restartNow: '立即重新啟動', restartLater: '稍後', retry: '重試', loading: '正在載入語言設定…' },
  ja: { systemTitle: 'システム設定', language: '言語', automatic: '自動', english: 'English', traditionalChinese: '繁體中文', japanese: '日本語', korean: '한국어', effectiveLanguage: '現在の言語', saveFailed: '言語設定を保存できません。', loadFailed: '言語設定を読み込めません。', restartNeeded: '言語設定を保存しました。適用するにはアプリを再起動してください。', restartChoice: '保存した言語を適用するため、今すぐアプリを再起動しますか？', restartNow: '今すぐ再起動', restartLater: '後で', retry: '再試行', loading: '言語設定を読み込み中…' },
  ko: { systemTitle: '시스템 설정', language: '언어', automatic: '자동', english: 'English', traditionalChinese: '繁體中文', japanese: '日本語', korean: '한국어', effectiveLanguage: '현재 언어', saveFailed: '언어 설정을 저장할 수 없습니다.', loadFailed: '언어 설정을 불러올 수 없습니다.', restartNeeded: '언어 설정을 저장했습니다. 적용하려면 앱을 다시 시작하세요.', restartChoice: '저장한 언어를 적용하려면 지금 앱을 다시 시작할까요?', restartNow: '지금 다시 시작', restartLater: '나중에', retry: '다시 시도', loading: '언어 설정을 불러오는 중…' },
} satisfies Record<Locale, Record<'systemTitle' | 'language' | 'automatic' | 'english' | 'traditionalChinese' | 'japanese' | 'korean' | 'effectiveLanguage' | 'saveFailed' | 'loadFailed' | 'restartNeeded' | 'restartChoice' | 'restartNow' | 'restartLater' | 'retry' | 'loading', string>>;
export type TranslationKey = keyof typeof MESSAGE_CATALOG.en;
export type SettingsMessage = TranslationKey;
export function translate(locale: Locale, key: TranslationKey): string { return MESSAGE_CATALOG[locale][key] ?? MESSAGE_CATALOG.en[key]; }
export const translateSettings = translate;
export function formatDate(locale: Locale, value: Date | number, options?: Intl.DateTimeFormatOptions): string { return new Intl.DateTimeFormat(locale, options).format(value); }
export function formatTime(locale: Locale, value: Date | number, options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }): string { return new Intl.DateTimeFormat(locale, options).format(value); }
export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(locale, options).format(value); }
