import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LineWorkerEventSchema, LineWorkerCommandSchema, type LineWorkerCommand } from '@line-agent/contracts';
import { createTransportFactory, runWorkerLoopOnPort } from './entrypoint.js';
import { FakeLineTransport } from './fake-transport.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
type Init = Extract<LineWorkerCommand, { type: 'init' }>;
const init = (extra: Record<string, unknown> = {}): Init => LineWorkerCommandSchema.parse({ type: 'init', ...binding, protocolVersion: 4,
  mode: 'MONITOR_ONLY', durableCursor: cursor, ...extra }) as Init;

function port() {
  const events: any[] = [];
  const eventWaiters = new Set<{ count: number; resolve: (events: any[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let handler: ((value: unknown) => void) | undefined;
  return { events,
    onMessage: (next: (value: unknown) => void) => { handler = next; },
    postMessage: (value: unknown) => {
      events.push(LineWorkerEventSchema.parse(value));
      for (const waiter of eventWaiters) {
        if (events.length >= waiter.count) {
          clearTimeout(waiter.timer);
          eventWaiters.delete(waiter);
          waiter.resolve(events);
        }
      }
    },
    send: async (value: unknown) => { handler?.(value); },
    waitForEvents: (count: number) => {
      if (events.length >= count) return Promise.resolve(events);
      return new Promise<any[]>((resolve, reject) => {
        const waiter = { count, resolve, reject, timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${count} worker event(s); received ${events.length}`));
        }, 5000) };
        eventWaiters.add(waiter);
      });
    },
  };
}

it('builds the DESKTOPWIN adapter exactly as before when lineTransport is absent or DESKTOPWIN', async () => {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const createLinejs = vi.fn(async () => transport as never);
  const createChrome = vi.fn(async () => transport as never);
  const factory = createTransportFactory({ createLinejs, createChrome });
  await factory(init());
  await factory(init({ lineTransport: 'DESKTOPWIN' }));
  expect(createChrome).not.toHaveBeenCalled();
  expect(createLinejs).toHaveBeenCalledTimes(2);
  expect(createLinejs.mock.calls[0]![0]).toEqual({ ...binding, mode: 'MONITOR_ONLY', validateLease: expect.any(Function),
    physicalTransport: expect.any(Function) });
  expect(Object.keys(createLinejs.mock.calls[0]![0]).sort()).toEqual(['accountId', 'controlEpoch', 'mode', 'physicalTransport', 'validateLease', 'workerInstanceId']);
  await factory(init({ purpose: 'DOWNLOAD_ONLY', application: 'DESKTOPWIN\t9.9.9\tWINDOWS\t10.0' }));
  expect(createLinejs.mock.calls[2]![0]).toMatchObject({ application: 'DESKTOPWIN\t9.9.9\tWINDOWS\t10.0' });
});

it('builds the Chrome adapter for lineTransport CHROMEOS with the store root and Node fetch', async () => {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const createLinejs = vi.fn(async () => transport as never);
  const createChrome = vi.fn(async () => transport as never);
  const chromeFetch = vi.fn(async () => new Response('{}'));
  const factory = createTransportFactory({ createLinejs, createChrome, chromeFetch });
  await factory(init({ lineTransport: 'CHROMEOS', chromeLtsmDir: '/abs/line-chrome/ltsm' }));
  await factory(init({ lineTransport: 'CHROMEOS', application: 'CHROMEOS\t3.7.2\tChrome_OS\t' }));
  expect(createLinejs).not.toHaveBeenCalled();
  expect(createChrome.mock.calls[0]![0]).toMatchObject({ ...binding, mode: 'MONITOR_ONLY', ltsmRoot: '/abs/line-chrome/ltsm', fetch: expect.any(Function) });
  expect(createChrome.mock.calls[1]![0]).not.toHaveProperty('ltsmRoot');
  await createChrome.mock.calls[0]![0].fetch('https://example.invalid/x', { method: 'GET' }).catch(() => undefined);
});

it('uses the global fetch (undici) for CHROMEOS by default', async () => {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const createChrome = vi.fn(async () => transport as never);
  const nativeFetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', nativeFetch);
  try {
    await createTransportFactory({ createChrome })(init({ lineTransport: 'CHROMEOS' }));
    await createChrome.mock.calls[0]![0].fetch('https://line-chrome-gw.line-apps.com/x', { method: 'GET' });
    expect(nativeFetch).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

async function bootstrap(chromeLtsmDir: string | undefined): Promise<any[]> {
  const channel = port();
  runWorkerLoopOnPort(channel, createTransportFactory());
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor,
    lineTransport: 'CHROMEOS', ...(chromeLtsmDir === undefined ? {} : { chromeLtsmDir }) });
  await channel.waitForEvents(1);
  return channel.events;
}

it('fails the CHROMEOS bootstrap with CHROME_LTSM_UNAVAILABLE and the store status when no store exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-ltsm-'));
  try {
    const missingDir = join(root, 'nothing-here');
    for (const events of [await bootstrap(missingDir), await bootstrap(undefined)]) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', ...binding, code: 'CHROME_LTSM_UNAVAILABLE', retryable: false,
        chromeLtsmStatus: 'missing', diagnostic: { operation: 'init', stage: 'bootstrap', category: 'unavailable', recovery: 'check_configuration' } });
      expect(events[0].message).toContain('3.7.2');
      expect(JSON.stringify(events)).not.toContain(root);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports a corrupt store without leaking its path or file contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-ltsm-'));
  try {
    const versionDir = join(root, '3.7.2');
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, 'ltsm.wasm'), 'not the pinned wasm');
    await writeFile(join(versionDir, 'ltsmSandbox.js'), 'not the pinned sandbox');
    const events = await bootstrap(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'CHROME_LTSM_UNAVAILABLE', chromeLtsmStatus: 'corrupt' });
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain('not the pinned');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps the process alive after a failed CHROMEOS bootstrap and rejects further commands normally', async () => {
  const channel = port();
  runWorkerLoopOnPort(channel, createTransportFactory());
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor, lineTransport: 'CHROMEOS' });
  await channel.waitForEvents(1);
  await channel.send({ type: 'poll', ...binding });
  await channel.waitForEvents(2);
  expect(channel.events[0]).toMatchObject({ type: 'error', code: 'CHROME_LTSM_UNAVAILABLE' });
  expect(channel.events[1]).toMatchObject({ type: 'error' });
});
