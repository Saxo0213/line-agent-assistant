import { z } from 'zod';
import { WritableConversationKeySchema } from './account.js';
import { AgentToolPolicySchema } from './agent-permissions.js';
import { AgentRunExtensionsSchema } from './agent-extensions.js';

const IdSchema = z.string().min(1);
const TimestampSchema = z.iso.datetime({ offset: true });

export const AgentProviderSchema = z.enum(['codex', 'claude']);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const AgentSourceSchema = z.discriminatedUnion('type', [
  WritableConversationKeySchema.extend({ type: z.literal('line'), messageId: IdSchema }),
  /** UI work belongs to the one shared Agent room, which has no LINE account. */
  z.strictObject({ type: z.literal('ui'), requestId: IdSchema }),
  /** A scheduled run: its own queue and a brand-new provider session; it never touches the room's or a chat's session. */
  z.strictObject({ type: z.literal('schedule'), requestId: IdSchema }),
]);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

/** Launch-scoped, memory-only MCP transport for one built-in Agent run. The token is never persisted or logged. */
export const AgentMcpLaunchSchema = z.strictObject({
  endpoint: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/mcp'; }, 'Loopback MCP endpoint required'),
  token: z.string().regex(/^li_job_[A-Za-z0-9_-]{43}$/),
});
export type AgentMcpLaunch = z.infer<typeof AgentMcpLaunchSchema>;

/** Hard limits for files attached in the local Agent room; Main enforces them again after this schema. */
export const AGENT_ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxNameLength: 255,
} as const;

/** One file chosen in the Agent room composer. The renderer sends bytes, never a path. */
export const AgentAttachmentUploadSchema = z.strictObject({
  name: z.string().min(1).max(AGENT_ATTACHMENT_LIMITS.maxNameLength),
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Bytes required').refine((bytes) => bytes.byteLength <= AGENT_ATTACHMENT_LIMITS.maxFileBytes, 'File too large'),
});
export type AgentAttachmentUpload = z.infer<typeof AgentAttachmentUploadSchema>;

export const AgentAttachmentUploadsSchema = z.array(AgentAttachmentUploadSchema).max(AGENT_ATTACHMENT_LIMITS.maxFiles)
  .superRefine((files, context) => {
    if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) {
      context.addIssue({ code: 'custom', message: 'Attachments exceed the total size limit' });
    }
  });

/** Display-only view of a stored attachment; it never carries a path. */
export const AgentAttachmentSummarySchema = z.strictObject({
  name: z.string().min(1).max(AGENT_ATTACHMENT_LIMITS.maxNameLength),
  size: z.number().int().nonnegative(),
  kind: z.enum(['image', 'file']),
});
export type AgentAttachmentSummary = z.infer<typeof AgentAttachmentSummarySchema>;

/** Persisted metadata (agent_jobs.attachments). `relativePath` is relative to the job's workspace. */
export const AgentStoredAttachmentSchema = AgentAttachmentSummarySchema.extend({
  relativePath: z.string().min(1).max(1024),
  mime: z.string().min(1).max(100),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AgentStoredAttachment = z.infer<typeof AgentStoredAttachmentSchema>;

export const AgentRunRequestSchema = z.strictObject({
  jobId: IdSchema,
  provider: AgentProviderSchema,
  source: AgentSourceSchema,
  prompt: z.string().min(1),
  workspacePath: z.string().min(1),
  /** Absolute image files for the Codex `--image` flag; the bridge re-validates each against the workspace roots. */
  imagePaths: z.array(z.string().min(1).max(4096)).max(AGENT_ATTACHMENT_LIMITS.maxFiles).optional(),
  /** Main-resolved provider tool decision; the runner applies it and never infers one. */
  tools: AgentToolPolicySchema,
  resumeSessionId: IdSchema.optional(),
  mcp: AgentMcpLaunchSchema.optional(),
  /** Main-resolved extra MCP servers and built-in tool additions; present only for jobs whose durable principal is eligible. */
  extensions: AgentRunExtensionsSchema.optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export type ResumeSessionValidationResult =
  | { status: 'valid' }
  | { status: 'workspace_mismatch' }
  | { status: 'invalid' };

export const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), externalSessionId: IdSchema, workspacePath: z.string().min(1).optional() }),
  z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
  z.strictObject({ type: z.literal('tool_started'), toolName: z.string().min(1), toolUseId: IdSchema }),
  z.strictObject({ type: z.literal('tool_completed'), toolUseId: IdSchema, summary: z.string() }),
  z.strictObject({ type: z.literal('approval_required'), approvalId: IdSchema, summary: z.string().min(1) }),
  z.strictObject({ type: z.literal('completed'), finalText: z.string(), usage: UsageSchema.optional() }),
  z.strictObject({ type: z.literal('failed'), code: z.string().min(1), message: z.string().min(1), retryable: z.boolean(),
    quotaRecoveryAt: TimestampSchema.optional() }),
  z.strictObject({ type: z.literal('cancelled') }),
  z.strictObject({ type: z.literal('mcp_status'), status: z.enum(['configured', 'available', 'not_loaded']), message: z.string().min(1) }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentSessionSchema = z.strictObject({
  sessionId: IdSchema,
  provider: AgentProviderSchema,
  source: z.discriminatedUnion('type', [
    WritableConversationKeySchema.extend({ type: z.literal('line') }),
    z.strictObject({ type: z.literal('ui') }),
  ]),
  externalSessionId: IdSchema,
  generation: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ jobId: IdSchema, status: z.literal('completed'), finalText: z.string(), externalSessionId: IdSchema.nullable(), usage: UsageSchema.optional() }),
  z.strictObject({ jobId: IdSchema, status: z.literal('failed'), code: z.string().min(1), message: z.string().min(1), retryable: z.boolean() }),
  z.strictObject({ jobId: IdSchema, status: z.literal('cancelled') }),
]);
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
