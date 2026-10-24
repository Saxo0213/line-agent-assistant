import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentOpenService } from './attachment-open.js';
import type { PreviewRecord } from './attachment-preview.js';

const ID = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
const PDF = Buffer.from('%PDF-1.7\nverified payload');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Windows attachment open', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function fixture(bytes = PDF) {
    const base = await mkdtemp(path.join(tmpdir(), 'line-attachment-open-')); roots.push(base);
    const root = path.join(base, 'attachments'), relativePath = `account/date/att-${'a'.repeat(64)}.blob`;
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    const record: PreviewRecord = { attachmentId: ID, accountId: 'account-a', chatType: 'direct', chatId: 'friend-a',
      kind: 'file', name: 'invoice.pdf', mimeType: 'application/pdf', status: 'ready', relativePath, sizeBytes: bytes.length, sha256: digest(bytes) };
    let current: PreviewRecord | null = record;
    const calls: string[] = [];
    const service = new AttachmentOpenService({ root, authority: { lookup: async () => current },
      openPath: async (file) => { calls.push(file); return ''; } });
    return { base, root, target, record, calls, service, setRecord: (value: PreviewRecord | null) => { current = value; } };
  }

  it('reports a fixed shell failure with attachment identity while success and shutdown remain quiet', async () => {
    const f = await fixture();
    const reports: unknown[] = [];
    let result = 'private-native-error C:\\secret\\invoice.pdf';
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => f.record },
      openPath: async () => result, onDiagnostic: (...args) => { reports.push(args); } });
    expect(await service.open(ID, { senderId: 9 })).toBe(false);
    expect(reports).toMatchObject([[{ operation: 'attachment', stage: 'execute', category: 'unavailable', outcome: 'failed' }, { requestId: ID }]]);
    expect(JSON.stringify(reports)).not.toMatch(/private-native-error|secret|invoice/);
    reports.length = 0; result = '';
    expect(await service.open(ID, { senderId: 9 })).toBe(true);
    await service.shutdown();
    expect(await service.open(ID, { senderId: 9 })).toBe(false);
    expect(reports).toEqual([]);
    const launched = deferred<void>(), shellResult = deferred<string>();
    const cancelled = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => f.record },
      openPath: async () => { launched.resolve(); return shellResult.promise; }, onDiagnostic: (...args) => { reports.push(args); } });
    const pending = cancelled.open(ID, { senderId: 9 });
    await launched.promise; await cancelled.shutdown();
    expect(await pending).toBe(false);
    shellResult.resolve('private-late-shell-error');
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toEqual([]);
    await f.service.shutdown();
  });

  it('passes the exact original .blob path once and never changes the source', async () => {
    const f = await fixture(), before = await lstat(f.target), bytes = await readFile(f.target);
    expect(await f.service.open(ID, { senderId: 9 })).toBe(true);
    const after = await lstat(f.target);
    expect(f.calls).toEqual([f.target]);
    expect(await readFile(f.target)).toEqual(bytes);
    expect({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
      .toEqual({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs });
    expect(f.service.inventory()).toEqual({ active: 0, handles: 0, cancellationSubscribers: 0 });
    await f.service.shutdown();
  });

  it.each([
    { name: 'photo.jpg', bytes: JPEG, mimeType: 'image/jpeg', kind: 'image' as const, externalId: 'photo-id' },
    { name: 'rules.pdf', bytes: PDF, mimeType: 'application/pdf', kind: 'file' as const, externalId: 'rules-id' },
  ])('passes the exact new stored $name path to Windows', async ({ name, bytes, mimeType, kind, externalId }) => {
    const base = await mkdtemp(path.join(tmpdir(), 'line-attachment-open-native-name-')); roots.push(base);
    const root = path.join(base, 'attachments');
    const relativePath = `accounts/id-6163636f756e742d61/direct/id-667269656e642d61/2026/10/id-6d657373616765/${digest(Buffer.from(externalId))}/${name}`;
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    const record: PreviewRecord = { attachmentId: ID, accountId: 'account-a', chatType: 'direct', chatId: 'friend-a',
      kind, name, mimeType, status: 'ready', relativePath, sizeBytes: bytes.length, sha256: digest(bytes) };
    const calls: string[] = [];
    const service = new AttachmentOpenService({ root, authority: { lookup: async () => record },
      openPath: async (file) => { calls.push(file); return ''; } });
    expect(await service.open(ID, { senderId: 9 })).toBe(true);
    expect(calls).toEqual([target]);
    expect(await readFile(target)).toEqual(bytes);
    await service.shutdown();
  });

  it('allows a stable attachment belonging to another account for the trusted local operator', async () => {
    const f = await fixture();
    expect(await f.service.open(ID, { senderId: 9 })).toBe(true);
    expect(f.calls).toEqual([f.target]); await f.service.shutdown();
  });

  it('fails closed for sender, readiness, path, size and hash validation failures', async () => {
    const f = await fixture();
    expect(await f.service.open(ID, { senderId: -1 })).toBe(false);
    for (const changed of [
      { ...f.record, status: 'downloading' }, { ...f.record, relativePath: '../outside.blob' },
      { ...f.record, sizeBytes: 101 * 1024 * 1024 }, { ...f.record, sizeBytes: PDF.length + 1 },
      { ...f.record, sha256: '0'.repeat(64) }, { ...f.record, accountId: '' },
    ]) {
      f.setRecord(changed);
      expect(await f.service.open(ID, { senderId: 9 })).toBe(false);
    }
    expect(f.calls).toHaveLength(0); await f.service.shutdown();
  });

  it('rejects symlink traversal and a file whose content changes after the first lookup', async () => {
    const f = await fixture();
    const real = `${f.target}.real`; await rm(f.target); await writeFile(real, PDF); await symlink(real, f.target);
    expect(await f.service.open(ID, { senderId: 9 })).toBe(false);
    await rm(f.target); await rm(real); await writeFile(f.target, PDF);
    let lookups = 0;
    const changed = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => {
      if (++lookups === 2) await writeFile(f.target, Buffer.from('different')); return f.record;
    } }, openPath: async (file) => { f.calls.push(file); return ''; } });
    expect(await changed.open(ID, { senderId: 9 })).toBe(false);
    expect(f.calls).toHaveLength(0); await changed.shutdown(); await f.service.shutdown();
  });

  it('rejects a changed authoritative account/chat/path on the second lookup', async () => {
    const f = await fixture(); let lookup = 0;
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => ++lookup === 1 ? f.record : { ...f.record, chatId: 'other-chat' } },
      openPath: async (file) => { f.calls.push(file); return ''; } });
    expect(await service.open(ID, { senderId: 9 })).toBe(false);
    expect(f.calls).toHaveLength(0); await service.shutdown(); await f.service.shutdown();
  });

  it('bounds reads to the recorded 100 MiB maximum', async () => {
    const f = await fixture();
    f.setRecord({ ...f.record, sizeBytes: 100 * 1024 * 1024 + 1 });
    expect(await f.service.open(ID, { senderId: 9 })).toBe(false);
    expect(f.calls).toHaveLength(0); await f.service.shutdown();
  });

  it('streams a 100 MiB managed file through bounded chunks', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'line-attachment-open-limit-')); roots.push(base);
    const root = path.join(base, 'attachments'), relativePath = 'account/large.blob', target = path.join(root, relativePath);
    const sizeBytes = 100 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024), hash = createHash('sha256');
    for (let offset = 0; offset < sizeBytes; offset += chunk.length) hash.update(chunk);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.alloc(0)); await truncate(target, sizeBytes);
    const record: PreviewRecord = { attachmentId: ID, accountId: 'account-a', chatType: 'direct', chatId: 'friend-a', kind: 'file',
      name: 'large.bin', mimeType: 'application/octet-stream', status: 'ready', relativePath, sizeBytes, sha256: hash.digest('hex') };
    const calls: string[] = [], service = new AttachmentOpenService({ root,
      authority: { lookup: async () => record }, openPath: async (file) => { calls.push(file); return ''; } });
    expect(await service.open(ID, { senderId: 9 })).toBe(true);
    expect(calls).toEqual([target]); expect(service.inventory()).toEqual({ active: 0, handles: 0, cancellationSubscribers: 0 });
    await service.shutdown();
  });

  it('admits only two overlapping opens and drains repeated opens without handles or subscriptions', async () => {
    const f = await fixture(), gate = deferred<string>(), started = deferred<void>(); let calls = 0;
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => f.record }, openPath: async (file) => {
      f.calls.push(file); if (++calls === 2) started.resolve(); return gate.promise;
    } });
    const first = service.open(ID, { senderId: 9 }), second = service.open(ID, { senderId: 9 }); await started.promise;
    expect(await service.open(ID, { senderId: 9 })).toBe(false);
    gate.resolve(''); expect(await Promise.all([first, second])).toEqual([true, true]);
    for (let index = 0; index < 8; index++) expect(await service.open(ID, { senderId: 9 })).toBe(true);
    expect(service.inventory()).toEqual({ active: 0, handles: 0, cancellationSubscribers: 0 });
    expect(f.calls).toHaveLength(10); await service.shutdown();
  });

  it('settles public lookup calls on shutdown and fences their late result', async () => {
    const f = await fixture(), gate = deferred<PreviewRecord | null>(), started = deferred<void>();
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => { started.resolve(); return gate.promise; } },
      openPath: async (file) => { f.calls.push(file); return ''; } });
    const opened = service.open(ID, { senderId: 9 }); await started.promise;
    await service.shutdown(); await expect(opened).resolves.toBe(false);
    expect(service.inventory().cancellationSubscribers).toBe(0);
    gate.resolve(f.record); await vi.waitFor(() => expect(service.inventory().active).toBe(0));
    expect(f.calls).toHaveLength(0);
  });

  it('does not wait for a stalled shell promise and fences its late result', async () => {
    const f = await fixture(), gate = deferred<string>(), started = deferred<void>();
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => f.record }, openPath: async (file) => {
      f.calls.push(file); started.resolve(); return gate.promise;
    } });
    const opened = service.open(ID, { senderId: 9 }); await started.promise;
    await service.shutdown(); await expect(opened).resolves.toBe(false);
    expect(service.inventory().cancellationSubscribers).toBe(0);
    gate.resolve(''); await vi.waitFor(() => expect(service.inventory().active).toBe(0));
  });

  it('closes an acquired handle when shutdown races asynchronous acquisition', async () => {
    const f = await fixture(), before = await lstat(f.target), acquired = deferred<void>(), entered = deferred<void>();
    const service = new AttachmentOpenService({ root: f.root, authority: { lookup: async () => f.record }, openPath: async () => '',
      afterAcquire: async () => { entered.resolve(); await acquired.promise; } });
    const openPromise = service.open(ID, { senderId: 9 });
    await entered.promise;
    expect(service.inventory().handles).toBe(1);
    await service.shutdown(); await expect(openPromise).resolves.toBe(false);
    acquired.resolve(); await vi.waitFor(() => expect(service.inventory().active).toBe(0));
    expect(service.inventory().handles).toBe(0);
    const after = await lstat(f.target); expect(after.ino).toBe(before.ino);
  });
});
