import { randomUUID } from 'node:crypto';
import type { ExternalBatchFence, ExternalObservation, ExternalObservationBatch } from '@line-agent/database';

export interface ExternalMonitorAdapter {
  verifySource(input: { accountId: string; ownMid: string }): Promise<{ sourceIdentity: string }>;
  readBatch(input: { accountId: string; sourceId: string; generation: number; fence: ExternalBatchFence;
    cursor: Record<string, unknown> | null; limit: number }): Promise<ExternalObservationBatch>;
}

export function createFakeExternalMonitorAdapter(observations: ExternalObservation[] = []): ExternalMonitorAdapter {
  return {
    async verifySource({ accountId, ownMid }) { return { sourceIdentity: `fake:${accountId}:${ownMid}` }; },
    async readBatch(input) {
      const limit = Math.max(1, Math.min(100, Number.isSafeInteger(input.limit) ? input.limit : 1));
      return { accountId: input.accountId, sourceId: input.sourceId, generation: input.generation,
        expectedModeRevision: input.fence.expectedModeRevision, expectedCheckpoint: input.fence.expectedCheckpoint,
        batchId: randomUUID(), cursor: { offset: Math.min(observations.length, limit) }, observations: observations.slice(0, limit) };
    },
  };
}
