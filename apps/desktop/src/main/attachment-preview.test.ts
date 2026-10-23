import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentPreviewService,
  PREVIEW_CSP,
  createPreviewWindowOptions,
  isAllowedPreviewNavigation,
  type PreviewCapability,
  type PreviewPresenter,
  type PreviewRecord,
} from './attachment-preview.js';

const ATTACHMENT_ID = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
const OTHER_ID = '5cd79d9b-4a24-45ed-a665-06d60a589d51';
const PDF = Buffer.from('%PDF-1.7\ntrusted');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
const WEBP = (() => { const bytes = Buffer.alloc(30); bytes.write('RIFF', 0); bytes.write('WEBP', 8); bytes.write('VP8X', 12); return bytes; })();

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(relativePath: string, overrides: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    attachmentId: ATTACHMENT_ID,
    kind: 'file',
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    status: 'ready',
    relativePath,
    sizeBytes: PDF.byteLength,
    sha256: digest(PDF),
    ...overrides,
  };
}

describe('authoritative attachment preview', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    for (const target of temporary.splice(0)) await rm(target, { recursive: true, force: true });
  });

  async function fixture(bytes = PDF, overrides: Partial<PreviewRecord> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'line-preview-'));
    temporary.push(root);
    const relativePath = `accounts/a/att-${'b'.repeat(64)}.blob`;
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), bytes);
    return { root, relativePath, metadata: record(relativePath, { sizeBytes: bytes.byteLength, sha256: digest(bytes), ...overrides }) };
  }

  it('previews a valid opaque blob using a viewer-bound one-time capability', async () => {
    const item = await fixture();
    let launch: PreviewCapability | undefined;
    const presenter: PreviewPresenter = {
      async present(request) {
        launch = request.issueCapability(42);
        expect(launch.url).toMatch(/^line-preview:\/\/content\/[A-Za-z0-9_-]{43}$/);
        expect(request).toMatchObject({ displayName: 'invoice.pdf', mimeType: 'application/pdf', renderer: 'pdf', byteLength: PDF.byteLength });
        return true;
      },
      closeAll() {},
    };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async (id, requester) => id === ATTACHMENT_ID && requester.senderId === 7 ? item.metadata : null }, presenter });

    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    expect(launch).toBeDefined();
    expect(service.activate(launch!.token, 41)).toBeNull();
    const resource = launch!.activate();
    expect(resource?.read()).toMatchObject({ displayName: 'invoice.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(resource?.read()).toMatchObject({ bytes: PDF });
    expect(launch!.activate()).toBeNull();
    service.shutdown();
  });

  it('reads image thumbnails and opens PDFs from the new hash-directory filename layout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'line-preview-native-name-'));
    temporary.push(root);
    const directory = 'accounts/id-61/group/id-62/2026/10/id-63';
    const imagePath = `${directory}/${'a'.repeat(64)}/photo.jpg`;
    const pdfPath = `${directory}/${'b'.repeat(64)}/rules.pdf`;
    await mkdir(path.dirname(path.join(root, imagePath)), { recursive: true });
    await mkdir(path.dirname(path.join(root, pdfPath)), { recursive: true });
    await writeFile(path.join(root, imagePath), JPEG);
    await writeFile(path.join(root, pdfPath), PDF);
    const imageRecord = record(imagePath, { attachmentId: ATTACHMENT_ID, kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg',
      sizeBytes: JPEG.byteLength, sha256: digest(JPEG), accountId: 'account', chatType: 'group', chatId: 'chat' });
    const pdfRecord = record(pdfPath, { attachmentId: OTHER_ID, name: 'rules.pdf', sizeBytes: PDF.byteLength, sha256: digest(PDF) });
    let presentedName = '';
    const service = new AttachmentPreviewService({ root,
      authority: { lookup: async (id) => id === ATTACHMENT_ID ? imageRecord : id === OTHER_ID ? pdfRecord : null },
      presenter: { async present(request) { presentedName = request.displayName; request.issueCapability(42); return true; }, closeAll() {} } });

    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account', chatType: 'group', chatId: 'chat' }, { senderId: 7 }))
      .resolves.toMatchObject({ bytes: JPEG, mimeType: 'image/jpeg' });
    await expect(service.open(OTHER_ID, { senderId: 7 })).resolves.toBe(true);
    expect(presentedName).toBe('rules.pdf');
    service.shutdown();
  });

  it('rejects a malformed hash-directory layout for a native filename', async () => {
    const item = await fixture();
    const badPath = `accounts/id-61/group/id-62/2026/10/id-63/not-a-hash/${'c'.repeat(64)}.pdf`;
    await mkdir(path.dirname(path.join(item.root, badPath)), { recursive: true });
    await writeFile(path.join(item.root, badPath), PDF);
    const malformed = { ...item.metadata, relativePath: badPath };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => malformed },
      presenter: { async present() { return true; }, closeAll() {} } });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    service.shutdown();
  });

  it('fails closed for a wrong ID or requester before presenting anything', async () => {
    const item = await fixture();
    let presentations = 0;
    const service = new AttachmentPreviewService({
      root: item.root,
      authority: { lookup: async (id, requester) => id === ATTACHMENT_ID && requester.senderId === 7 ? item.metadata : null },
      presenter: { async present() { presentations++; return true; }, closeAll() {} },
    });
    await expect(service.open(OTHER_ID, { senderId: 7 })).resolves.toBe(false);
    await expect(service.open(ATTACHMENT_ID, { senderId: 8 })).resolves.toBe(false);
    await expect(service.open('C:\\secrets.txt', { senderId: 7 })).resolves.toBe(false);
    expect(presentations).toBe(0);
  });

  it('rejects executable and HTML bytes masquerading as declared PDF', async () => {
    for (const bytes of [Buffer.from('MZ executable'), Buffer.from('<!doctype html><script>alert(1)</script>')]) {
      const item = await fixture(bytes, { name: 'invoice.pdf', mimeType: 'application/pdf', kind: 'file' });
      const service = new AttachmentPreviewService({
        root: item.root,
        authority: { lookup: async () => item.metadata },
        presenter: { async present() { throw new Error('must not present'); }, closeAll() {} },
      });
      await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    }
  });

  it('requires declared kind, MIME, display extension, signature, size and digest to agree', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: 'image/png' });
    let calls = 0;
    const current = { ...item.metadata };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => current }, presenter: { async present(request) { calls++; request.issueCapability(77 + calls); return true; }, closeAll() {} } });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    current.mimeType = 'image/jpeg';
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    current.mimeType = 'image/png'; current.kind = 'audio';
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    current.kind = 'image'; current.sizeBytes = PNG.byteLength + 1;
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    current.sizeBytes = PNG.byteLength; current.sha256 = '0'.repeat(64);
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    current.sha256 = digest(PNG); current.name = 'photo:stream.png';
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    expect(calls).toBe(1);
  });

  it('does not look up an image when its read signal is already aborted', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: 'image/png',
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    let lookups = 0;
    const service = new AttachmentPreviewService({ root: item.root,
      authority: { lookup: async () => { lookups++; return item.metadata; } },
      presenter: { async present() { return false; }, closeAll() {} } });
    const controller = new AbortController();
    controller.abort();

    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal)).resolves.toBeNull();
    expect(lookups).toBe(0);
  });

  it('detects image bytes without LINE MIME and reuses a verified independent preview cache', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.jpg', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cache-'));
    temporary.push(cacheRoot);
    let lookups = 0;
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot,
      authority: { lookup: async () => { lookups++; return item.metadata; } },
      presenter: { async present() { return false; }, closeAll() {} } });
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };

    await expect(service.readImage(ATTACHMENT_ID, key, { senderId: 7 })).resolves.toMatchObject({ bytes: PNG, mimeType: 'image/png' });
    await rm(path.join(item.root, item.relativePath));
    await expect(service.readImage(ATTACHMENT_ID, key, { senderId: 7 })).resolves.toMatchObject({ bytes: PNG, mimeType: 'image/png' });
    expect(lookups).toBe(2);
    expect(await readdir(cacheRoot)).toEqual([`${digest(PNG)}.preview`]);
  });

  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'unknown.bin', null],
    ['WebP', WEBP, 'image/webp', 'photo.png', 'image/png'],
  ])('uses verified %s signature when MIME is missing or disagrees', async (_label, bytes, expectedMime, name, mimeType) => {
    const item = await fixture(bytes, { kind: 'image', name, mimeType,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const service = new AttachmentPreviewService({ root: item.root,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });
    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 }))
      .resolves.toMatchObject({ bytes, mimeType: expectedMime });
  });

  it('rejects oversized cache files without reading them and removes the invalid entry', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cache-large-'));
    temporary.push(cacheRoot);
    const cacheFile = path.join(cacheRoot, `${digest(PNG)}.preview`);
    await writeFile(cacheFile, Buffer.alloc(8 * 1024 * 1024 + 1));
    await rm(path.join(item.root, item.relativePath));
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });

    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 })).resolves.toBeNull();
    await expect(readdir(cacheRoot)).resolves.toEqual([]);
  });

  it('does not follow a cache file symlink and preserves its outside target', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cache-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'line-preview-outside-'));
    temporary.push(cacheRoot, outside);
    const outsideFile = path.join(outside, 'outside.bin');
    const cacheFile = path.join(cacheRoot, `${digest(PNG)}.preview`);
    await writeFile(outsideFile, 'must not be read or removed');
    await symlink(outsideFile, cacheFile, 'file');
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });

    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 }))
      .resolves.toMatchObject({ bytes: PNG });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('must not be read or removed');
    await expect(readdir(cacheRoot)).resolves.toContain(`${digest(PNG)}.preview`);
  });

  it('rejects an image with dimensions above the preview limit', async () => {
    const oversized = Buffer.from(PNG); oversized.writeUInt32BE(9000, 16);
    const item = await fixture(oversized, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const service = new AttachmentPreviewService({ root: item.root,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });
    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 })).resolves.toBeNull();
  });

  it('removes a same-size cache file with the wrong digest and rebuilds it from the authorized source', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cache-corrupt-'));
    temporary.push(cacheRoot);
    const cacheFile = path.join(cacheRoot, `${digest(PNG)}.preview`);
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    await expect(service.readImage(ATTACHMENT_ID, key, { senderId: 7 })).resolves.toMatchObject({ bytes: PNG });
    const corrupt = Buffer.from(PNG); corrupt[23] = 2;
    await writeFile(cacheFile, corrupt);

    await expect(service.readImage(ATTACHMENT_ID, key, { senderId: 7 })).resolves.toMatchObject({ bytes: PNG });
    await expect(readFile(cacheFile)).resolves.toEqual(PNG);
  });

  it('refuses cache roots that resolve into attachment storage', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const alias = path.join(tmpdir(), `line-preview-alias-${Date.now()}`);
    await symlink(item.root, alias, 'junction');
    temporary.push(alias);
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot: alias,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });
    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 }))
      .resolves.toMatchObject({ mimeType: 'image/png' });
    expect((await readdir(alias)).some((name) => name.endsWith('.preview'))).toBe(false);
  });

  it('evicts the oldest cache entry and cleans stale temporary files', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: null,
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-preview-cache-evict-'));
    temporary.push(cacheRoot);
    const oldest = `${'0'.repeat(64)}.preview`;
    for (let i = 0; i < 512; i++) await writeFile(path.join(cacheRoot, `${i.toString(16).padStart(64, '0')}.preview`), Buffer.alloc(0));
    await utimes(path.join(cacheRoot, oldest), new Date(0), new Date(0));
    await writeFile(path.join(cacheRoot, 'orphan.tmp-deadbeef'), 'partial');
    const service = new AttachmentPreviewService({ root: item.root, cacheRoot,
      authority: { lookup: async () => item.metadata }, presenter: { async present() { return false; }, closeAll() {} } });

    await expect(service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, { senderId: 7 }))
      .resolves.toMatchObject({ mimeType: 'image/png' });
    const names = await readdir(cacheRoot);
    expect(names).toHaveLength(512);
    expect(names).toContain(`${digest(PNG)}.preview`);
    expect(names).not.toContain(oldest);
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('abandons a pending image lookup when its read signal is aborted', async () => {
    const item = await fixture(PNG, { kind: 'image', name: 'photo.png', mimeType: 'image/png',
      accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
    let finishLookup!: (record: PreviewRecord) => void;
    const service = new AttachmentPreviewService({ root: item.root,
      authority: { lookup: async () => await new Promise<PreviewRecord>((resolve) => { finishLookup = resolve; }) },
      presenter: { async present() { return false; }, closeAll() {} } });
    const controller = new AbortController();
    const pending = service.readImage(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
      { senderId: 7 }, 8 * 1024 * 1024, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    finishLookup(item.metadata);
  });

  it.each([
    { kind: 'video' as const, name: 'clip.mp4', mimeType: 'video/mp4', renderer: 'video', bytes: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) },
    { kind: 'audio' as const, name: 'voice.mp3', mimeType: 'audio/mpeg', renderer: 'audio', bytes: Buffer.from('ID3\u0004\u0000\u0000sample') },
    { kind: 'file' as const, name: 'notes.txt', mimeType: 'text/plain', renderer: 'text', bytes: Buffer.from('safe UTF-8 notes') },
  ])('supports allowlisted $renderer bytes without a data URL', async ({ kind, name, mimeType, renderer, bytes }) => {
    const item = await fixture(bytes, { kind, name, mimeType });
    let launch: PreviewCapability | undefined;
    const service = new AttachmentPreviewService({
      root: item.root,
      authority: { lookup: async () => item.metadata },
      presenter: { async present(request) { expect(request.renderer).toBe(renderer); launch = request.issueCapability(88); return true; }, closeAll() {} },
    });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    expect(launch!.url.startsWith('data:')).toBe(false);
    expect(launch!.activate()?.read()?.bytes).toEqual(bytes);
  });

  it('rejects symlink/junction escapes and keeps held bytes if the pathname is replaced', async () => {
    const item = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'line-preview-outside-'));
    temporary.push(outside);
    const outsideFile = path.join(outside, `att-${digest(PDF)}.blob`);
    await writeFile(outsideFile, PDF);
    await symlink(outside, path.join(item.root, 'escape'), 'junction');
    const current = { ...item.metadata, relativePath: `escape/${path.basename(outsideFile)}` };
    let launch: PreviewCapability | undefined;
    const presenter: PreviewPresenter = {
      async present(request) {
        await rename(path.join(item.root, item.relativePath), `${path.join(item.root, item.relativePath)}.moved`);
        await writeFile(path.join(item.root, item.relativePath), '<html>replacement</html>');
        launch = request.issueCapability(91);
        return true;
      },
      closeAll() {},
    };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => current }, presenter });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    current.relativePath = item.relativePath;
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    expect(launch!.activate()?.read()?.bytes).toEqual(PDF);
  });

  it('expires, caps and revokes capabilities on close and shutdown', async () => {
    const item = await fixture();
    let now = 1_000;
    const launches: PreviewCapability[] = [];
    const presenter: PreviewPresenter = {
      async present(request) { launches.push(request.issueCapability(50 + launches.length)); return true; },
      closeAll() {},
    };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => item.metadata }, presenter, now: () => now, limits: { ttlMs: 50, maxCapabilities: 1, maxTotalBytes: PDF.byteLength, maxFileBytes: 1024 } });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    launches[0]!.close();
    expect(launches[0]!.activate()).toBeNull();
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    now += 51;
    expect(launches[1]!.activate()).toBeNull();
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(true);
    service.shutdown();
    expect(launches[2]!.activate()).toBeNull();
  });

  it('revokes an issued capability when presentation fails', async () => {
    const item = await fixture();
    let launch: PreviewCapability | undefined;
    const service = new AttachmentPreviewService({
      root: item.root,
      authority: { lookup: async () => item.metadata },
      presenter: { async present(request) { launch = request.issueCapability(61); return false; }, closeAll() {} },
    });
    await expect(service.open(ATTACHMENT_ID, { senderId: 7 })).resolves.toBe(false);
    expect(launch!.activate()).toBeNull();
  });

  it('shutdown revokes a capability while presentation is still pending', async () => {
    const item = await fixture();
    let finishPresentation!: (value: boolean) => void;
    const pendingPresentation = new Promise<boolean>((resolve) => { finishPresentation = resolve; });
    let launch: PreviewCapability | undefined;
    const service = new AttachmentPreviewService({
      root: item.root,
      authority: { lookup: async () => item.metadata },
      presenter: { async present(request) { launch = request.issueCapability(71); return pendingPresentation; }, closeAll() {} },
    });
    const pendingOpen = service.open(ATTACHMENT_ID, { senderId: 7 });
    while (!launch) await new Promise((resolve) => setTimeout(resolve, 0));
    service.shutdown();
    finishPresentation(true);
    await expect(pendingOpen).resolves.toBe(false);
    expect(launch.activate()).toBeNull();
  });

  it('defines a sandboxed viewer with restrictive CSP and no general navigation', () => {
    expect(createPreviewWindowOptions()).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("object-src 'none'");
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(isAllowedPreviewNavigation('line-preview://content/token', 'line-preview://content/token')).toBe(true);
    expect(isAllowedPreviewNavigation('https://evil.example/', 'line-preview://content/token')).toBe(false);
    expect(isAllowedPreviewNavigation('file:///C:/secret.txt', 'line-preview://content/token')).toBe(false);
  });
});
