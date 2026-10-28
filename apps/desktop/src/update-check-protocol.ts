import { z } from 'zod';

/** Dedicated Main/renderer channels for the update check; it carries no LINE data and needs no database. */
export const UPDATE_CHECK_CHANNEL = 'line-agent:update-check';
export const UPDATE_CHECK_STATE_CHANNEL = 'line-agent:update-check-state';
export const UPDATE_RELEASES_URL_PREFIX = 'https://github.com/Saxo0213/line-agent-assistant/releases/';
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
});
export type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>;

export const UpdateCheckRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getState') }),
  z.strictObject({ type: z.literal('setEnabled'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('checkNow') }),
  z.strictObject({ type: z.literal('openReleasePage') }),
]);
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;

export function isTrustedReleaseUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith(UPDATE_RELEASES_URL_PREFIX);
}
