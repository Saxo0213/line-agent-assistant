import type { WorkerBinding } from '@line-agent/contracts';

/** Copies exactly the strict WorkerBinding wire fields, dropping runtime extras such as mode/purpose/expectedMid. */
export function pickWorkerBinding(binding: WorkerBinding): WorkerBinding {
  return {
    accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
    ...(binding.transportOwnerId !== undefined ? { transportOwnerId: binding.transportOwnerId } : {}),
    ...(binding.transportGeneration !== undefined ? { transportGeneration: binding.transportGeneration } : {}),
    ...(binding.writeGrantVersion !== undefined ? { writeGrantVersion: binding.writeGrantVersion } : {}),
  };
}
