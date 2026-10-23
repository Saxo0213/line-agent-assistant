import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INTERNAL_MCP_TOKEN_PREFIX = 'li_job_';
export const MAX_INTERNAL_MCP_CAPABILITIES = 8;

export function isInternalMcpToken(value: string | null): value is string {
  return value !== null && /^li_job_[A-Za-z0-9_-]{43}$/.test(value);
}

export interface InternalMcpCapability {
  readonly jobId: string;
  /** null for the shared Agent room's UI jobs, which belong to no LINE account. */
  readonly accountId: string | null;
  /** Durable agent_jobs.generation at provider launch. */
  readonly generation: number;
  /** Listener instance that the capability may be presented to. */
  readonly endpointInstance: string;
  /**
   * Interactive approval binding for operator (Agent room) jobs; null for every other job.
   * Only a capability carrying it may call the internal `request_permission` prompt tool.
   */
  readonly approval: InternalMcpApprovalBinding | null;
  /** Aborted at release; in-flight requests observe it. */
  readonly controller: AbortController;
  initialized: boolean;
  toolsListed: boolean;
  available: boolean;
}

export interface InternalMcpApprovalBinding {
  /** Provider session identity plus session generation; session allowlists are keyed by it. */
  readonly sessionKey: string;
  readonly workspaceRoot: string;
}

export type InternalMcpObservation = 'initialized' | 'tools_listed' | 'available';

const digestOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Memory-only registry of per-job transport capabilities for built-in Agents.
 * Bounded by the Agent service's active-job limit; no timers, listeners or processes.
 * A capability is transport authentication only: every request still rechecks the durable job.
 */
export class InternalMcpCapabilityRegistry {
  private readonly byDigest = new Map<string, InternalMcpCapability>();
  private readonly byJob = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly maxCapabilities = MAX_INTERNAL_MCP_CAPABILITIES,
    private readonly onObservation?: (jobId: string, observation: InternalMcpObservation) => void,
  ) {}

  get size(): number { return this.byDigest.size; }

  /** Mints a fresh capability for the job, replacing (and aborting) any earlier one. */
  mint(input: {
    jobId: string; accountId: string | null; generation: number; endpointInstance: string; approval?: InternalMcpApprovalBinding | null;
  }): { token: string; capability: InternalMcpCapability } {
    if (this.closed) throw new Error('Internal MCP capability registry is closed.');
    this.release(input.jobId);
    if (this.byDigest.size >= this.maxCapabilities) throw new Error('Internal MCP capability limit reached.');
    const token = `${INTERNAL_MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const approval = input.approval ? { sessionKey: input.approval.sessionKey, workspaceRoot: input.approval.workspaceRoot } : null;
    const capability: InternalMcpCapability = { jobId: input.jobId, accountId: input.accountId, generation: input.generation,
      endpointInstance: input.endpointInstance, approval, controller: new AbortController(), initialized: false, toolsListed: false, available: false };
    const digest = digestOf(token);
    this.byDigest.set(digest, capability);
    this.byJob.set(input.jobId, digest);
    return { token, capability };
  }

  /** Resolves a presented bearer value; null when unknown, released or closed. */
  validate(token: string): InternalMcpCapability | null {
    if (this.closed || !isInternalMcpToken(token)) return null;
    const presented = Buffer.from(digestOf(token), 'hex');
    for (const [digest, capability] of this.byDigest) {
      if (timingSafeEqual(presented, Buffer.from(digest, 'hex')) && !capability.controller.signal.aborted) return capability;
    }
    return null;
  }

  isLive(capability: InternalMcpCapability): boolean {
    if (this.closed || capability.controller.signal.aborted) return false;
    const digest = this.byJob.get(capability.jobId);
    return digest !== undefined && this.byDigest.get(digest) === capability;
  }

  /** Synchronously closes admission and aborts in-flight requests for the job. */
  release(jobId: string): void {
    const digest = this.byJob.get(jobId);
    if (digest === undefined) return;
    this.byJob.delete(jobId);
    const capability = this.byDigest.get(digest);
    this.byDigest.delete(digest);
    capability?.controller.abort(new Error('Internal MCP capability released'));
  }

  /** Records an authenticated, authorized handshake step on a live capability. */
  observe(capability: InternalMcpCapability, step: 'initialized' | 'tools_listed'): void {
    if (!this.isLive(capability)) return;
    if (step === 'initialized') capability.initialized = true;
    else capability.toolsListed = true;
    this.onObservation?.(capability.jobId, step === 'initialized' ? 'initialized' : 'tools_listed');
    if (capability.initialized && capability.toolsListed && !capability.available) {
      capability.available = true;
      this.onObservation?.(capability.jobId, 'available');
    }
  }

  releaseAll(): void {
    this.closed = true;
    for (const jobId of [...this.byJob.keys()]) this.release(jobId);
  }
}
