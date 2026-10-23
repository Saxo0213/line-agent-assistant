import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AttachmentPreviewService, type PreviewRecord } from './attachment-preview.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile) };
});

const ID = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const openedHandles: Array<{ close: () => Promise<void> }> = [];
const openImageOriginal = vi.mocked(open).getMockImplementation()!;
const lstatImageOriginal = vi.mocked(lstat).getMockImplementation()!;
const writeImageOriginal = vi.mocked(writeFile).getMockImplementation()!;

afterEach(async () => {
  vi.mocked(open).mockImplementation(openImageOriginal);
  vi.mocked(lstat).mockImplementation(lstatImageOriginal);
  vi.mocked(writeFile).mockImplementation(writeImageOriginal);
  for (const handle of openedHandles.splice(0)) await handle.close().catch(() => undefined);
});

async function setup(cacheRoot?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'line-preview-cancel-'));
  const relativePath = `accounts/a/att-${'b'.repeat(64)}.blob`;
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), PNG);
  const item: PreviewRecord = {
    attachmentId: ID, accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
    kind: 'image', name: 'photo.png', mimeType: 'image/png', status: 'ready', relativePath,
    sizeBytes: PNG.byteLength, sha256: createHash('sha256').update(PNG).digest('hex'),
  };
  const service = new AttachmentPreviewService({ root, ...(cacheRoot ? { cacheRoot } : {}), authority: { lookup: async () => item },
    presenter: { async present() { return false; }, closeAll() {} } });
  const cleanup = async () => { service.shutdown(); await rm(root, { recursive: true, force: true }); if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }); };
  return { root, item, service, cleanup };
}

it('cancels a queued cache write on abort and shutdown and removes its temporary file', async () => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cancel-cache-'));
  const { service, cleanup } = await setup(cacheRoot);
  let writeStarted!: () => void;
  let releaseWrite!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    writeStarted();
    await gate;
    return await writeImageOriginal(...args);
  });
  const controller = new AbortController();
  try {
    const pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal);
    await started;
    controller.abort();
    service.shutdown();
    releaseWrite();
    await expect(pending).resolves.toBeNull();
    await vi.waitFor(async () => expect(await readdir(cacheRoot)).toEqual([]));
  } finally {
    releaseWrite();
    await cleanup();
  }
});

it('closes a held image handle immediately when cancellation arrives during read', async () => {
  const { service, cleanup } = await setup();
  const openSpy = vi.mocked(open);
  const originalOpen = openImageOriginal;
  let readStarted!: () => void;
  let finishRead!: () => void;
  let closeCalled!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
  const closed = new Promise<void>((resolve) => { closeCalled = resolve; });
  let closeCalls = 0;
  openSpy.mockImplementation((...args) => (async () => {
    const handle = await originalOpen(...args);
    openedHandles.push(handle);
    const realClose = handle.close.bind(handle);
    Object.defineProperty(handle, 'read', { configurable: true, value: vi.fn(async (buffer: Buffer) => {
      readStarted();
      await readGate;
      return { bytesRead: buffer.byteLength, buffer };
    }) });
    Object.defineProperty(handle, 'close', { configurable: true, value: vi.fn(async () => {
      closeCalls++;
      closeCalled();
      await realClose();
    }) });
    return handle;
  })());
  const controller = new AbortController();
  try {
    let readImageSettled = false;
    const pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal).finally(() => { readImageSettled = true; });
    await started;
    controller.abort();
    const closedBeforeReadCompletion = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closedBeforeReadCompletion).toBe(true);
    expect(closeCalls).toBe(1);
    expect(readImageSettled).toBe(false);
    finishRead();
    await expect(pending).resolves.toBeNull();
    expect(readImageSettled).toBe(true);
  } finally {
    finishRead();
    await cleanup();
    openSpy.mockImplementation(openImageOriginal);
  }
});

it('closes an image handle that opens after its read was cancelled', async () => {
  const { service, cleanup } = await setup();
  const openSpy = vi.mocked(open);
  const originalOpen = openImageOriginal;
  let finishOpen!: () => void;
  let finishStat!: () => void;
  let openStarted!: () => void;
  let closeCalled!: () => void;
  const openGate = new Promise<void>((resolve) => { finishOpen = resolve; });
  const statGate = new Promise<void>((resolve) => { finishStat = resolve; });
  const started = new Promise<void>((resolve) => { openStarted = resolve; });
  const closed = new Promise<void>((resolve) => { closeCalled = resolve; });
  let closeCalls = 0;
  openSpy.mockImplementation((...args) => (async () => {
    openStarted();
    await openGate;
    const handle = await originalOpen(...args);
    openedHandles.push(handle);
    const realClose = handle.close.bind(handle);
    Object.defineProperty(handle, 'close', { configurable: true, value: vi.fn(async () => {
      closeCalls++;
      closeCalled();
      await realClose();
    }) });
    return handle;
  })());
  const controller = new AbortController();
  try {
    const pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal);
    await started;
    controller.abort();
    finishOpen();
    await closed;
    await expect(pending).resolves.toBeNull();
    expect(closeCalls).toBe(1);
  } finally {
    finishOpen();
    await cleanup();
    openSpy.mockImplementation(openImageOriginal);
  }
});

