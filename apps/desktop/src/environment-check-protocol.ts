import { z } from 'zod';

/** Dedicated Main/renderer channels for the environment check. The check carries no LINE data and needs no database. */
export const ENVIRONMENT_CHECK_CHANNEL = 'line-agent:environment-check';
/** Main sends this event (no payload) when a visible install window closes. The page then runs the check again. */
export const ENVIRONMENT_CHECK_CHANGED_CHANNEL = 'line-agent:environment-check-changed';

export const ENVIRONMENT_ITEM_IDS = ['chrome', 'lineExtension', 'lineDesktop', 'nodejs', 'claude', 'codex'] as const;
export const EnvironmentItemIdSchema = z.enum(ENVIRONMENT_ITEM_IDS);
export type EnvironmentItemId = z.infer<typeof EnvironmentItemIdSchema>;

export const EnvironmentItemStatusSchema = z.enum(['ok', 'missing', 'unknown']);
export type EnvironmentItemStatus = z.infer<typeof EnvironmentItemStatusSchema>;

export const EnvironmentCheckResultSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: EnvironmentItemIdSchema,
    status: EnvironmentItemStatusSchema,
    /** Short version text when it is known. */
    version: z.string().max(64).nullable(),
  })).max(ENVIRONMENT_ITEM_IDS.length),
});
export type EnvironmentCheckResult = z.infer<typeof EnvironmentCheckResultSchema>;

/** The renderer sends only an install id. Main maps the id to a fixed action. No command text and no URL cross this channel. */
export const EnvironmentCheckRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getEnvironmentCheck') }),
  z.strictObject({ type: z.literal('installEnvironmentItem'), id: EnvironmentItemIdSchema }),
]);
export type EnvironmentCheckRequest = z.infer<typeof EnvironmentCheckRequestSchema>;

export const EnvironmentInstallResultSchema = z.strictObject({ started: z.boolean() });
export type EnvironmentInstallResult = z.infer<typeof EnvironmentInstallResultSchema>;
