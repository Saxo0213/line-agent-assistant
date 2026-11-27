import { describe, expect, it, vi } from 'vitest';
import { classifyReadyFile, createAttachmentIntegrity, type IntegrityRecord } from './attachment-integrity.js';

const record: IntegrityRecord = { attachmentId: 'a1', accountId: 'acc', relativePath: 'x/att.blob', sizeBytes: 233484, sha256: 'a'.repeat(64) };

function harness(moved: { exhausted: boolean } | null = { exhausted: false }) {
  const repository = { correctReadyAttachmentSize: vi.fn(async () => true), moveReadyAttachmentOutOfReady: vi.fn(async () => moved) };
  const diagnostics: unknown[] = [];
  const requeue = vi.fn(async () => true);
  const integrity = createAttachmentIntegrity({ repository, requeue, attemptLimit: () => 3, onDiagnostic: (value) => diagnostics.push(value) });
  return { repository, requeue, diagnostics, integrity };
}

describe('ready attachment integrity', () => {
  it('(b) a correct file with a wrong row size corrects the row size and writes one audit row', async () => {
    const h = harness();
    const observation = { kind: 'read' as const, byteLength: 233452, sha256: 'A'.repeat(64) };
    expect(classifyReadyFile(record, observation)).toEqual({ kind: 'size_record_wrong', actualSize: 233452 });
    expect(await h.integrity.settle(record, observation)).toEqual({ action: 'size_corrected', sizeBytes: 233452 });
    expect(h.repository.correctReadyAttachmentSize).toHaveBeenCalledWith('a1', record.sha256, 233452);
    expect(h.repository.moveReadyAttachmentOutOfReady).not.toHaveBeenCalled();
    expect(h.requeue).not.toHaveBeenCalled();
    expect(h.diagnostics).toMatchObject([{ operation: 'attachment', detail: 'ATTACHMENT_SIZE_RECORD_CORRECTED' }]);
  });

  it('(c) a hash mismatch moves the row out of ready with the real code and starts one new download', async () => {
    const h = harness();
    const observation = { kind: 'read' as const, byteLength: 233484, sha256: 'b'.repeat(64) };
    expect(await h.integrity.settle(record, observation)).toEqual({ action: 'repair_started', code: 'ATTACHMENT_INTEGRITY_MISMATCH' });
    expect(h.repository.moveReadyAttachmentOutOfReady).toHaveBeenCalledWith('a1', record.sha256, 'ATTACHMENT_INTEGRITY_MISMATCH', 3);
    expect(h.repository.correctReadyAttachmentSize).not.toHaveBeenCalled();
    expect(h.requeue).toHaveBeenCalledTimes(1);
    expect(h.diagnostics).toMatchObject([{ detail: 'ATTACHMENT_INTEGRITY_MISMATCH' }]);
  });

  it('a correct hash is never a repair: the row is not moved and no download starts', async () => {
    const h = harness();
    const observation = { kind: 'read' as const, byteLength: 233484, sha256: 'a'.repeat(64) };
    expect(classifyReadyFile(record, observation)).toEqual({ kind: 'ok' });
    expect(await h.integrity.settle(record, observation)).toEqual({ action: 'serve' });
    expect(h.repository.moveReadyAttachmentOutOfReady).not.toHaveBeenCalled();
    expect(h.requeue).not.toHaveBeenCalled();
    expect(h.diagnostics).toEqual([]);
  });

  it('(a) a missing file uses ATTACHMENT_FILE_MISSING, and an exhausted attempt limit starts no new download', async () => {
    const h = harness({ exhausted: true });
    expect(await h.integrity.settle(record, { kind: 'missing' })).toEqual({ action: 'repair_exhausted', code: 'ATTACHMENT_FILE_MISSING' });
    expect(h.requeue).not.toHaveBeenCalled();
    expect(h.diagnostics).toMatchObject([{ detail: 'ATTACHMENT_FILE_MISSING' }]);
  });

  it('writes no audit row when another reader already moved the row', async () => {
    const h = harness(null);
    expect(await h.integrity.settle(record, { kind: 'missing' })).toEqual({ action: 'unchanged' });
    expect(h.diagnostics).toEqual([]);
    expect(h.requeue).not.toHaveBeenCalled();
  });
});
