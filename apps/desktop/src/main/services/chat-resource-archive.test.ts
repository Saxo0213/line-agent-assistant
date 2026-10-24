import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ChatResourceArchive, isCanonicalChatResourceTimestamp, resolveChatResourceArchiveHelperPath } from './chat-resource-archive.js';

const desktopRoot = resolve(import.meta.dirname, '../../../');
const helper = join(desktopRoot, '..', '..', 'node_modules', '.cache', 'chat-resource-archive', 'ChatResourceArchiveHost.Test.exe');
const productionHelper = join(desktopRoot, 'dist', 'native', 'ChatResourceArchiveHost.exe');
const roots: string[] = [];
let broker: ChatResourceArchive | undefined;

async function fixture(options: { paused?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'chat-resource-archive-')); roots.push(workspace);
  const segments = ['chats', 'folder-one'];
  const chatPath = join(workspace, ...segments); await mkdir(chatPath, { recursive: true });
  const testPauseBoundaryFile = options.paused ? join(workspace, 'pause-boundary') : undefined;
  broker = new ChatResourceArchive({ workspaceRoot: workspace, helperPath: helper, idleStopMs: 50, ...(testPauseBoundaryFile ? { testPauseBoundaryFile } : {}) });
  const chat = await broker.bindChat({ canonicalPath: chatPath, segments });
  return { workspace, chatPath, chat, testPauseBoundaryFile };
}

async function waitForBoundary(path: string, phase: string): Promise<void> {
  const entered = `${path}.${phase}.entered`; const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { try { await readFile(entered); return; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 5)); } }
  throw new Error(`timed out waiting for native ${phase} boundary`);
}

async function releaseBoundary(path: string, phase: string): Promise<void> { await writeFile(`${path}.${phase}.release`, 'release'); }
async function enableBoundary(path: string, ...phases: string[]): Promise<void> { await Promise.all(phases.map((phase) => writeFile(`${path}.${phase}.enabled`, 'enabled'))); }

