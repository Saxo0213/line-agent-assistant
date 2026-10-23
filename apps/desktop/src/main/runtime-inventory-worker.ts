import { WORKER_PROTOCOL_VERSION } from '@line-agent/contracts';

type ParentPort = { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void };
type InventoryProcess = NodeJS.Process & { parentPort?: ParentPort };

const port = (process as InventoryProcess).parentPort;
if (!port) throw new Error('Runtime inventory fixture must run as an Electron utility process');

let binding: { accountId: string; workerInstanceId: string; controlEpoch: number;
  transportOwnerId: string; transportGeneration: number; writeGrantVersion: number } | undefined;
port.on('message', (event) => {
  const data = event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event;
  if (!data || typeof data !== 'object') return;
  const command = data as Record<string, unknown>;
  if (command.type === 'init') {
    binding = { accountId: String(command.accountId), workerInstanceId: String(command.workerInstanceId), controlEpoch: Number(command.controlEpoch),
      transportOwnerId: String(command.transportOwnerId), transportGeneration: Number(command.transportGeneration),
      writeGrantVersion: Number(command.writeGrantVersion) };
    port.postMessage({ type: 'workerProtocolAck', ...binding, protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
    port.postMessage({ type: 'modeAck', ...binding, mode: String(command.mode), drained: true });
  }
  if (command.type === 'runtimeInventoryBurst' && binding) {
    let emitted = 0;
    const emitBatch = () => {
      for (let count = 0; count < 64 && emitted < 10_000; count += 1, emitted += 1) {
        port.postMessage({ type: 'status', ...binding, state: 'ready', message: `inventory-${emitted}` });
      }
      if (emitted < 10_000) setImmediate(emitBatch);
      else port.postMessage({ type: 'status', ...binding, state: 'ready', message: 'runtime-inventory-burst-complete' });
    };
    emitBatch();
  }
});
