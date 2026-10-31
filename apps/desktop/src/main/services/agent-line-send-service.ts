import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_AGENT_ROOM_CHAT_ID,
  McpListSendTargetsInputSchema,
  McpListSendTargetsOutputSchema,
  McpSendToTargetInputSchema,
  SEND_FILE_MAX_BYTES,
  SEND_IMAGE_MAX_BYTES,
  SEND_ITEMS_MAX,
  SEND_ITEMS_PER_JOB_MAX,
  type LineWorkerCommand,
  type LineWorkerEvent,
  type McpListSendTargetsOutput,
  type McpSendItem,
  type McpSendResult,
  type McpSendToTargetOutput,
  type SendErrorCode,
  type WorkerBinding,
} from '@line-agent/contracts';
import {
  ATTACHMENT_STORED_STATUS,
  McpDomainError,
  findSharedAdminChat,
  type LineSendAuditRow,
  type MessageRepository,
  type SendChatType,
} from '@line-agent/database';
import type { PoolClient } from 'pg';
import type { SendMediaRequest } from '../connected-facade.js';
import { resolveManagedAttachment } from '../security.js';
import { splitDeliveryText } from './delivery-service.js';
import type { OperationalAudit } from './operational-audit.js';
import { gatewayFault, recordSendFault, sendFaultDbCode, sendFaultDetail, workerFault, type SendFault } from './send-failure.js';

/** list_send_targets queries that mean the administrator (compared lower-cased). */
export const ADMIN_QUERY_ALIASES: ReadonlySet<string> = new Set(['管理員', '主要管理者', '管理者', 'admin', 'administrator', 'me', '我']);

/** Items waiting in the queue across all jobs; a call that would exceed it is refused before anything is queued. */
export const SEND_PENDING_MAX = 30;
/** Budget of one send_to_target call; an item that cannot start in time is skipped. */
export const SEND_CALL_BUDGET_MS = 600_000;
const SHUTDOWN_DRAIN_MS = 5_000;
const FILE_NAME_MAX_BYTES = 180;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif']);

type Queryable = Pick<PoolClient, 'query'>;
type SendTextCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;
type ActiveBinding = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' };

export interface AgentLineSendWorker {
  binding(accountId: string): Promise<ActiveBinding | null>;
  waitModeAck?(accountId: string, mode: 'ACTIVE_CONTROL', timeoutMs: number): Promise<boolean>;
  send(command: SendTextCommand, signal?: AbortSignal): Promise<SendResult>;
  sendMedia?(command: SendMediaRequest, signal?: AbortSignal): Promise<SendResult>;
}

export type AgentLineSendRepository = Pick<MessageRepository,
  'findAgentSendAccount' | 'listSendTargets' | 'getSendTarget' | 'resolveSendSourceMessage' | 'getSendAttachment'
  | 'recordLineSend' | 'countJobLineSends'>;

export interface AgentLineSendOptions {
  messages: AgentLineSendRepository;
  worker: AgentLineSendWorker;
  canWriteLine(accountId: string): Promise<boolean>;
  /** Root of the stored attachments (resolved with the same safe resolver the open/preview path uses). */
  attachmentRoot: string;
  /** Configured Agent workspace for local MCP calls that have no Agent job row. */
  workspacePath?: () => Promise<string | null>;
  /** Operational audit: one row for each failed or unknown item, with the real cause as bounded enums and numbers. */
  audit?: Pick<OperationalAudit, 'observed'>;
  /** Test hook: per-call budget. */
  callBudgetMs?: number;
}

/** Audit principal of a message sent by Main itself for a system message schedule (no Agent job, no provider). */
export const SYSTEM_SCHEDULE_PRINCIPAL = 'system:schedule';
/** Audit principal of a group free-mode notice (docs/architecture/group-free-mode.md). */
export const FREE_MODE_PRINCIPAL = 'system:free_mode';
/** Audit principal of a /folder reply (docs/architecture/project-folders.md). */
export const PROJECT_FOLDER_PRINCIPAL = 'system:project_folder';
export const PROVIDER_QUOTA_PRINCIPAL = 'system:provider_quota';

