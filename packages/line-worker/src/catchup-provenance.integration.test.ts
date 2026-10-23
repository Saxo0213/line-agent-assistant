import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  syncResponse: {
    fullSyncResponse: { nextRevision: 9n },
    operationResponse: {
      globalEvents: { lastRevision: 2n }, individualEvents: { lastRevision: 3n },
      operations: [{ revision: 9n, type: 'NOTIFIED_READ_MESSAGE', param1: 'u-admin' }],
    },
  },
  history: [{ id: '8', from: 'admin', to: 'u-self', contentType: 'NONE', text: '/new', createdTime: 1760522400000 }],
}));

vi.mock('@evex/linejs/base', () => ({
  BaseClient: class {
    authToken?: string;
    profile = { mid: 'u-self', displayName: 'Agent' };
    readonly request: any;
    readonly talk: any;
    readonly e2ee = { async decryptE2EEMessage(message: unknown) { return message; } };
    readonly loginProcess = { async login() { return {}; } };
    readonly thrift = { writeThrift() { return new Uint8Array([1]); } };
    constructor(options: { fetch(request: Request): Promise<Response> }) {
      this.request = {
        endpoint: 'legy.line-apps.com',
        getHeader: () => ({}),
        request: async (_value: unknown, methodName: string) => {
          await options.fetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }));
          return methodName === 'sync' ? fixture.syncResponse : fixture.history;
        },
      };
      this.talk = {
        async sync() { return await thisClient.request.request({}, 'sync', 4, true, '/SYNC4'); },
        async getRecentMessagesV2() { return await thisClient.request.request({}, 'getRecentMessagesV2', 4, true, '/S4'); },
      };
      const thisClient = this;
    }
    on() { return this; }
  },
}));

import { routeTrigger } from '../../../apps/desktop/src/main/services/trigger-router.js';
import { LineWorkerLoop } from './worker-loop.js';
import { createLinejsAdapter } from './linejs-adapter.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');

it('keeps adapter read-receipt catch-up history out of live command and Agent routing', async () => {
  const adapter = await createLinejsAdapter({ ...binding, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport: adapter, emit: (event) => { events.push(event); }, validateLease: () => false });
  await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: jwt, qrCert: null, e2eeStorage: null } });
  await worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  await worker.handle({ type: 'poll', ...binding });

  const batch = events.find((event) => event.type === 'batch');
  expect(batch.envelopes[0].ingestion.source).toBe('history');
  expect(routeTrigger(batch.envelopes[0], { ownMid: 'u-self', agentEnabled: true, senderIsPrimaryAdmin: true,
    workspaceConfigured: true, defaultProvider: 'codex' })).toEqual({ type: 'ignore' });
});
