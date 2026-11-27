export type EffectPhase = "AUTH_BOOTSTRAP" | "MONITOR_READ" | "CONTROL_READ" | "CONTROL_SEND" | "MANUAL_SEND" | "CHAT_RESOURCE_BOOTSTRAP" | "SERVER_LOGOUT";
export type ControlLeasePhase = "CONTROL_READ" | "CONTROL_SEND" | "MANUAL_SEND";
export type ControlLease = Readonly<{ accountId: string; workerInstanceId: string; controlEpoch: number }>;

export class EffectDeniedError extends Error {
  readonly code = "SIDE_EFFECT_DENIED";
  constructor(readonly reason: string) {
    super(`LINE effect denied: ${reason}`);
    this.name = "EffectDeniedError";
  }
}

export type MediaUploadKind = "image" | "file";
/** Per-send OBS upload permit: bound to one lease, at most 2 POSTs, each path once. */
export type MediaUploadScope = Readonly<{ kind: MediaUploadKind; lease: ControlLease; manual: boolean; close(): void }>;

export function deny(reason: string): never { throw new EffectDeniedError(reason); }
export function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) deny(`${field} must be a non-empty string`);
}
export function copyLease(lease: ControlLease | undefined, phase: string): ControlLease {
  if (lease === undefined) return deny(`${phase} requires a control lease`);
  assertIdentity(lease.accountId, "lease.accountId");
  assertIdentity(lease.workerInstanceId, "lease.workerInstanceId");
  if (!Number.isSafeInteger(lease.controlEpoch) || lease.controlEpoch < 0) return deny("invalid control epoch");
  return Object.freeze({ ...lease });
}