export interface SystemTextInput {
  /** Audit `job_id`: the schedule run id (a system message has no Agent job). */
  runId: string;
  target: { accountId: string; chatType: SendChatType; chatId: string };
  text: string;
  /** Audit principal; defaults to the schedule principal. */
  principalId?: typeof SYSTEM_SCHEDULE_PRINCIPAL | typeof FREE_MODE_PRINCIPAL | typeof PROJECT_FOLDER_PRINCIPAL | typeof PROVIDER_QUOTA_PRINCIPAL;
  signal?: AbortSignal;
  /** Rechecked after FIFO wait and immediately before LINE send; false means a safely skipped write. */
  validateBeforeSend?: (binding: WorkerBinding) => Promise<boolean>;
}
/** `unknown` means the message may have reached LINE; the caller must never retry it. */
export type SystemTextResult = { status: 'sent' } | { status: 'failed'; code: SendErrorCode } | { status: 'unknown'; code: SendErrorCode };

type ItemKind = LineSendAuditRow['itemKind'];
type PlannedItem =
  | { index: number; auditKind: ItemKind; kind: 'text'; parts: string[]; byteSize: number }
  | {
    index: number; auditKind: ItemKind; kind: 'media'; mediaKind: 'image' | 'file'; name: string;
    source: { type: 'stored'; relativePath: string; sizeBytes: number; sha256: string | null } | { type: 'workspace'; path: string };
  };
type ReadyItem =
  | Extract<PlannedItem, { kind: 'text' }>
  | (Extract<PlannedItem, { kind: 'media' }> & { absolutePath: string; sizeBytes: number; expectedSha256: string | null });

/** Everything the authorize transaction decided; no LINE effect has happened yet. */
export interface SendPlan {
  jobId: string;
  principalId: string;
  accountId: string;
  chatType: SendChatType;
  chatId: string;
  workspacePath: string | null;
  items: PlannedItem[];
}
export type AuthorizeOutcome = { kind: 'rejected'; output: McpSendToTargetOutput } | { kind: 'plan'; plan: SendPlan };

export interface AgentLineSendHandler {
  listTargets(client: Queryable, rawInput: unknown, accountScope?: readonly string[] | null): Promise<McpListSendTargetsOutput>;
  authorize(client: Queryable, input: { jobId: string; principalId: string; rawInput: unknown; accountScope?: readonly string[] | null }): Promise<AuthorizeOutcome>;
  run(plan: SendPlan, context: { signal: AbortSignal; isLive(): boolean }): Promise<McpSendToTargetOutput>;
}

interface CallState {
  readonly plan: SendPlan;
  readonly isLive: () => boolean;
  readonly baseline: { controlEpoch: number; workerInstanceId: string };
  halted: boolean;
  validateBeforeSend?: (binding: WorkerBinding) => Promise<boolean>;
}
interface QueueEntry { call: CallState; item: ReadyItem; resolve(result: McpSendResult): void }

const skipped = (index: number): McpSendResult => ({ index, status: 'skipped' });
const failedAt = (count: number, index: number, code: SendErrorCode): McpSendToTargetOutput => ({
  results: Array.from({ length: count }, (_, position) => position === index ? { index: position, status: 'failed' as const, code } : skipped(position)),
});
const utf8Length = (value: string): number => Buffer.byteLength(value, 'utf8');

/** Truncates to at most 180 UTF-8 bytes on a code point boundary. */
export function truncateFileName(name: string): string {
  let result = '';
  let bytes = 0;
  for (const character of name) {
    const size = utf8Length(character);
    if (bytes + size > FILE_NAME_MAX_BYTES) break;
    result += character;
    bytes += size;
  }
  return result || 'file';
}

const isInside = (root: string, candidate: string): boolean => {
  const relation = path.relative(root, candidate);
  return !!relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation);
};

async function hashFile(file: string, signal: AbortSignal): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(file);
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error('aborted');
      const bytes = chunk as Buffer;
      size += bytes.length;
      hash.update(bytes);
    }
  } finally { stream.destroy(); }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Agent LINE send behind the internal MCP tools (docs/architecture/agent-line-send.md).
 * Owns one FIFO queue of authorized items that are sent one at a time, outside any database transaction. The random
 * gap between sends is the worker gateway's per-account pacing; there is no second delay here.
 */
export class AgentLineSendService implements AgentLineSendHandler {
  private readonly controller = new AbortController();
  private queue: QueueEntry[] = [];
  private active: QueueEntry | undefined;
  private pumping: Promise<void> | undefined;
  private stopping = false;
  private readonly callBudgetMs: number;

  constructor(private readonly options: AgentLineSendOptions) {
    this.callBudgetMs = options.callBudgetMs ?? SEND_CALL_BUDGET_MS;
  }

