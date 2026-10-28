import type { Locale } from './locale.js';

/** Copy of the update check (Settings → About and the 設定 nav badge). Slots use the `{argN}` convention of the main catalog. */
export const ENGLISH_UPDATE_COPY = {
  autoCheck: 'Automatically check for updates',
  lastChecked: 'Last checked: {arg0}',
  neverChecked: 'Not checked yet',
  checkFailed: 'Check failed',
  checking: 'Checking…',
  latestVersion: 'Latest version {arg0}',
  goDownload: 'Go to download',
  checkNow: 'Check now',
  navUpdateSuffix: ' (update available)',
} as const;
export type UpdateCopyKey = keyof typeof ENGLISH_UPDATE_COPY;
type UpdateCopy = Record<UpdateCopyKey, string>;

export const TRADITIONAL_CHINESE_UPDATE_COPY: UpdateCopy = {
  autoCheck: '自動檢查更新',
  lastChecked: '上次檢查：{arg0}',
  neverChecked: '尚未檢查',
  checkFailed: '檢查失敗',
  checking: '檢查中…',
  latestVersion: '最新版本 {arg0}',
  goDownload: '前往下載',
  checkNow: '立即檢查',
  navUpdateSuffix: '（有可用更新）',
};

export const JAPANESE_UPDATE_COPY: UpdateCopy = {
  autoCheck: '更新を自動的に確認',
  lastChecked: '前回の確認：{arg0}',
  neverChecked: '未確認',
  checkFailed: '確認に失敗しました',
  checking: '確認中…',
  latestVersion: '最新バージョン {arg0}',
  goDownload: 'ダウンロードへ',
  checkNow: '今すぐ確認',
  navUpdateSuffix: '（更新あり）',
};

export const KOREAN_UPDATE_COPY: UpdateCopy = {
  autoCheck: '업데이트 자동 확인',
  lastChecked: '마지막 확인: {arg0}',
  neverChecked: '아직 확인하지 않음',
  checkFailed: '확인 실패',
  checking: '확인 중…',
  latestVersion: '최신 버전 {arg0}',
  goDownload: '다운로드로 이동',
  checkNow: '지금 확인',
  navUpdateSuffix: ' (업데이트 있음)',
};

export function updateTextFor(locale: Locale, key: UpdateCopyKey, values?: Record<string, unknown>): string {
  const catalogs: Record<Locale, UpdateCopy> = { en: ENGLISH_UPDATE_COPY, 'zh-TW': TRADITIONAL_CHINESE_UPDATE_COPY, ja: JAPANESE_UPDATE_COPY, ko: KOREAN_UPDATE_COPY };
  const template = (catalogs[locale] ?? ENGLISH_UPDATE_COPY)[key];
  return template.replace(/\{(arg\d+)\}/g, (slot, name: string) => String(values?.[name] ?? slot));
}
