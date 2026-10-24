import { describe, expect, it, vi } from 'vitest';
import { createManualMediaAdmission } from './manual-media-admission.js';

describe('manual media admission', () => {
  it('bounds burst requests globally and per account, then releases capacity', () => {
    const admission = createManualMediaAdmission({ globalLimit: 2, perAccountLimit: 1 });
    const first = admission.acquire('account-a');
    const second = admission.acquire('account-b');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(admission.acquire('account-a')).toBeNull();
    expect(admission.acquire('account-c')).toBeNull();
    first!.release();
    expect(admission.acquire('account-c')).not.toBeNull();
    second!.release();
    admission.shutdown();
  });

  it('propagates request cancellation and aborts owned work during shutdown', () => {
    const admission = createManualMediaAdmission();
    const request = new AbortController();
    const lease = admission.acquire('account-a', request.signal)!;
    const aborted = vi.fn();
    lease.signal.addEventListener('abort', aborted);
    request.abort();
    expect(lease.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
    lease.release();

    const active = admission.acquire('account-b')!;
    admission.shutdown();
    expect(active.signal.aborted).toBe(true);
    expect(admission.acquire('account-c')).toBeNull();
    active.release();
  });
});