  /** Items of one job that are queued or in flight; added to the durable per-job count. */
  pendingForJob(jobId: string): number {
    return this.queue.filter((entry) => entry.call.plan.jobId === jobId).length + (this.active?.call.plan.jobId === jobId ? 1 : 0);
  }

  async listTargets(client: Queryable, rawInput: unknown, accountScope?: readonly string[] | null): Promise<McpListSendTargetsOutput> {
    const parsed = McpListSendTargetsInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new McpDomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid list_send_targets arguments.');
    const accountId = await this.options.messages.findAgentSendAccount(client);
    if (!accountId || (accountScope !== undefined && accountScope !== null && !accountScope.includes(accountId))) return { targets: [] };
    const admin = await findSharedAdminChat(client).catch(() => null);
    const adminId = admin !== null && admin.accountId === accountId ? admin.adminMid : null;
    let rows = await this.options.messages.listSendTargets({ accountId, query: parsed.data.query, limit: 20 }, client);
    // An alias for the administrator returns the administrator's chat first, even when no title matches the query.
    if (adminId !== null && ADMIN_QUERY_ALIASES.has(parsed.data.query.trim().toLowerCase())) {
      const adminRow = (await this.options.messages.listSendTargets({ accountId, query: adminId, limit: 20 }, client))
        .find((row) => row.chatType === 'direct' && row.chatId === adminId);
      if (adminRow) rows = [adminRow, ...rows.filter((row) => !(row.chatType === 'direct' && row.chatId === adminId))];
    }
    const targets = rows.filter((row) => row.chatId !== LOCAL_AGENT_ROOM_CHAT_ID).slice(0, 20)
      .map((row, index) => ({ ...row, no: index + 1, ...(adminId !== null && row.chatType === 'direct' && row.chatId === adminId ? { role: 'primary_admin' as const } : {}) }));
    return McpListSendTargetsOutputSchema.parse({ targets });
  }

  /** Runs inside the short MCP transaction: principal is already verified; checks the Agent account, target, caps and sources. */
  async authorize(client: Queryable, input: { jobId: string; principalId: string; rawInput: unknown; accountScope?: readonly string[] | null }): Promise<AuthorizeOutcome> {
    const parsed = McpSendToTargetInputSchema.safeParse(input.rawInput);
    if (!parsed.success) {
      const raw = input.rawInput as { chatType?: unknown; items?: unknown } | null;
      // community and thread are well-formed chat types the Agent may read but never write.
      if (raw && typeof raw === 'object' && (raw.chatType === 'community' || raw.chatType === 'thread')) {
        const count = Array.isArray(raw.items) ? Math.min(SEND_ITEMS_MAX, Math.max(1, raw.items.length)) : 1;
        return { kind: 'rejected', output: failedAt(count, 0, 'send_target_invalid') };
      }
      throw new McpDomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid send_to_target arguments.');
    }
    const { chatType, chatId, items } = parsed.data;
    const messages = this.options.messages;
    const reject = async (index: number, code: SendErrorCode, byteSize = 0): Promise<AuthorizeOutcome> => {
      const accountId = await messages.findAgentSendAccount(client);
      if (accountId) {
        await messages.recordLineSend({ jobId: input.jobId, accountId, principalId: input.principalId, chatType, chatId,
          itemIndex: index, itemKind: items[index]!.type, byteSize, status: 'denied', errorCode: code }, client);
      }
      return { kind: 'rejected', output: failedAt(items.length, index, code) };
    };

    const accountId = await messages.findAgentSendAccount(client);
    if (input.accountScope !== undefined && input.accountScope !== null && (!accountId || !input.accountScope.includes(accountId))) return reject(0, 'send_line_unavailable');
    if (!accountId || !await this.options.canWriteLine(accountId)) return reject(0, 'send_line_unavailable');
    const target = await messages.getSendTarget(accountId, chatType, chatId, client);
    if (!target) return reject(0, 'send_target_invalid');
    const sentSoFar = await messages.countJobLineSends(input.jobId, client);
    if (sentSoFar + this.pendingForJob(input.jobId) + items.length > SEND_ITEMS_PER_JOB_MAX) return reject(0, 'send_limit_exceeded');

    let workspacePath: string | null = null;
    if (items.some((item) => item.type === 'file')) {
      const job = await client.query<{ workspace_path: string }>('SELECT workspace_path FROM agent_jobs WHERE job_id = $1', [input.jobId]);
      workspacePath = job.rows[0]?.workspace_path ?? await this.options.workspacePath?.() ?? null;
    }
    const planned: PlannedItem[] = [];
    for (const [index, item] of items.entries()) {
      if (input.accountScope !== undefined && input.accountScope !== null && item.type === 'message' && !input.accountScope.includes(item.accountId)) {
        return reject(index, 'send_source_unavailable');
      }
      const outcome = await this.planItem(client, item, index, workspacePath, input.accountScope);
      if ('code' in outcome) return reject(index, outcome.code);
      if (outcome.kind === 'media' && target.chatType === 'room') return reject(index, 'send_media_unsupported_chat');
      planned.push(outcome);
    }
    return { kind: 'plan', plan: { jobId: input.jobId, principalId: input.principalId, accountId, chatType: target.chatType,
      chatId: target.chatId, workspacePath, items: planned } };
  }

