import { describe, expect, it } from 'vitest';
import { ExternalSourceProbeAdmissionGate } from './external-source-probe-admission.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('shared external source probe admission queue', () => {
  it('waits for the slot and obtains it after release, without external_probe_busy', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    let acquired = false;
    const second = admission.acquire().then((release) => { acquired = true; return release; });
    await tick();
    expect(acquired).toBe(false);
    expect(admission.isBusy()).toBe(true);
    first();
    const secondRelease = await second;
    expect(admission.isBusy()).toBe(true);
    secondRelease();
    expect(admission.isBusy()).toBe(false);
  });

  it('serves waiters in FIFO order', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) => admission.acquire().then((release) => { order.push(n); release(); }));
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(admission.isBusy()).toBe(false);
  });

  it('removes an aborted waiter and still serves the later waiter', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    const abort = new AbortController();
    const aborted = admission.acquire(abort.signal);
    const later = admission.acquire();
    abort.abort(new Error('operator_cancelled'));
    await expect(aborted).rejects.toThrow('operator_cancelled');
    first();
    const laterRelease = await later;
    laterRelease();
    expect(admission.isBusy()).toBe(false);
  });

  it('rejects an already aborted signal and never queues it', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const abort = new AbortController();
    abort.abort();
    await expect(admission.acquire(abort.signal)).rejects.toBeDefined();
    expect(admission.isBusy()).toBe(false);
  });

  it('rejects the fifth concurrent waiter with external_probe_queue_full', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    const waiters = [1, 2, 3, 4].map(() => admission.acquire().then((release) => release()));
    await expect(admission.acquire()).rejects.toThrow('external_probe_queue_full');
    first();
    await Promise.all(waiters);
    expect(admission.isBusy()).toBe(false);
  });

  it('keeps release idempotent so a stale release cannot free the next owner', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    const next = admission.acquire();
    first();
    const nextRelease = await next;
    first(); // delayed duplicate cleanup
    expect(admission.isBusy()).toBe(true);
    expect(nextRelease.isCurrentOwner()).toBe(true);
    nextRelease();
    expect(admission.isBusy()).toBe(false);
  });

  it('does not flag a slot handed to the next waiter as still owned by the releaser', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const first = await admission.acquire();
    const next = admission.acquire();
    expect(first.isCurrentOwner()).toBe(true);
    first();
    expect(first.isCurrentOwner()).toBe(false);
    expect(admission.isBusy()).toBe(true);
    (await next)();
    expect(admission.isBusy()).toBe(false);
  });
});