it('closes a late-opened handle before its pending stat verification can continue', async () => {
  const { service, cleanup } = await setup();
  const openSpy = vi.mocked(open);
  const originalOpen = openImageOriginal;
  let finishOpen!: () => void;
  let finishStat!: () => void;
  let openStarted!: () => void;
  let closeCalled!: () => void;
  const openGate = new Promise<void>((resolve) => { finishOpen = resolve; });
  const statGate = new Promise<void>((resolve) => { finishStat = resolve; });
  const started = new Promise<void>((resolve) => { openStarted = resolve; });
  const closed = new Promise<void>((resolve) => { closeCalled = resolve; });
  let closeCalls = 0;
  openSpy.mockImplementation((...args) => (async () => {
    openStarted();
    await openGate;
    const handle = await originalOpen(...args);
    openedHandles.push(handle);
    const realClose = handle.close.bind(handle);
    const realStat = handle.stat.bind(handle);
    Object.defineProperty(handle, 'stat', { configurable: true, value: vi.fn(async () => { await statGate; return await realStat(); }) });
    Object.defineProperty(handle, 'close', { configurable: true, value: vi.fn(async () => {
      closeCalls++;
      closeCalled();
      await realClose();
    }) });
    return handle;
  })());
  const controller = new AbortController();
  let pending: Promise<{ bytes: Buffer; mimeType: string } | null> | undefined;
  try {
    pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal);
    await started;
    controller.abort();
    finishOpen();
    const closedWhileStatPending = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closedWhileStatPending).toBe(true);
    expect(closeCalls).toBe(1);
    await expect(pending).resolves.toBeNull();
  } finally {
    finishOpen();
    finishStat();
    if (pending) await pending;
    await cleanup();
    openSpy.mockImplementation(openImageOriginal);
  }
});

it('closes the handle immediately when abort interrupts pathname verification', async () => {
  const { service, cleanup } = await setup();
  const openSpy = vi.mocked(open);
  const lstatSpy = vi.mocked(lstat);
  const originalOpen = openImageOriginal;
  const originalLstat = lstatImageOriginal;
  let openedPath = '';
  let finishLstat!: () => void;
  let verifyStarted!: () => void;
  let closeCalled!: () => void;
  const lstatGate = new Promise<void>((resolve) => { finishLstat = resolve; });
  const started = new Promise<void>((resolve) => { verifyStarted = resolve; });
  const closed = new Promise<void>((resolve) => { closeCalled = resolve; });
  let closeCalls = 0;
  openSpy.mockImplementation((...args) => (async () => {
    const handle = await originalOpen(...args);
    openedPath = String(args[0]);
    openedHandles.push(handle);
    const realClose = handle.close.bind(handle);
    Object.defineProperty(handle, 'close', { configurable: true, value: vi.fn(async () => {
      closeCalls++;
      closeCalled();
      await realClose();
    }) });
    return handle;
  })());
  lstatSpy.mockImplementation((...args) => (async () => {
    if (openedPath && path.resolve(String(args[0])) === path.resolve(openedPath)) {
      verifyStarted();
      await lstatGate;
    }
    return await originalLstat(...args);
  })());
  const controller = new AbortController();
  try {
    const pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal);
    await started;
    controller.abort();
    const closedDuringValidation = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closedDuringValidation).toBe(true);
    expect(closeCalls).toBe(1);
    finishLstat();
    await expect(pending).resolves.toBeNull();
  } finally {
    finishLstat();
    await cleanup();
    openSpy.mockImplementation(openImageOriginal);
    lstatSpy.mockImplementation(lstatImageOriginal);
  }
});

it('closes a stalled cache read immediately on service shutdown', async () => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-stalled-cache-'));
  const { service, item, cleanup } = await setup(cacheRoot);
  const cachePath = path.join(cacheRoot, `${item.sha256}.preview`);
  await writeImageOriginal(cachePath, PNG);
  const openSpy = vi.mocked(open);
  let readStarted!: () => void;
  let finishRead!: () => void;
  let closeCalled!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
  const closed = new Promise<void>((resolve) => { closeCalled = resolve; });
  const originalOpen = openImageOriginal;
  let closeCalls = 0;
  openSpy.mockImplementation((...args) => (async () => {
    const handle = await originalOpen(...args);
    openedHandles.push(handle);
    const realRead = handle.read.bind(handle);
    const realClose = handle.close.bind(handle);
    Object.defineProperty(handle, 'read', { configurable: true, value: vi.fn(async (...readArgs: Parameters<typeof handle.read>) => {
      readStarted();
      await readGate;
      return await realRead(...readArgs);
    }) });
    Object.defineProperty(handle, 'close', { configurable: true, value: vi.fn(async () => {
      closeCalls++;
      closeCalled();
      await realClose();
    }) });
    return handle;
  })());
  try {
    const pending = service.readImage(ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 });
    await started;
    service.shutdown();
    await closed;
    expect(closeCalls).toBe(1);
    finishRead();
    await expect(pending).resolves.toBeNull();
    expect(closeCalls).toBe(1);
  } finally {
    finishRead();
    await cleanup();
    openSpy.mockImplementation(openImageOriginal);
  }
});