  private async planItem(client: Queryable, item: McpSendItem, index: number, workspacePath: string | null, accountScope?: readonly string[] | null):
  Promise<PlannedItem | { code: SendErrorCode }> {
    const messages = this.options.messages;
    if (item.type === 'text') {
      return { index, auditKind: 'text', kind: 'text', parts: splitDeliveryText(item.text), byteSize: utf8Length(item.text) };
    }
    if (item.type === 'file') {
      if (workspacePath === null) return { code: 'send_file_invalid' };
      return { index, auditKind: 'file', kind: 'media', mediaKind: 'file', name: path.basename(item.path), source: { type: 'workspace', path: item.path } };
    }
    if (item.type === 'attachment') {
      const attachment = await messages.getSendAttachment(item.attachmentId, client);
      if (!attachment || attachment.masked || attachment.status !== ATTACHMENT_STORED_STATUS
        || (accountScope !== undefined && accountScope !== null && !accountScope.includes(attachment.accountId))
        || !attachment.relativePath || attachment.sizeBytes === null) return { code: 'send_attachment_unavailable' };
      return { index, auditKind: 'attachment', kind: 'media', mediaKind: attachment.kind === 'image' ? 'image' : 'file',
        name: attachment.name ?? path.posix.basename(attachment.relativePath),
        source: { type: 'stored', relativePath: attachment.relativePath, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 } };
    }
    const source = await messages.resolveSendSourceMessage(
      { accountId: item.accountId, chatType: item.chatType, chatId: item.chatId, messageId: item.messageId }, client);
    if (!source || source.masked || (accountScope !== undefined && accountScope !== null && !accountScope.includes(item.accountId))) return { code: 'send_source_unavailable' };
    if (source.kind === 'text') {
      if (!source.text) return { code: 'send_source_unavailable' };
      return { index, auditKind: 'message', kind: 'text', parts: splitDeliveryText(source.text), byteSize: utf8Length(source.text) };
    }
    if (source.kind !== 'image' && source.kind !== 'file' && source.kind !== 'video' && source.kind !== 'audio') {
      return { code: 'send_kind_unsupported' };
    }
    const attachment = source.attachments.find((candidate) => candidate.status === ATTACHMENT_STORED_STATUS
      && candidate.relativePath !== null && candidate.sizeBytes !== null);
    if (!attachment) return { code: 'send_attachment_unavailable' };
    return { index, auditKind: 'message', kind: 'media', mediaKind: source.kind === 'image' ? 'image' : 'file',
      name: attachment.name ?? path.posix.basename(attachment.relativePath!),
      source: { type: 'stored', relativePath: attachment.relativePath!, sizeBytes: attachment.sizeBytes!, sha256: attachment.sha256 } };
  }

