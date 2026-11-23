import { z } from 'zod';
import { AgentProviderSchema } from './agent.js';

/** Id of a CLI account source: the system ids `claude` and `codex`, or a managed id such as `acct-0123456789`. */
export const AccountSourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** The label is trimmed first. It must have 1 to 80 characters after that. */
export const AccountSourceLabelSchema = z.string().trim().min(1).max(80);

export const AgentAccountSourceStatusSchema = z.enum(['unknown', 'logged_in', 'logged_out', 'not_installed', 'error']);

/** One CLI account source as the renderer sees it. It has no path and no email. */
export const AgentAccountSourceSchema = z.strictObject({
  id: AccountSourceIdSchema,
  provider: AgentProviderSchema,
  kind: z.enum(['system', 'managed']),
  label: z.string().min(1).max(80),
  isDefault: z.boolean(),
  fallbackEnabled: z.boolean(),
  /** Position in the rotation (from 0). Null when the source is outside the rotation. */
  order: z.number().int().nonnegative().nullable(),
  status: AgentAccountSourceStatusSchema,
  detail: z.string().max(500).nullable(),
  /** True when the source has queued or running jobs. */
  inUse: z.boolean(),
});
export type AgentAccountSource = z.infer<typeof AgentAccountSourceSchema>;

export const AgentAccountSourceUsageSchema = z.strictObject({
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
  blocked: z.boolean(),
  recoveryAt: z.string().nullable(),
  error: z.string().max(200).nullable(),
  windows: z.array(z.strictObject({
    label: z.string().max(200), durationMins: z.number().nullable(), usedPercent: z.number().min(0).max(100),
    resetsAt: z.string().nullable(), blocksProvider: z.boolean(),
  })).max(20),
});
export type AgentAccountSourceUsage = z.infer<typeof AgentAccountSourceUsageSchema>;

export const ACCOUNT_SOURCE_ERROR_CODES = ['ACCOUNT_SOURCE_SYSTEM', 'ACCOUNT_SOURCE_IN_USE', 'ACCOUNT_SOURCE_NOT_FOUND',
  'ACCOUNT_SOURCE_PROVIDER_MISMATCH', 'ACCOUNT_SOURCE_INVALID'] as const;
export type AccountSourceErrorCode = typeof ACCOUNT_SOURCE_ERROR_CODES[number];
