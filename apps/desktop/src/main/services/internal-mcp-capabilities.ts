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

export type InternalMcpTokenResolution =
  | { kind: 'job'; capability: InternalMcpCapability }
  | { kind: 'idle'; slotKey: string; endpointInstance: string };

interface Slot {
  readonly digest: string;
  readonly endpointInstance: string;
  /** A resident slot keeps its token when the job ends. A one-shot slot ends with the job. */
  readonly resident: boolean;
  current: InternalMcpCapability | null;
  handshake: { initialized: boolean; toolsListed: boolean };
  lastToolList?: unknown[];
}

/**
 * Memory-only registry of transport capabilities for built-in Agents.
 * One-shot slot: one token for one job. Resident slot: one token for a resident process, bound to one job at a time.
 * Bounded by the Agent service's active-job limit; no timers, listeners or processes.
 * A capability is transport authentication only: every request still rechecks the durable job.
 */
export class InternalMcpCapabilityRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly slotByDigest = new Map<string, string>();
  private readonly slotByJob = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly maxCapabilities = MAX_INTERNAL_MCP_CAPABILITIES,
    private readonly onObservation?: (jobId: string, observation: InternalMcpObservation) => void,
  ) {}

  /** Number of slots (one-shot and resident). */
  get size(): number { return this.slots.size; }

  private newCapability(input: {
    jobId: string; accountId: string | null; generation: number; endpointInstance: string; approval?: InternalMcpApprovalBinding | null;
  }): InternalMcpCapability {
    const approval = input.approval ? { sessionKey: input.approval.sessionKey, workspaceRoot: input.approval.workspaceRoot } : null;
    return { jobId: input.jobId, accountId: input.accountId, generation: input.generation,
      endpointInstance: input.endpointInstance, approval, controller: new AbortController(), initialized: false, toolsListed: false, available: false };
  }

  private newToken(): string {
    return `${INTERNAL_MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  }

  private addSlot(slotKey: string, token: string, endpointInstance: string, resident: boolean, capability: InternalMcpCapability): void {
    const digest = digestOf(token);
    this.slots.set(slotKey, { digest, endpointInstance, resident, current: capability, handshake: { initialized: false, toolsListed: false } });
    this.slotByDigest.set(digest, slotKey);
    this.slotByJob.set(capability.jobId, slotKey);
  }

  /** Mints a fresh one-shot capability for the job, replacing (and aborting) any earlier one. */
  mint(input: {
    jobId: string; accountId: string | null; generation: number; endpointInstance: string; approval?: InternalMcpApprovalBinding | null;
  }): { token: string; capability: InternalMcpCapability } {
    if (this.closed) throw new Error('Internal MCP capability registry is closed.');
    this.release(input.jobId);
    if (this.slots.size >= this.maxCapabilities) throw new Error('Internal MCP capability limit reached.');
    const token = this.newToken();
    const capability = this.newCapability(input);
    this.addSlot(`job:${input.jobId}`, token, input.endpointInstance, false, capability);
    return { token, capability };
  }

  /**
   * Binds a job to the token of a resident process.
   * fresh: new slot and new token. Not fresh: the old token stays and the slot gets a new capability ('rebound').
   * Null when a not-fresh bind has no slot, or the slot belongs to another listener instance.
   */
  bindResident(input: {
    residentKey: string; fresh: boolean; jobId: string; accountId: string | null; generation: number;
    approval?: InternalMcpApprovalBinding | null; endpointInstance: string;
  }): { token: string } | 'rebound' | null {
    if (this.closed) {
      if (input.fresh) throw new Error('Internal MCP capability registry is closed.');
      return null;
    }
    const slotKey = `resident:${input.residentKey}`;
    if (input.fresh) {
      this.releaseResident(input.residentKey);
      this.release(input.jobId);
      if (this.slots.size >= this.maxCapabilities) throw new Error('Internal MCP capability limit reached.');
      const token = this.newToken();
      this.addSlot(slotKey, token, input.endpointInstance, true, this.newCapability(input));
      return { token };
    }
    const slot = this.slots.get(slotKey);
    if (!slot || slot.endpointInstance !== input.endpointInstance) return null;
    this.unbind(slot);
    if (this.slotByJob.get(input.jobId) !== slotKey) this.release(input.jobId);
    const capability = this.newCapability(input);
    if (slot.handshake.initialized && slot.handshake.toolsListed) {
      capability.initialized = true;
      capability.toolsListed = true;
      capability.available = true;
    }
    slot.current = capability;
    this.slotByJob.set(input.jobId, slotKey);
    if (capability.available) this.onObservation?.(input.jobId, 'available');
    return 'rebound';
  }

  /** Aborts the current capability of a slot and clears its job link. The slot and its token stay. */
  private unbind(slot: Slot): void {
    const current = slot.current;
    if (!current) return;
    slot.current = null;
    const slotKey = this.slotByDigest.get(slot.digest);
    if (slotKey !== undefined && this.slotByJob.get(current.jobId) === slotKey) this.slotByJob.delete(current.jobId);
    current.controller.abort(new Error('Internal MCP capability released'));
  }

  private findSlot(token: string): Slot | null {
    if (this.closed || !isInternalMcpToken(token)) return null;
    const presented = Buffer.from(digestOf(token), 'hex');
    for (const [digest, slotKey] of this.slotByDigest) {
      if (!timingSafeEqual(presented, Buffer.from(digest, 'hex'))) continue;
      return this.slots.get(slotKey) ?? null;
    }
    return null;
  }

  /** Resolves a presented bearer value; null when unknown, released or closed. */
  validate(token: string): InternalMcpCapability | null {
    const current = this.findSlot(token)?.current;
    return current && !current.controller.signal.aborted ? current : null;
  }

  /** Like validate, and also reports a valid resident token that has no live job (between jobs). */
  resolveToken(token: string): InternalMcpTokenResolution | null {
    const slot = this.findSlot(token);
    if (!slot) return null;
    if (slot.current && !slot.current.controller.signal.aborted) return { kind: 'job', capability: slot.current };
    if (!slot.resident) return null;
    return { kind: 'idle', slotKey: this.slotByDigest.get(slot.digest) ?? '', endpointInstance: slot.endpointInstance };
  }

  /** The last tools/list result of a resident slot, or null when the slot has none or is unknown. */
  idleToolList(slotKey: string): unknown[] | null {
    return this.slots.get(slotKey)?.lastToolList ?? null;
  }

  isLive(capability: InternalMcpCapability): boolean {
    if (this.closed || capability.controller.signal.aborted) return false;
    const slotKey = this.slotByJob.get(capability.jobId);
    return slotKey !== undefined && this.slots.get(slotKey)?.current === capability;
  }

  /** Synchronously closes admission and aborts in-flight requests for the job. A resident slot keeps its token. */
  release(jobId: string): void {
    const slotKey = this.slotByJob.get(jobId);
    if (slotKey === undefined) return;
    const slot = this.slots.get(slotKey);
    if (!slot) { this.slotByJob.delete(jobId); return; }
    if (slot.resident) { this.unbind(slot); return; }
    this.deleteSlot(slotKey, slot);
  }

  /** Deletes the resident slot with its token, and aborts its current capability. */
  releaseResident(residentKey: string): void {
    const slotKey = `resident:${residentKey}`;
    const slot = this.slots.get(slotKey);
    if (slot) this.deleteSlot(slotKey, slot);
  }

  private deleteSlot(slotKey: string, slot: Slot): void {
    this.unbind(slot);
    this.slots.delete(slotKey);
    this.slotByDigest.delete(slot.digest);
  }

  /** Records an authenticated, authorized handshake step on a live capability. */
  observe(capability: InternalMcpCapability, step: 'initialized' | 'tools_listed'): void {
    if (!this.isLive(capability)) return;
    const slot = this.slots.get(this.slotByJob.get(capability.jobId) ?? '');
    if (step === 'initialized') {
      capability.initialized = true;
      if (slot) slot.handshake.initialized = true;
    } else {
      capability.toolsListed = true;
      if (slot) slot.handshake.toolsListed = true;
    }
    this.onObservation?.(capability.jobId, step === 'initialized' ? 'initialized' : 'tools_listed');
    if (capability.initialized && capability.toolsListed && !capability.available) {
      capability.available = true;
      this.onObservation?.(capability.jobId, 'available');
    }
  }

  /** Keeps the last tools/list result of a resident slot, for answers between jobs. */
  recordToolList(capability: InternalMcpCapability, tools: unknown[]): void {
    if (!this.isLive(capability)) return;
    const slot = this.slots.get(this.slotByJob.get(capability.jobId) ?? '');
    if (slot?.resident) slot.lastToolList = tools;
  }

  releaseAll(): void {
    this.closed = true;
    for (const [slotKey, slot] of [...this.slots]) this.deleteSlot(slotKey, slot);
    this.slotByJob.clear();
  }
}
