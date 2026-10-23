import { pathToFileURL } from 'node:url';

const parentPort = process.parentPort;
const workerRoot = process.env.LINE_AGENT_SMOKE_WORKER_ROOT;
if (!parentPort || !workerRoot) throw new Error('smoke worker private port and packaged worker root are required');

const [{ runWorkerLoopOnPort }, { FakeLineTransport }, { verifyLinejsPackage }] = await Promise.all([
  import(pathToFileURL(`${workerRoot}/entrypoint.js`).href),
  import(pathToFileURL(`${workerRoot}/fake-transport.js`).href),
  import(pathToFileURL(`${workerRoot}/version.js`).href),
]);
const verification = await verifyLinejsPackage(`${workerRoot}/node_modules/@evex/linejs`);
if (verification.status !== 'verified') throw new Error(`packaged production LINEJS gateway is ${verification.status}`);
const port = {
  onMessage(handler) {
    parentPort.on('message', (event) => {
      if (event && typeof event === 'object' && 'data' in event) handler(event.data);
    });
  },
  postMessage(event) { parentPort.postMessage(event); },
};
runWorkerLoopOnPort(port, async () => new FakeLineTransport({ ownMid: 'u-smoke', displayName: 'Packaged smoke' }), {
  attachmentRoot: process.env.LINE_AGENT_SMOKE_ATTACHMENT_ROOT,
  minFreeBytes: 1,
});