  /** File system checks (no hashing) for every media item; a failure refuses the whole call before anything is queued. */
  private async prepare(plan: SendPlan): Promise<{ ok: true; items: ReadyItem[] } | { ok: false; index: number; code: SendErrorCode }> {
    const ready: ReadyItem[] = [];
    let workspaceReal: string | null = null;
    for (const item of plan.items) {
      if (item.kind === 'text') { ready.push(item); continue; }
      const unavailable: SendErrorCode = item.source.type === 'stored' ? 'send_attachment_unavailable' : 'send_file_invalid';
      let absolutePath: string;
      let mediaKind = item.mediaKind;
      let name = item.name;
      try {
        if (item.source.type === 'stored') {
          const resolved = await resolveManagedAttachment(this.options.attachmentRoot, item.source.relativePath);
          if (!resolved) return { ok: false, index: item.index, code: unavailable };
          absolutePath = resolved;
        } else {
          workspaceReal ??= await realpath(plan.workspacePath!);
          const real = await realpath(path.resolve(workspaceReal, item.source.path));
          if (!isInside(workspaceReal, real)) return { ok: false, index: item.index, code: unavailable };
          absolutePath = real;
          name = path.basename(real);
          mediaKind = IMAGE_EXTENSIONS.has(path.extname(real).toLowerCase()) ? 'image' : 'file';
        }
        const info = await stat(absolutePath);
        if (!info.isFile() || info.size < 1) return { ok: false, index: item.index, code: unavailable };
        if (item.source.type === 'stored' && info.size !== item.source.sizeBytes) return { ok: false, index: item.index, code: unavailable };
        if (info.size > (mediaKind === 'image' ? SEND_IMAGE_MAX_BYTES : SEND_FILE_MAX_BYTES)) {
          return { ok: false, index: item.index, code: 'send_too_large' };
        }
        ready.push({ ...item, mediaKind, name: truncateFileName(name), absolutePath, sizeBytes: info.size,
          expectedSha256: item.source.type === 'stored' ? item.source.sha256 : null });
      } catch { return { ok: false, index: item.index, code: unavailable }; }
    }
    return { ok: true, items: ready };
  }

  private async audit(row: LineSendAuditRow): Promise<void> {
    try { await this.options.messages.recordLineSend(row); } catch { /* the audit never blocks or reveals a send */ }
  }

  /**
   * Sends one text that Main itself owns (a system message schedule) through the SAME queue, per-account pacing, write gate,
   * binding / mode-ack checks and audit as send_to_target; only the principal ('system:schedule') and the audit job id (the run id)
   * differ. Text over the per-message limit is split by splitDeliveryText. It never runs inside a database transaction and is never
   * retried: `unknown` is final.
   */
  async sendSystemText(input: SystemTextInput): Promise<SystemTextResult> {
    const principalId = input.principalId ?? SYSTEM_SCHEDULE_PRINCIPAL;
    const unavailable: SystemTextResult = { status: 'failed', code: 'send_line_unavailable' };
    const parts = splitDeliveryText(input.text);
    if (this.stopping || parts.length === 0) return unavailable;
    const messages = this.options.messages;
    const byteSize = utf8Length(input.text);
    let accountId: string | null;
    try { accountId = await messages.findAgentSendAccount(); } catch { return unavailable; }
    if (!accountId) return unavailable;
    const deny = async (code: SendErrorCode): Promise<SystemTextResult> => {
      await this.audit({ jobId: input.runId, accountId: accountId!, principalId, chatType: input.target.chatType,
        chatId: input.target.chatId, itemIndex: 0, itemKind: 'text', byteSize, status: 'denied', errorCode: code });
      return { status: 'failed', code };
    };
    if (accountId !== input.target.accountId || !await this.options.canWriteLine(accountId)) return deny('send_line_unavailable');
    const target = await messages.getSendTarget(accountId, input.target.chatType, input.target.chatId).catch(() => null);
    if (!target) return deny('send_target_invalid');
    const plan: SendPlan = { jobId: input.runId, principalId, accountId, chatType: target.chatType,
      chatId: target.chatId, workspacePath: null, items: [{ index: 0, auditKind: 'text', kind: 'text', parts, byteSize }] };
    const output = await this.run(plan, { signal: input.signal ?? new AbortController().signal, isLive: () => !this.stopping,
      ...(input.validateBeforeSend ? { validateBeforeSend: input.validateBeforeSend } : {}) });
    const result = output.results[0];
    if (result?.status === 'sent') return { status: 'sent' };
    if (result?.status === 'unknown') return { status: 'unknown', code: 'send_unknown' };
    if (result?.status === 'skipped') return { status: 'failed', code: 'send_line_unavailable' };
    return { status: 'failed', code: result?.status === 'failed' ? result.code ?? 'send_failed' : 'send_line_unavailable' };
  }

  private async currentBinding(accountId: string): Promise<ActiveBinding | null> {
    if (!await this.options.canWriteLine(accountId)) return null;
    const binding = await this.options.worker.binding(accountId);
    const acknowledged = !this.options.worker.waitModeAck || await this.options.worker.waitModeAck(accountId, 'ACTIVE_CONTROL', 0);
    return binding && binding.mode === 'ACTIVE_CONTROL' && acknowledged ? binding : null;
  }

