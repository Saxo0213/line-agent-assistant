import { z } from 'zod';

/** Dedicated Main/renderer channels for the update check; it carries no LINE data and needs no database. */
export const UPDATE_CHECK_CHANNEL = 'line-agent:update-check';
export const UPDATE_CHECK_STATE_CHANNEL = 'line-agent:update-check-state';
/** The one public repository that both the release check and electron-updater read from. */
export const UPDATE_REPO_OWNER = 'Saxo0213';
export const UPDATE_REPO_NAME = 'line-agent-assistant';
export const UPDATE_RELEASES_URL_PREFIX = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/`;
export const UPDATE_RELEASES_FALLBACK_URL = `${UPDATE_RELEASES_URL_PREFIX}latest`;

export const UpdateCheckStateSchema = z.strictObject({
  enabled: z.boolean(),
  checking: z.boolean(),
  /** ISO time of the last attempt, or null when no check has run yet. */
  lastCheckedAt: z.string().nullable(),
  lastCheckFailed: z.boolean(),
  latestVersion: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  available: z.boolean(),
  installedNotice: z.strictObject({ version: z.string(), releaseUrl: z.string() }).nullable(),
  /** Version dismissed from the floating update prompt; a newer version prompts again. */
  ignoredVersion: z.string().nullable(),
  download: z.strictObject({ status: z.enum(['idle', 'downloading', 'ready', 'error']), percent: z.number().min(0).max(100) }),
  /** False when running unpackaged; 「更新」 then opens the release page. */
  canAutoInstall: z.boolean(),
});
export type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>;

export const UpdateCheckRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getState') }),
  z.strictObject({ type: z.literal('setEnabled'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('checkNow') }),
  z.strictObject({ type: z.literal('openReleasePage') }),
  z.strictObject({ type: z.literal('openInstalledDetails') }),
  z.strictObject({ type: z.literal('ignore'), version: z.string().min(1).max(32) }),
  z.strictObject({ type: z.literal('install') }),
]);
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;

export function isTrustedReleaseUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith(UPDATE_RELEASES_URL_PREFIX);
}
