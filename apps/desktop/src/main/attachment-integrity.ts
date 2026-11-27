// Integrity of the stored file of a ready attachment. Every reader of a ready file (preview, image read, open) reports what it saw
// and calls `settle`. `settle` classifies the failure and repairs the row. Only the real code is written, never a generic one.
import type { SafeDiagnostic, DiagnosticIdentity } from '@line-agent/contracts';

export const ATTACHMENT_FILE_MISSING = 'ATTACHMENT_FILE_MISSING';
export const ATTACHMENT_INTEGRITY_MISMATCH = 'ATTACHMENT_INTEGRITY_MISMATCH';
export const ATTACHMENT_SIZE_RECORD_CORRECTED = 'ATTACHMENT_SIZE_RECORD_CORRECTED';

/** The row of a ready attachment, as the reader read it. */
export type IntegrityRecord = { attachmentId: string; accountId?: string | undefined; relativePath: string; sizeBytes: number; sha256: string };

/**
 * What the reader saw in the managed file.
 * `missing`: the file is absent or cannot be read. `read`: the whole file was read.
 * A content check (format, active prefix, dimensions) is not part of the integrity: a file with the right SHA-256 is the downloaded file.
 */
export type IntegrityObservation =
  | { kind: 'missing' }
  | { kind: 'read'; byteLength: number; sha256: string };

export type IntegrityVerdict =
  | { kind: 'ok' }
  | { kind: 'size_record_wrong'; actualSize: number }
  | { kind: 'missing' }
  | { kind: 'integrity_mismatch' };

/** Failure classes: (a) missing, (b) wrong row size with a correct file, (c) other content mismatch. */
export function classifyReadyFile(record: IntegrityRecord, observation: IntegrityObservation): IntegrityVerdict {
  if (observation.kind === 'missing') return { kind: 'missing' };
  const hashMatches = observation.sha256.toLowerCase() === record.sha256.toLowerCase();
  if (!hashMatches) return { kind: 'integrity_mismatch' };
  if (observation.byteLength !== record.sizeBytes) return { kind: 'size_record_wrong', actualSize: observation.byteLength };
  return { kind: 'ok' };
}

export type IntegritySettlement =
  | { action: 'serve' }
  | { action: 'size_corrected'; sizeBytes: number }
  | { action: 'repair_started' | 'repair_exhausted'; code: string }
  | { action: 'unchanged' };

export interface AttachmentIntegrityRepository {
  correctReadyAttachmentSize(attachmentId: string, sha256: string, sizeBytes: number): Promise<boolean>;
  moveReadyAttachmentOutOfReady(attachmentId: string, sha256: string, code: string, automaticAttemptLimit: number): Promise<{ exhausted: boolean } | null>;
}

export interface AttachmentIntegrityOptions {
  repository: AttachmentIntegrityRepository;
  /** Starts a new download through the manual download path of the attachment service. */
  requeue(attachmentId: string, accountId: string | undefined): Promise<unknown>;
  /** The automatic attempt limit now in force. */
  attemptLimit(): number;
  onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: DiagnosticIdentity) => void;
  /** Tells the renderer that the row changed. */
  notifyChanged?: (attachmentId: string) => void;
}

export interface AttachmentIntegrity {
  /** Classifies what the reader saw and repairs the row. It never throws. */
  settle(record: IntegrityRecord, observation: IntegrityObservation): Promise<IntegritySettlement>;
}

function diagnostic(code: string, outcome: SafeDiagnostic['outcome']): SafeDiagnostic {
  return { operation: 'attachment', stage: 'read', category: outcome === 'recovered' ? 'invalid_response' : 'persistence_failed',
    recovery: outcome === 'recovered' ? 'none' : 'retry', outcome, detail: code };
}

export function createAttachmentIntegrity(options: AttachmentIntegrityOptions): AttachmentIntegrity {
  const report = (record: IntegrityRecord, code: string, outcome: SafeDiagnostic['outcome']): void => {
    try {
      options.onDiagnostic?.(diagnostic(code, outcome), { requestId: record.attachmentId, ...(record.accountId ? { accountId: record.accountId } : {}) });
    } catch { /* The audit must not change the repair. */ }
  };
  return {
    async settle(record, observation): Promise<IntegritySettlement> {
      try {
        const verdict = classifyReadyFile(record, observation);
        if (verdict.kind === 'ok') return { action: 'serve' };
        if (verdict.kind === 'size_record_wrong') {
          // The file is the downloaded file: its SHA-256 equals the row. Only the row size was wrong.
          if (!await options.repository.correctReadyAttachmentSize(record.attachmentId, record.sha256, verdict.actualSize)) return { action: 'unchanged' };
          report(record, ATTACHMENT_SIZE_RECORD_CORRECTED, 'recovered');
          options.notifyChanged?.(record.attachmentId);
          return { action: 'size_corrected', sizeBytes: verdict.actualSize };
        }
        const code = verdict.kind === 'missing' ? ATTACHMENT_FILE_MISSING : ATTACHMENT_INTEGRITY_MISMATCH;
        const moved = await options.repository.moveReadyAttachmentOutOfReady(record.attachmentId, record.sha256, code, options.attemptLimit());
        // Another reader moved the row first, or the row is no longer the checked one. One audit row for each move.
        if (!moved) return { action: 'unchanged' };
        report(record, code, 'failed');
        options.notifyChanged?.(record.attachmentId);
        if (moved.exhausted) return { action: 'repair_exhausted', code };
        // The same path as the manual download button: it is not paced and it keeps the real result in the row.
        void Promise.resolve(options.requeue(record.attachmentId, record.accountId)).catch((error: unknown) => {
          try {
            const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
            options.onDiagnostic?.({ operation: 'attachment', stage: 'queue', category: 'unknown', recovery: 'retry', outcome: 'failed',
              detail: typeof value === 'string' && /^[A-Z0-9_]{2,64}$/.test(value) ? `REQUEUE_${value}` : 'REQUEUE_FAILED' },
            { requestId: record.attachmentId, ...(record.accountId ? { accountId: record.accountId } : {}) });
          } catch { /* observer only */ }
        });
        return { action: 'repair_started', code };
      } catch (error) {
        const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        try {
          options.onDiagnostic?.({ operation: 'attachment', stage: 'persist', category: 'persistence_failed', recovery: 'retry', outcome: 'failed',
            detail: typeof value === 'string' && /^[A-Z0-9_]{2,64}$/.test(value) ? `INTEGRITY_${value}` : 'INTEGRITY_REPAIR_FAILED' },
          { requestId: record.attachmentId, ...(record.accountId ? { accountId: record.accountId } : {}) });
        } catch { /* observer only */ }
        return { action: 'unchanged' };
      }
    },
  };
}