  async run(plan: SendPlan, context: { signal: AbortSignal; isLive(): boolean; validateBeforeSend?: (binding: WorkerBinding) => Promise<boolean> }): Promise<McpSendToTargetOutput> {
    const count = plan.items.length;
    const refuse = async (index: number, code: SendErrorCode): Promise<McpSendToTargetOutput> => {
      const item = plan.items[index]!;
      await this.audit({ jobId: plan.jobId, accountId: plan.accountId, principalId: plan.principalId, chatType: plan.chatType,
        chatId: plan.chatId, itemIndex: index, itemKind: item.auditKind, byteSize: item.kind === 'text' ? item.byteSize : 0,
        status: 'denied', errorCode: code });
      return failedAt(count, index, code);
    };
    if (this.stopping || context.signal.aborted || !context.isLive()) return failedAt(count, 0, 'send_line_unavailable');
    const prepared = await this.prepare(plan);
    if (!prepared.ok) return refuse(prepared.index, prepared.code);
    const binding = await this.currentBinding(plan.accountId);
    if (!binding) return refuse(0, 'send_line_unavailable');
    if (this.queue.length + count > SEND_PENDING_MAX) return refuse(0, 'send_limit_exceeded');
    if (this.stopping || context.signal.aborted || !context.isLive()) return failedAt(count, 0, 'send_line_unavailable');

    const call: CallState = { plan, isLive: context.isLive, halted: false,
      baseline: { controlEpoch: binding.controlEpoch, workerInstanceId: binding.workerInstanceId },
      ...(context.validateBeforeSend ? { validateBeforeSend: context.validateBeforeSend } : {}) };
    const release = () => this.haltQueued(call);
    const results = prepared.items.map((item) => new Promise<McpSendResult>((resolve) => {
      this.queue.push({ call, item, resolve });
    }));
    context.signal.addEventListener('abort', release, { once: true });
    const timer = setTimeout(release, this.callBudgetMs);
    this.pump();
    try {
      return { results: await Promise.all(results) };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', release);
    }
  }

  /** Marks the call finished and resolves its waiting items as skipped; an item already in flight still ends normally. */
  private haltQueued(call: CallState): void {
    call.halted = true;
    this.purge((entry) => entry.call === call);
  }

  private purge(match: (entry: QueueEntry) => boolean): void {
    const kept: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (match(entry)) entry.resolve(skipped(entry.item.index)); else kept.push(entry);
    }
    this.queue = kept;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = this.loop().finally(() => {
      this.pumping = undefined;
      if (!this.stopping && this.queue.length) this.pump();
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.active = entry;
      let result: McpSendResult;
      try { result = await this.process(entry); }
      catch {
        const fault: SendFault = { source: 'local', outcome: 'unknown', code: 'process_error' };
        result = { index: entry.item.index, status: 'unknown', code: 'send_unknown', detail: sendFaultDetail(fault) };
        recordSendFault(this.options.audit, { accountId: entry.call.plan.accountId, jobId: entry.call.plan.jobId, requestId: randomUUID(),
          operation: entry.item.kind === 'text' ? 'sendText' : 'sendMedia' }, fault);
      }
      finally { this.active = undefined; }
      if (result.status === 'failed' || result.status === 'unknown') this.haltQueued(entry.call);
      entry.resolve(result);
    }
  }

