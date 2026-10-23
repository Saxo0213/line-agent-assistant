import { afterEach, expect, it, vi } from 'vitest';

const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalRoot = process.env.LINE_WORKER_ATTACHMENT_ROOT;
afterEach(() => {
  if (originalDescriptor) Object.defineProperty(process, 'parentPort', originalDescriptor);
  else Reflect.deleteProperty(process, 'parentPort');
  if (originalRoot === undefined) delete process.env.LINE_WORKER_ATTACHMENT_ROOT;
  else process.env.LINE_WORKER_ATTACHMENT_ROOT = originalRoot;
});

it('unwraps Electron MessageEvent data and discards malformed private-port events', async () => {
  const posted: unknown[] = [];
  let incoming: ((event: unknown) => void) | undefined;
  Object.defineProperty(process, 'parentPort', { configurable: true, value: {
    on: (_event: string, listener: (event: unknown) => void) => { incoming = listener; },
    postMessage: (value: unknown) => { posted.push(value); },
  } });
  process.env.LINE_WORKER_ATTACHMENT_ROOT = 'C:\\line-worker-test-attachments';
  vi.resetModules();
  await import('./process-entry.js');

  const init = { type: 'init', protocolVersion: 4, accountId: 'account-A', workerInstanceId: 'worker-1',
    controlEpoch: 7, mode: 'MONITOR_ONLY', durableCursor: {
      version: 1, revision: '0', globalRev: '0', individualRev: '0',
    } };
  incoming?.({ data: init, ports: [] });
  await vi.waitFor(() => expect(posted).toContainEqual({ type: 'modeAck', accountId: 'account-A',
    workerInstanceId: 'worker-1', controlEpoch: 7, mode: 'MONITOR_ONLY', drained: true }));

  incoming?.({ ports: [], type: 'stop', accountId: 'account-A' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(posted).toHaveLength(2);
  expect(posted[0]).toMatchObject({ type: 'workerProtocolAck', protocolVersion: 4, manualSend: true });
});
