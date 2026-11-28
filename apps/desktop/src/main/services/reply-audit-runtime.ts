import { mkdir } from 'node:fs/promises';
import type { AgentEvent, AgentProvider } from '@line-agent/contracts';
import type { JobPolicy } from '@line-agent/database';
import { ReplyAuditService, type ReplyAuditRecord, type ReplyRequester } from './reply-audit-service.js';

export interface ReplyAuditRuntimeOptions {
  /** The one-shot tool-less judge of the Agent bridge. Absent: no audit session exists and no audit runs. */
  judge: ((request: { provider: AgentProvider; prompt: string; systemPrompt: string; workspacePath: string; timeoutMs: number;
    account: { id: string; kind: 'system' | 'managed' } }) => Promise<{ text: string }>) | undefined;
  /** App-owned empty folder; the audit session works there and has no other file access. Absent: no audit runs. */
  directory: string | undefined;
  resolvePolicy(jobId: string): Promise<JobPolicy | null>;
  /** The default provider, resolved when a judge turn starts (the same rule as the free-mode judge). */
  provider(): Promise<AgentProvider>;
  /** The effective default account source of the provider. */
  account(provider: AgentProvider): Promise<{ id: string; kind: 'system' | 'managed' }>;
  appendEvent(jobId: string, event: AgentEvent): Promise<void>;
  record(entry: ReplyAuditRecord): void;
  blockedText: string;
  appVersion?: string;
  onError?(error: unknown): void;
}

/** The requester of a job from its durable policy: the Primary Admin and the operator are `admin`, every other principal is `member`. */
export async function requesterOfJob(resolvePolicy: ReplyAuditRuntimeOptions['resolvePolicy'], jobId: string): Promise<ReplyRequester> {
  const policy = await resolvePolicy(jobId);
  return policy?.principal.kind === 'admin' || policy?.principal.kind === 'operator' ? 'admin' : 'member';
}

/** The audit service of the app, or undefined when the app has no judge or no audit folder. */
export function createReplyAuditService(options: ReplyAuditRuntimeOptions): ReplyAuditService | undefined {
  const { judge, directory } = options;
  if (!judge || !directory) return undefined;
  return new ReplyAuditService({
    requester: (jobId) => requesterOfJob(options.resolvePolicy, jobId),
    judge: async ({ prompt, systemPrompt, timeoutMs }) => {
      const provider = await options.provider();
      const account = await options.account(provider);
      await mkdir(directory, { recursive: true });
      return (await judge({ provider, prompt, systemPrompt, workspacePath: directory, timeoutMs, account })).text;
    },
    record: options.record,
    keepDraft: (jobId, draft) => options.appendEvent(jobId, { type: 'reply_audit_blocked', draft }),
    blockedText: options.blockedText,
    ...(options.appVersion ? { patterns: { appVersion: options.appVersion } } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
