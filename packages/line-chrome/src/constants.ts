// Constants of the LINE Chrome extension (CHROMEOS) transport.
// Ported from OkLine okline/endpoints.py:22-45 and okline/transport.py:75-90,165-177 (MIT).

/** The one place the extension version lives. Used for the X-Line-Chrome-Version header, the SSE `version` query
 * parameter, the X-Hmac key derivation and the X-Line-Application OBS header. */
export const CHROME_EXTENSION_VERSION = '3.7.2';

/** Chrome Web Store id of the LINE extension. */
export const CHROME_EXTENSION_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc';

/** Origin the ltsm bridge presents (OkLine okline/ltsm/ltsm_bridge.js). */
export const CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;

/** Gateway that fronts every Thrift service (OkLine endpoints.py:22). */
export const GATEWAY_BASE_URL = 'https://line-chrome-gw.line-apps.com';
/** Object storage (media upload and download) (OkLine endpoints.py:29). */
export const OBS_BASE_URL = 'https://obs.line-apps.com';

/** LEGY edge hosts (OkLine endpoints.py:25-26). Listed for completeness; no step uses them. */
export const LEGY_BASE_URL = 'https://legy-jp.line-apps.com';
export const LEGY_BACKUP_BASE_URL = 'https://legy-backup.line-apps.com';

/** `cdn` key to base URL for OBS downloads (OkLine endpoints.py:31-45). `obs` is the default host. */
export const OBS_HOSTS = {
  obs: OBS_BASE_URL,
  cdn_obs: 'https://obs.line-scdn.net',
  cdn_profile: 'https://profile.line-scdn.net',
  cdn_sticker: 'https://stickershop.line-scdn.net',
  cdn_shop: 'https://shop.line-scdn.net',
} as const;

/**
 * Synthetic CrOS Chrome/124 user agent (OkLine transport.py:87-90). The real extension never sets a UA (the browser
 * does), so this is an invented-but-plausible fingerprint kept identical to OkLine.
 */
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const APP_NAME = 'CHROMEOS';
export const APP_OS_NAME = 'Chrome_OS';

/**
 * `X-Line-Application` value. The extension sends it ONLY on private OBS resource fetches, never on gateway RPCs
 * (OkLine transport.py:78-83). The trailing tab is intentional: LINE parses `APP_TYPE \t APP_VER \t OS_NAME \t OS_VER`.
 */
export const OBS_APPLICATION_HEADER = `${APP_NAME}\t${CHROME_EXTENSION_VERSION}\t${APP_OS_NAME}\t`;

export const DEFAULT_LOCALE = 'en-US';

/** Accept-Language to X-LAL (underscore form), from the bundle's `Up` map (OkLine transport.py:165-177). */
export const LAL_MAP: Readonly<Record<string, string>> = {
  'en-US': 'en_US',
  'ja-JP': 'ja_JP',
  'ko-KR': 'ko_KR',
  'zh-CN': 'zh_CN',
  'zh-TW': 'zh_TW',
  'th-TH': 'th_TH',
  'tr-TR': 'tr_TR',
  'ru-RU': 'ru_RU',
  'id-ID': 'id_ID',
  'es-419': 'es_419',
  'es-ES': 'es_ES',
};

/** X-LAL for a locale; unknown locales fall back to `en_US` as OkLine does (`_LAL_MAP.get(locale, "en_US")`). */
export function lalForLocale(locale: string): string {
  return LAL_MAP[locale] ?? 'en_US';
}

/** OkLine `LineConfig` defaults (transport.py:118-140). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_READ_RETRIES = 2;