beforeAll(() => {
  if (process.platform !== 'win32') return;
  const built = spawnSync(process.execPath, [join(desktopRoot, 'scripts', 'build-chat-resource-archive.mjs')], { stdio: 'inherit', shell: false, windowsHide: true });
  if (built.status !== 0) throw new Error('chat resource native host build failed');
  expect(existsSync(join(desktopRoot, 'dist', 'native', 'ChatResourceArchiveHost.Test.exe'))).toBe(false);
});
afterEach(async () => {
  await broker?.close(); broker = undefined;
  await Promise.all(roots.splice(0).map(async (path) => {
    for (let attempt = 0; ; attempt++) {
      try { await rm(path, { recursive: true, force: true }); return; }
      catch (error) { if (attempt >= 10) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
    }
  }));
});

describe.runIf(process.platform === 'win32')('ChatResourceArchive', () => {
  it('selects development and packaged helpers from the explicit packaging state', () => {
    const bundledMainUrl = pathToFileURL(join(desktopRoot, 'dist', 'main.js')).href;
    expect(resolveChatResourceArchiveHelperPath({ isPackaged: false, moduleUrl: bundledMainUrl })).toBe(productionHelper);
    expect(resolveChatResourceArchiveHelperPath({ isPackaged: true, resourcesPath: 'C:\\app\\resources' })).toBe(join('C:\\app\\resources', 'native', 'ChatResourceArchiveHost.exe'));
    expect(isCanonicalChatResourceTimestamp('2026-10-23T00:00:00.000Z')).toBe(true);
    expect(isCanonicalChatResourceTimestamp('yesterday')).toBe(false);
    expect(isCanonicalChatResourceTimestamp('2026-10-23T00:00:00Z')).toBe(false);
  });

  it('publishes digit-suffixed IDs, retains every revision, and survives host reopen', async () => {
    const { chat, chatPath } = await fixture();
    const first = await broker!.publish({ chat, kind: 'note', resourceId: 'line-note-1', content: Buffer.from('A') });
    await broker!.publish({ chat, kind: 'note', resourceId: 'line-note-1', content: Buffer.from('B') });
    const third = await broker!.publish({ chat, kind: 'note', resourceId: 'line-note-1', content: Buffer.from('A') });
    const repeated = await broker!.publish({ chat, kind: 'note', resourceId: 'line-note-1', content: Buffer.from('A') });
    expect(first.revision).toBe(1); expect(third.revision).toBe(3);
    expect(repeated).toEqual(third);
    expect((await broker!.read({ chat, kind: 'note', resourceId: 'line-note-1' }))?.content.toString()).toBe('A');
    const page = await broker!.list({ chat, kind: 'note', limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.items[0]?.revision).toBe(3); expect(page.nextCursor).toBeNull();
    const records = (await readdir(join(chatPath, 'notes'))).filter((name) => name.endsWith('.md'));
    expect(records).toHaveLength(3);
    expect(records.every((name) => /^record_n_[A-Za-z0-9_-]+_\d{20}_\d{8}T\d{9}Z_[0-9a-f]{64}\.md$/.test(name))).toBe(true);
    const firstRecord = records.find((name) => name.includes('_00000000000000000001_'))!;
    const firstNote = await readFile(join(chatPath, 'notes', firstRecord)); expect(firstNote.toString('utf8')).toBe('A');
    await broker!.close(); broker = new ChatResourceArchive({ workspaceRoot: roots[0]!, helperPath: helper, idleStopMs: 50 });
    const reopened = await broker!.bindChat({ canonicalPath: chatPath, segments: ['chats', 'folder-one'] });
    expect((await broker!.read({ chat: reopened, kind: 'note', resourceId: 'line-note-1' }))?.content.toString()).toBe('A');
    expect((await broker!.list({ chat: reopened, kind: 'note', limit: 1 })).items[0]?.revision).toBe(3);
    expect((await readdir(join(chatPath, 'notes'))).filter((name) => name.endsWith('.md'))).toHaveLength(3);
  });

  it('reads a missing archive as empty without creating resource directories', async () => {
    const { chat, chatPath } = await fixture();
    expect(await broker!.read({ chat, kind: 'note', resourceId: 'not-saved' })).toBeNull();
    expect(await broker!.list({ chat, kind: 'album', limit: 10 })).toEqual({ items: [], nextCursor: null });
    expect(await readdir(chatPath)).toEqual([]);
  });

  it('creates isolated opaque album folders and reopens photo exports without duplicates', async () => {
    const { chat, chatPath } = await fixture();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const injectedAlbumId = '../../outside';
    const firstFolder = createHash('sha256').update(injectedAlbumId).digest('hex');
    const secondFolder = createHash('sha256').update('album:two').digest('hex');
    await broker!.ensureAlbumFolder({ chat, albumId: injectedAlbumId });
    const saved = await broker!.publishAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:one', content: bytes });
    expect(saved.folderName).toBe(firstFolder);
    expect(saved.fileName).toMatch(/^record_f_/);
    expect(await broker!.inspectAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:one' })).toMatchObject(saved);
    expect(await broker!.readAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:one' })).toMatchObject({ ...saved, content: bytes });
    expect(await broker!.readAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:missing' })).toBeNull();
    expect(await broker!.inspectAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:missing' })).toBeNull();
    expect(await broker!.hasAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:one' })).toBe(true);
    expect(await broker!.hasAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:missing' })).toBe(false);
    const firstFiles = await readdir(join(chatPath, 'albums', firstFolder));
    const unchanged = await broker!.publishAlbumPhoto({ chat, albumId: injectedAlbumId, photoId: 'photo:one', content: bytes });
    expect(unchanged.fileName).toBe(firstFiles[0]);
    await broker!.ensureAlbumFolder({ chat, albumId: 'album:two' });
    const albums = await readdir(join(chatPath, 'albums'));
    expect(firstFiles).toHaveLength(1);
    expect(firstFiles[0]).toMatch(/\.jpg$/);
    expect((await readdir(join(chatPath, 'albums', firstFolder)))).toEqual(firstFiles);
    expect(albums.sort()).toEqual([firstFolder, secondFolder].sort());
    expect((await readdir(join(roots[0]!, 'chats')))).toEqual(['folder-one']);
    expect((await readFile(join(chatPath, 'albums', firstFolder, firstFiles[0]!))).equals(bytes)).toBe(true);
    const otherChatPath = join(roots[0]!, 'chats', 'folder-two');
    await mkdir(otherChatPath, { recursive: true });
    const otherChat = await broker!.bindChat({ canonicalPath: otherChatPath, segments: ['chats', 'folder-two'] });
    await broker!.ensureAlbumFolder({ chat: otherChat, albumId: injectedAlbumId });
    expect(await readdir(join(otherChatPath, 'albums', firstFolder))).toEqual([]);
  });

  it('rejects a reparse point substituted for an album folder', async () => {
    const { chat, workspace, chatPath } = await fixture();
    const albumId = 'album-safe';
    const albumFolder = join(chatPath, 'albums', createHash('sha256').update(albumId).digest('hex'));
    const outside = join(workspace, 'outside-album');
    await broker!.ensureAlbumFolder({ chat, albumId });
    await mkdir(outside);
    await rm(albumFolder, { recursive: true });
    await symlink(outside, albumFolder, 'junction');
    await expect(broker!.ensureAlbumFolder({ chat, albumId })).rejects.toMatchObject({ code: 'REPARSE_POINT' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('accepts resource IDs up to 96 UTF-8 bytes and rejects larger IDs before host startup', async () => {
    const { chat, chatPath } = await fixture();
    const asciiId = 'a'.repeat(96);
    const unicodeId = '界'.repeat(32);
    expect(Buffer.byteLength(unicodeId, 'utf8')).toBe(96);
    await expect(broker!.publish({ chat, kind: 'note', resourceId: asciiId, content: Buffer.from('ascii') })).resolves.toMatchObject({ resourceId: asciiId });
    await expect(broker!.publish({ chat, kind: 'note', resourceId: unicodeId, content: Buffer.from('unicode') })).resolves.toMatchObject({ resourceId: unicodeId });
    await broker!.close();
    broker = new ChatResourceArchive({ workspaceRoot: roots[0]!, helperPath: helper, idleStopMs: 50 });
    const reopened = await broker!.bindChat({ canonicalPath: chatPath, segments: ['chats', 'folder-one'] });
    await expect(broker!.publish({ chat: reopened, kind: 'note', resourceId: 'x'.repeat(97), content: Buffer.from('rejected') })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_ID' });
    await expect(broker!.read({ chat: reopened, kind: 'note', resourceId: '界'.repeat(33) })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_ID' });
    expect(broker!.inventory.hostProcesses).toBe(0);
    expect((await readdir(join(chatPath, 'notes'))).filter((name) => name.endsWith('.md'))).toHaveLength(2);
  });

  it('keeps staged content invisible when Main aborts before the commit frame', async () => {
    const { chat, chatPath } = await fixture();
    const controller = new AbortController();
    await expect(broker!.publish({ chat, kind: 'note', resourceId: 'cancel-2', content: Buffer.from('not committed'), signal: controller.signal, guard: () => controller.abort() })).rejects.toMatchObject({ code: 'ABORTED' });
    await broker!.close(); broker = new ChatResourceArchive({ workspaceRoot: roots[0]!, helperPath: helper, idleStopMs: 50 });
    const reopened = await broker!.bindChat({ canonicalPath: chatPath, segments: ['chats', 'folder-one'] });
    expect(await broker!.read({ chat: reopened, kind: 'note', resourceId: 'cancel-2' })).toBeNull();
    expect((await readdir(join(chatPath, 'notes'))).filter((name) => name.startsWith('record_'))).toEqual([]);
  });

  it('never replaces a guessed generated-name collision', async () => {
    const { chat, chatPath, testPauseBoundaryFile } = await fixture({ paused: true });
    const resourceId = 'collision-7'; const content = Buffer.from('ours');
    const encoded = `n_${Buffer.from(resourceId).toString('base64url')}`;
    const hash = createHash('sha256').update(content).digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await enableBoundary(testPauseBoundaryFile!, 'commit-link');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId, content });
    await waitForBoundary(testPauseBoundaryFile!, 'commit-link');
    const targetName = (await readFile(`${testPauseBoundaryFile}.commit-link.target`, 'utf8')).trim();
    expect(targetName).toMatch(new RegExp(`^record_${encoded}_00000000000000000001_\\d{8}T\\d{9}Z_${hash}\\.md$`));
    const target = join(chatPath, 'notes', targetName);
    const sentinel = Buffer.from('user-owned'); await writeFile(target, sentinel);
    await releaseBoundary(testPauseBoundaryFile!, 'commit-link');
    await expect(publishing).rejects.toMatchObject({ code: 'NO_REPLACE_CONFLICT' });
    expect(await readFile(target)).toEqual(sentinel);
  });

  it('holds the notes directory against relocation while staging', async () => {
    const { workspace, chat, chatPath, testPauseBoundaryFile } = await fixture({ paused: true });
    await enableBoundary(testPauseBoundaryFile!, 'stage-open');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'stage-boundary', content: Buffer.from('# staged') });
    await waitForBoundary(testPauseBoundaryFile!, 'stage-open');
    const moved = join(workspace, 'chats', 'notes-moved');
    await expect(rename(join(chatPath, 'notes'), moved)).rejects.toBeTruthy();
    await releaseBoundary(testPauseBoundaryFile!, 'stage-open');
    await expect(publishing).resolves.toMatchObject({ revision: 1 });
    expect(await readdir(moved).catch(() => [])).toEqual([]);
    expect((await readdir(join(chatPath, 'notes'))).some((name) => name.endsWith('.md'))).toBe(true);
  });

  it('holds chat ancestry against relocation through the final commit link', async () => {
    const { workspace, chat, chatPath, testPauseBoundaryFile } = await fixture({ paused: true });
    await enableBoundary(testPauseBoundaryFile!, 'commit-link');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'commit-boundary', content: Buffer.from('# committed') });
    await waitForBoundary(testPauseBoundaryFile!, 'commit-link');
    const moved = join(workspace, 'chats', 'folder-one-moved');
    await expect(rename(chatPath, moved)).rejects.toBeTruthy();
    await expect(rename(join(workspace, 'chats'), join(workspace, 'chats-moved'))).rejects.toBeTruthy();
    await expect(rename(workspace, `${workspace}-moved`)).rejects.toBeTruthy();
    await releaseBoundary(testPauseBoundaryFile!, 'commit-link');
    await expect(publishing).resolves.toMatchObject({ revision: 1 });
    expect(await readdir(moved).catch(() => [])).toEqual([]);
    expect((await readdir(join(chatPath, 'notes'))).some((name) => name.endsWith('.md'))).toBe(true);
  });

  it('holds the notes directory against relocation while reading', async () => {
    const { workspace, chat, chatPath, testPauseBoundaryFile } = await fixture({ paused: true });
    await enableBoundary(testPauseBoundaryFile!, 'stage-open', 'commit-link', 'read-open');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'read-boundary', content: Buffer.from('# readable') });
    await waitForBoundary(testPauseBoundaryFile!, 'stage-open'); await releaseBoundary(testPauseBoundaryFile!, 'stage-open');
    await waitForBoundary(testPauseBoundaryFile!, 'commit-link'); await releaseBoundary(testPauseBoundaryFile!, 'commit-link'); await publishing;
    const reading = broker!.read({ chat, kind: 'note', resourceId: 'read-boundary' });
    await waitForBoundary(testPauseBoundaryFile!, 'read-open');
    const moved = join(workspace, 'chats', 'notes-read-moved');
    await expect(rename(join(chatPath, 'notes'), moved)).rejects.toBeTruthy();
    await releaseBoundary(testPauseBoundaryFile!, 'read-open');
    expect((await reading)?.content.toString('utf8')).toBe('# readable');
    expect(await readdir(moved).catch(() => [])).toEqual([]);
  });

  it('holds the notes directory against relocation while listing', async () => {
    const { workspace, chat, chatPath, testPauseBoundaryFile } = await fixture({ paused: true });
    await enableBoundary(testPauseBoundaryFile!, 'stage-open', 'commit-link', 'list-open');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'list-boundary', content: Buffer.from('# listed') });
    await waitForBoundary(testPauseBoundaryFile!, 'stage-open'); await releaseBoundary(testPauseBoundaryFile!, 'stage-open');
    await waitForBoundary(testPauseBoundaryFile!, 'commit-link'); await releaseBoundary(testPauseBoundaryFile!, 'commit-link'); await publishing;
    const listing = broker!.list({ chat, kind: 'note', limit: 10 });
    await waitForBoundary(testPauseBoundaryFile!, 'list-open');
    const moved = join(workspace, 'chats', 'notes-list-moved');
    await expect(rename(join(chatPath, 'notes'), moved)).rejects.toBeTruthy();
    await releaseBoundary(testPauseBoundaryFile!, 'list-open');
    expect((await listing).items).toHaveLength(1);
    expect(await readdir(moved).catch(() => [])).toEqual([]);
  });

  it('closes staging handles on forced cleanup without a final record', async () => {
    const { chatPath, chat, testPauseBoundaryFile } = await fixture({ paused: true });
    await enableBoundary(testPauseBoundaryFile!, 'commit-link');
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'cleanup-boundary', content: Buffer.from('# private staging') });
    await waitForBoundary(testPauseBoundaryFile!, 'commit-link');
    await expect(rename(join(chatPath, 'notes'), join(chatPath, 'notes-cleanup-moved'))).rejects.toBeTruthy();
    broker!.forceClose();
    await expect(publishing).rejects.toBeTruthy();
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect((await readdir(join(chatPath, 'notes')).catch(() => [])).filter((name) => name.startsWith('record_') || name.endsWith('.part'))).toEqual([]);
  });

  it('publishes raw image bytes that a standard PNG decoder accepts', async () => {
    const { chat, chatPath } = await fixture();
    const original = await readFile(join(desktopRoot, 'assets', 'icons', 'line-agent-spring.png'));
    const saved = await broker!.publish({ chat, kind: 'photo', resourceId: 'photo-original', content: original });
    const image = await broker!.read({ chat, kind: 'photo', resourceId: 'photo-original' });
    expect(saved.byteLength).toBe(original.byteLength); expect(image?.content).toEqual(original);
    const pngjs = require('pngjs') as { readonly PNG: { readonly sync: { read(data: Buffer): { readonly width: number } } } };
    expect(pngjs.PNG.sync.read(image!.content).width).toBeGreaterThan(0);
    expect((await readdir(join(chatPath, 'albums'))).some((name) => name.endsWith('.png'))).toBe(true);
  });

  it('publishes album pages as parseable raw JSON', async () => {
    const { chat, chatPath } = await fixture(); const original = Buffer.from(JSON.stringify({ title: 'Album', photos: [{ id: 'photo-1' }] }));
    const saved = await broker!.publish({ chat, kind: 'album', resourceId: 'album-1', content: original });
    const filename = (await readdir(join(chatPath, 'albums'))).find((name) => name.endsWith('.json'))!;
    const onDisk = await readFile(join(chatPath, 'albums', filename));
    expect(saved.byteLength).toBe(original.byteLength); expect(JSON.parse(onDisk.toString('utf8'))).toEqual(JSON.parse(original.toString('utf8')));
  });

  it('ignores records with mismatched kind, malformed timestamp, or noncanonical encoded ID', async () => {
    const { chat, chatPath } = await fixture();
    const noteDirectory = join(chatPath, 'notes'); await mkdir(noteDirectory);
    const content = Buffer.from('invalid metadata'); const hash = createHash('sha256').update(content).digest('hex');
    const candidates = [
      `record_a_bm90ZQ_00000000000000000001_20261023T000000000Z_${hash}.json`,
      `record_n_bm90ZQ_00000000000000000002_yesterday_${hash}.md`,
      `record_n_!_00000000000000000003_20261023T000000000Z_${hash}.md`,
    ];
    for (const name of candidates) await writeFile(join(noteDirectory, name), content);
    expect((await broker!.list({ chat, kind: 'note', limit: 50 })).items).toEqual([]);
  });

  it('closes an active host within the forced termination bound', async () => {
    const { chat } = await fixture(); let closing: Promise<void> | undefined;
    const started = Date.now();
    await expect(broker!.publish({ chat, kind: 'note', resourceId: 'shutdown-4', content: Buffer.from('staged'), guard: () => { closing = broker!.close(); } })).rejects.toBeTruthy();
    await expect(Promise.race([closing!, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('close exceeded 1500ms')), 1500))])).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(broker!.inventory.hostProcesses).toBe(0);
  });

  it('does not spawn a process after close during async startup', async () => {
    const { chat, chatPath } = await fixture();
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'startup-6', content: Buffer.from('must not commit') });
    const closing = broker!.close();
    await expect(publishing).rejects.toBeTruthy(); await closing;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(broker!.inventory.hostProcesses).toBe(0);
    expect((await readdir(join(chatPath, 'notes')).catch(() => [])).filter((name) => name.startsWith('record_'))).toEqual([]);
  });

  it('does not spawn a process after abort during async startup', async () => {
    const { chat, chatPath } = await fixture(); const controller = new AbortController();
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'startup-abort-6', content: Buffer.from('must not commit'), signal: controller.signal });
    controller.abort(); await expect(publishing).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(broker!.inventory.hostProcesses).toBe(0);
    expect((await readdir(join(chatPath, 'notes')).catch(() => [])).filter((name) => name.startsWith('record_'))).toEqual([]);
  });

  it('force-closes synchronously and rejects the in-flight staged publish', async () => {
    const { chat, chatPath } = await fixture(); let reachedGuard = false;
    const publishing = broker!.publish({ chat, kind: 'note', resourceId: 'forced-5', content: Buffer.from('must not be reported'), guard: () => { reachedGuard = true; broker!.forceClose(); } });
    await expect(publishing).rejects.toBeTruthy();
    expect(reachedGuard).toBe(true); expect(broker!.inventory.hostProcesses).toBe(0);
    await broker!.close(); broker = new ChatResourceArchive({ workspaceRoot: roots[0]!, helperPath: helper, idleStopMs: 50 });
    const reopened = await broker!.bindChat({ canonicalPath: chatPath, segments: ['chats', 'folder-one'] });
    expect(await broker!.read({ chat: reopened, kind: 'note', resourceId: 'forced-5' })).toBeNull();
  });

  it('rejects a replaced chat folder at the native handle boundary', async () => {
    const { workspace, chatPath, chat } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'chat-resource-outside-')); roots.push(outside);
    const moved = join(workspace, 'chats', 'folder-one-safe'); await rename(chatPath, moved); await symlink(outside, chatPath, 'junction');
    await expect(broker!.publish({ chat, kind: 'note', resourceId: 'one', content: Buffer.from('secret') })).rejects.toMatchObject({ code: expect.stringMatching(/^(CHAT_IDENTITY_CHANGED|REPARSE_POINT)$/) });
    expect(await readdir(outside)).toEqual([]);
  });

  it('reuses one host for queued work and stops it after the bounded idle period', async () => {
    const { chat } = await fixture();
    const jobs = await Promise.all(Array.from({ length: 8 }, (_, index) => broker!.publish({ chat, kind: 'note', resourceId: `note-${index}`, content: Buffer.from(String(index)) })));
    expect(jobs).toHaveLength(8); expect(broker!.inventory.hostProcesses).toBeLessThanOrEqual(1);
    expect(broker!.inventory.queueLimit).toBe(16);
    const listed: string[] = []; let cursor: string | null = null;
    do { const page = await broker!.list({ chat, kind: 'note', limit: 3, ...(cursor ? { cursor } : {}) }); listed.push(...page.items.map((item) => item.resourceId)); cursor = page.nextCursor; } while (cursor);
    expect(listed).toHaveLength(8); expect(new Set(listed).size).toBe(8);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(broker!.inventory.hostProcesses).toBe(0);
  });
});
