import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AttachmentPreviewService, type PreviewCapability, type PreviewRecord } from './attachment-preview.js';
import { createElectronPreviewPresenter } from './electron-preview-presenter.js';

it('review: closes a created viewer when capability capacity rejects issuance', async () => {
  let closed = 0;
  const presenter = createElectronPreviewPresenter({
    createSession: () => ({
      protocol: { handle() {}, unhandle() {} },
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    }),
    createWindow: () => ({
      webContents: { id: 1, on() {}, setWindowOpenHandler() {} },
      async loadURL() {}, once() {}, on() {}, show() {}, focus() {},
      close() { closed++; },
    }),
  });
  await presenter.present({
    displayName: 'notes.txt', mimeType: 'text/plain', renderer: 'text', byteLength: 5,
    issueCapability() { throw new Error('Preview capability capacity exceeded'); },
  }).catch(() => false);
  presenter.closeAll();
  expect(closed).toBe(1);
});

it('review: shutdown fences an open awaiting its authoritative lookup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-preview-review-'));
  const bytes = Buffer.from('safe text');
  const relativePath = `att-${'b'.repeat(64)}.blob`;
  await writeFile(path.join(root, relativePath), bytes);
  try {
    let finishLookup!: (value: PreviewRecord) => void;
    const lookup = new Promise<PreviewRecord>((resolve) => { finishLookup = resolve; });
    let issued: PreviewCapability | undefined;
    const service = new AttachmentPreviewService({
      root,
      authority: { lookup: () => lookup },
      presenter: {
        async present(request) { issued = request.issueCapability(1); return true; },
        closeAll() {},
      },
    });
    const pending = service.open('2a653934-7064-4d90-a9f0-e6e24cf4f93d', { senderId: 7 });
    service.shutdown();
    finishLookup({
      attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', kind: 'file', name: 'notes.txt',
      mimeType: 'text/plain', status: 'ready', relativePath, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const result = await pending;
    const payload = issued?.activate()?.read();
    expect({ result, issued: issued !== undefined, consumed: payload !== undefined && payload !== null })
      .toEqual({ result: false, issued: false, consumed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
