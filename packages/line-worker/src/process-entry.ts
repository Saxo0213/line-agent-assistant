import { startLineWorkerProcess, type WorkerPort } from './entrypoint.js';

// Electron utilityProcess exposes a private parentPort. Main owns its lifecycle
// and passes the managed attachment root in the process environment.
type ElectronParentPort = {
  on(event: 'message', listener: (value: unknown) => void): void;
  postMessage(value: unknown): void;
};
const parentPort = (process as typeof process & { parentPort?: ElectronParentPort }).parentPort;
const attachmentRoot = process.env.LINE_WORKER_ATTACHMENT_ROOT;
if (!parentPort || !attachmentRoot) throw new Error('private worker port and attachment root are required');

const port: WorkerPort = {
  onMessage: (handler) => parentPort.on('message', (event) => {
    try {
      if (typeof event !== 'object' || event === null || !('data' in event) ||
        !Array.isArray((event as { ports?: unknown }).ports)) return;
      handler((event as { data: unknown }).data);
    } catch { /* Malformed private-port events never become worker commands. */ }
  }),
  postMessage: (event) => parentPort.postMessage(event),
};
startLineWorkerProcess(port, { attachmentRoot });