  private async process(entry: QueueEntry): Promise<McpSendResult> {
    const { call, item } = entry;
    const { plan } = call;
    const index = item.index;
    if (call.halted || this.stopping || !call.isLive()) return skipped(index);
    const byteSize = item.kind === 'text' ? item.byteSize : item.sizeBytes;
    const record = (status: LineSendAuditRow['status'], code: string | null) => this.audit({
      jobId: plan.jobId, accountId: plan.accountId, principalId: plan.principalId, chatType: plan.chatType, chatId: plan.chatId,
      itemIndex: index, itemKind: item.auditKind, byteSize, status, errorCode: code });
    const unavailable = async (sent: boolean): Promise<McpSendResult> => {
      // A capability released (or a shutdown) between two steps is a stop, not a failure, when nothing went out.
      if (!sent && (this.stopping || !call.isLive())) return skipped(index);
      await record(sent ? 'failed' : 'denied', 'send_line_unavailable');
      return { index, status: 'failed', code: 'send_line_unavailable' };
    };
    /** The same binding the call was authorized under, still ACTIVE_CONTROL and acknowledged; null means drift. */
    const fresh = async (): Promise<ActiveBinding | null> => {
      if (this.stopping || !call.isLive()) return null;
      const binding = await this.currentBinding(plan.accountId);
      return binding && binding.controlEpoch === call.baseline.controlEpoch
        && binding.workerInstanceId === call.baseline.workerInstanceId ? binding : null;
    };
    /** The worker result is the truth only when it matches this request and binding; the worker error code and detail are kept. */
    const finish = (result: SendResult, requestId: string, binding: ActiveBinding): 'sent' | SendFault => {
      const matches = result.requestId === requestId && result.accountId === plan.accountId
        && result.workerInstanceId === binding.workerInstanceId && result.controlEpoch === binding.controlEpoch;
      if (!matches) return { source: 'local', outcome: 'unknown', code: 'result_mismatch' };
      if (result.status === 'sent') return result.messageId ? 'sent' : { source: 'local', outcome: 'unknown', code: 'no_message_id' };
      return workerFault(result, result.status === 'failed' ? 'failed' : 'unknown');
    };
    const operation = item.kind === 'text' ? 'sendText' as const : 'sendMedia' as const;
    const outcomeResult = async (fault: SendFault, requestId: string): Promise<McpSendResult> => {
      const code: SendErrorCode = fault.outcome === 'failed' ? 'send_failed' : 'send_unknown';
      await record(fault.outcome, sendFaultDbCode(fault));
      recordSendFault(this.options.audit, { accountId: plan.accountId, jobId: plan.jobId, requestId, operation }, fault);
      return { index, status: fault.outcome, code, detail: sendFaultDetail(fault) };
    };

    if (item.kind === 'text') {
      let sentParts = 0;
      for (const part of item.parts) {
        const binding = await fresh();
        if (!binding) return unavailable(sentParts > 0);
        if(call.validateBeforeSend) {
          let valid=false;
          try { valid=await call.validateBeforeSend(binding); } catch { valid=false; }
          if(!valid) { await record('denied','send_line_unavailable'); return skipped(index); }
        }
        const requestId = randomUUID();
        let outcome: 'sent' | SendFault;
        try {
          const result = await this.options.worker.send({ type: 'sendText', accountId: plan.accountId, chatType: plan.chatType,
            chatId: plan.chatId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, requestId,
            text: part, replyToMessageId: null }, this.controller.signal);
          outcome = finish(result, requestId, binding);
        } catch (error) { outcome = gatewayFault(error); }
        if (outcome !== 'sent') return outcomeResult(outcome, requestId);
        sentParts += 1;
      }
      await record('sent', null);
      return { index, status: 'sent' };
    }

    const sendMedia = this.options.worker.sendMedia;
    if (!sendMedia || plan.chatType === 'room') return unavailable(false);
    const changed: SendErrorCode = item.source.type === 'stored' ? 'send_attachment_unavailable' : 'send_file_invalid';
    let hashed: { sha256: string; size: number };
    try { hashed = await hashFile(item.absolutePath, this.controller.signal); }
    catch {
      await record('denied', changed);
      return { index, status: 'failed', code: changed };
    }
    if (hashed.size !== item.sizeBytes || (item.expectedSha256 !== null && item.expectedSha256 !== hashed.sha256)) {
      await record('denied', changed);
      return { index, status: 'failed', code: changed };
    }
    const binding = await fresh();
    if (!binding) return unavailable(false);
    const requestId = randomUUID();
    let outcome: 'sent' | SendFault;
    try {
      const result = await sendMedia.call(this.options.worker, { accountId: plan.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, chatType: plan.chatType, chatId: plan.chatId, requestId, kind: item.mediaKind,
        filePath: item.absolutePath, fileName: item.name, sizeBytes: item.sizeBytes, sha256: hashed.sha256 } as SendMediaRequest,
      this.controller.signal);
      outcome = finish(result, requestId, binding);
    } catch (error) { outcome = gatewayFault(error); }
    if (outcome !== 'sent') return outcomeResult(outcome, requestId);
    await record('sent', null);
    return { index, status: 'sent' };
  }

  /** Drops every pending item, aborts the in-flight send and waits a bounded time for the loop to end. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.purge(() => true);
    this.controller.abort();
    const loop = this.pumping;
    if (!loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([loop.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
