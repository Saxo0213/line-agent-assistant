import { describe, expect, it, vi } from 'vitest';
import { createWorkerSupervisor } from './worker-supervisor.js';

describe('LINE worker supervisor', () => {
  it('starts one bound process per account and stops each on shutdown', async () => {
    const workers: { accountId: string; stop: () => void }[] = [];
    const supervisor = createWorkerSupervisor({ spawn: (accountId) => { const worker = { accountId, stop: vi.fn() }; workers.push(worker); return worker; }, maxRestarts: 1 });
    supervisor.start('A'); supervisor.start('A'); supervisor.start('B');
    expect(workers.map((worker) => worker.accountId)).toEqual(['A', 'B']);
    await supervisor.shutdown();
    expect(workers.every((worker) => vi.mocked(worker.stop).mock.calls.length === 1)).toBe(true);
  });
});
