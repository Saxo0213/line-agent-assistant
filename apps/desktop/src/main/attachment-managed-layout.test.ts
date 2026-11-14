import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAttachmentLocation } from '@line-agent/line-worker/attachment-storage';
import { AttachmentOpenService } from './attachment-open.js';
import { AttachmentPreviewService, openManagedBlob, type PreviewRecord } from './attachment-preview.js';

const ID = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('managed attachment layouts', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function stored(chatType: 'direct' | 'group' | 'room', fileName: string, bytes: Uint8Array = JPEG, displayName: string | null = 'Ivy') {
    const root = await mkdtemp(path.join(tmpdir(), 'line-managed-layout-'));
    roots.push(root);
    const location = buildAttachmentLocation({ root, occurredAt: '2026-11-06T14:37:41.000Z', originalFileName: fileName,
      identity: { accountId: 'acct', chatType, chatId: 'chat', messageId: 'msg', externalAttachmentId: 'ext' },
      sender: { id: 'u1', displayName } });
    await mkdir(location.directoryAbsolutePath, { recursive: true });
    await writeFile(location.absolutePath, bytes);
    return { root, relativePath: location.managedRelativePath, absolutePath: location.absolutePath };
  }

  it.each([
    { chatType: 'direct' as const, segments: 9, sender: 'Ivy' },
    { chatType: 'group' as const, segments: 8, sender: 'Ivy' },
    { chatType: 'room' as const, segments: 8, sender: 'Ivy' },
    { chatType: 'group' as const, segments: 8, sender: 'Ivy\u{13170}\u{1F600}' },
  ])('opens a $chatType file with $segments segments (sender $sender)', async ({ chatType, segments, sender }) => {
    const item = await stored(chatType, 'attachment.jpg', JPEG, sender);
    expect(item.relativePath.split('/')).toHaveLength(segments);
    const held = await openManagedBlob(item.root, item.relativePath);
    expect(held).not.toBeNull();
    await held!.close();
  });

  it('rejects wrong segment counts, bad ids, bad digests, parent segments and reparse points', async () => {
    const item = await stored('group', 'attachment.jpg');
    const parts = item.relativePath.split('/');
    const swap = (index: number, value: string) => parts.map((part, at) => at === index ? value : part).join('/');
    for (const bad of [
      parts.slice(1).join('/'), `${item.relativePath}/more`, swap(1, 'acct'), swap(3, 'id-xyz'), swap(2, 'channel'), swap(4, 'no-suffix'),
      swap(5, '2026-11-06_id-6d7367'), swap(6, 'f'.repeat(63)), swap(6, '..'), swap(7, '..'), swap(7, 'bad|name.jpg'),
      `${parts.slice(0, 4).join('/')}/../${parts.slice(5).join('/')}`,
    ]) expect(await openManagedBlob(item.root, bad)).toBeNull();

    const outside = await mkdtemp(path.join(tmpdir(), 'line-managed-outside-'));
    roots.push(outside);
    await mkdir(path.join(outside, ...parts.slice(5, 7)), { recursive: true });
    await writeFile(path.join(outside, ...parts.slice(5)), JPEG);
    const linked = await mkdtemp(path.join(tmpdir(), 'line-managed-linked-'));
    roots.push(linked);
    await mkdir(path.join(linked, ...parts.slice(0, 4)), { recursive: true });
    await symlink(outside, path.join(linked, ...parts.slice(0, 4), parts[4]!), 'junction');
    expect(await openManagedBlob(linked, item.relativePath)).toBeNull();
  });

  it('reads the inline image of a group attachment', async () => {
    const item = await stored('group', 'attachment.jpg');
    const record: PreviewRecord = { attachmentId: ID, accountId: 'acct', chatType: 'group', chatId: 'chat', kind: 'image', name: null, mimeType: null,
      status: 'ready', relativePath: item.relativePath, sizeBytes: JPEG.byteLength, sha256: digest(JPEG) };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => record },
      presenter: { async present() { return true; }, closeAll() {} } });
    await expect(service.readImage(ID, { accountId: 'acct', chatType: 'group', chatId: 'chat' }, { senderId: 1 }))
      .resolves.toMatchObject({ bytes: JPEG, mimeType: 'image/jpeg' });
    service.shutdown();
  });

  it('shows an image record without name and MIME type by its content, and refuses non-image bytes', async () => {
    const item = await stored('group', 'attachment.bin');
    let presented: { displayName: string; mimeType: string; renderer: string } | undefined;
    const record: PreviewRecord = { attachmentId: ID, accountId: 'acct', chatType: 'group', chatId: 'chat', kind: 'image', name: null, mimeType: null,
      status: 'ready', relativePath: item.relativePath, sizeBytes: JPEG.byteLength, sha256: digest(JPEG) };
    const service = new AttachmentPreviewService({ root: item.root, authority: { lookup: async () => record },
      presenter: { async present(request) { presented = request; request.issueCapability(5); return true; }, closeAll() {} } });
    await expect(service.open(ID, { senderId: 1 })).resolves.toBe(true);
    expect(presented).toMatchObject({ displayName: '圖片.jpg', mimeType: 'image/jpeg', renderer: 'image' });
    // A file kind without name and MIME type is never shown by sniffing.
    record.kind = 'file';
    await expect(service.open(ID, { senderId: 1 })).resolves.toBe(false);
    record.kind = 'image';
    // Active content is refused even for an image record.
    const html = Buffer.from('<html><script>1</script></html>');
    await writeFile(item.absolutePath, html);
    record.sizeBytes = html.byteLength; record.sha256 = digest(html);
    await expect(service.open(ID, { senderId: 1 })).resolves.toBe(false);
    service.shutdown();
  });

  describe('open', () => {
    async function openCase(fileName: string, bytes: Uint8Array, record: Partial<PreviewRecord>) {
      const item = await stored('group', fileName, bytes);
      const full: PreviewRecord = { attachmentId: ID, accountId: 'acct', chatType: 'group', chatId: 'chat', kind: 'image', name: null, mimeType: null,
        status: 'ready', relativePath: item.relativePath, sizeBytes: bytes.byteLength, sha256: digest(bytes), ...record };
      const shell: string[] = [];
      const viewer: string[] = [];
      const service = new AttachmentOpenService({ root: item.root, authority: { lookup: async () => full },
        openPath: async (file) => { shell.push(file); return ''; },
        viewImage: async (id) => { viewer.push(id); return true; } });
      const opened = await service.open(ID, { senderId: 1 });
      await service.shutdown();
      return { opened, shell, viewer, item };
    }

    it('sends an unnamed .bin JPEG to the in-app viewer, not the shell', async () => {
      const { opened, shell, viewer } = await openCase('attachment.bin', JPEG, {});
      expect(opened).toBe(true);
      expect(viewer).toEqual([ID]);
      expect(shell).toEqual([]);
    });

    it('still sends a named .png file to the shell', async () => {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
      const { opened, shell, viewer, item } = await openCase('photo.png', png, { name: 'photo.png', mimeType: 'image/png' });
      expect(opened).toBe(true);
      expect(viewer).toEqual([]);
      expect(shell).toEqual([item.absolutePath]);
    });

    it('keeps the shell for a .bin image whose bytes are not an image', async () => {
      const { shell, viewer } = await openCase('attachment.bin', Buffer.from('not an image'), {});
      expect(viewer).toEqual([]);
      expect(shell).toHaveLength(1);
    });

    it('keeps the shell for a .bin file that is not an image record', async () => {
      const { shell, viewer } = await openCase('attachment.bin', JPEG, { kind: 'file' });
      expect(viewer).toEqual([]);
      expect(shell).toHaveLength(1);
    });
  });
});
