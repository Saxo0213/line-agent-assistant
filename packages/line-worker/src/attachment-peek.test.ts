import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fallbackAttachmentFileName, peekAttachmentSource } from './attachment-peek.js';
import { buildAttachmentLocation, isPrimaryAttachmentRelativePath } from './attachment-store.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X')]);

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> { for (const part of parts) yield part; }
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

describe('fallback file name from downloaded bytes', () => {
  it.each([
    ['attachment.jpg', JPEG], ['attachment.png', PNG], ['attachment.gif', GIF], ['attachment.webp', WEBP],
    ['attachment.bin', Buffer.from('plain unknown bytes')], ['attachment.bin', Buffer.alloc(0)],
  ])('names the file %s', (expected, bytes) => {
    expect(fallbackAttachmentFileName(bytes)).toBe(expected);
  });

  it('peeks across small chunks and replays every byte in order', async () => {
    const peeked = await peekAttachmentSource(chunks(JPEG.subarray(0, 1), JPEG.subarray(1, 2), JPEG.subarray(2, 9), JPEG.subarray(9)), 12, new AbortController().signal);
    expect(fallbackAttachmentFileName(peeked.prefix)).toBe('attachment.jpg');
    expect(peeked.prefix.byteLength).toBe(12);
    expect(await collect(peeked.source)).toEqual(JPEG);
  });

  it('handles a source shorter than the prefix and an empty source', async () => {
    const short = await peekAttachmentSource(chunks(Buffer.from([0xff, 0xd8])), 12, new AbortController().signal);
    expect(fallbackAttachmentFileName(short.prefix)).toBe('attachment.bin');
    expect(await collect(short.source)).toEqual(Buffer.from([0xff, 0xd8]));
    const empty = await peekAttachmentSource(chunks(), 12, new AbortController().signal);
    expect(await collect(empty.source)).toEqual(Buffer.alloc(0));
  });

  it('stops with the abort reason and closes the source', async () => {
    const controller = new AbortController();
    let closed = false;
    const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      return: async () => { closed = true; return { done: true, value: undefined }; },
    }) };
    const pending = peekAttachmentSource(source, 12, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    expect(closed).toBe(true);
  });
});

describe('primary managed path validator', () => {
  const base = { root: 'C:\\attachments', occurredAt: '2026-11-06T14:37:41.000Z', originalFileName: 'attachment.jpg' };
  const location = (chatType: 'direct' | 'group' | 'room', displayName: string | null = 'Ivy') => buildAttachmentLocation({
    ...base, identity: { accountId: 'acct', chatType, chatId: 'chat', messageId: 'msg', externalAttachmentId: 'ext' },
    sender: { id: 'u1', displayName } }).managedRelativePath;

  it('accepts exactly what the builder makes', () => {
    for (const chatType of ['direct', 'group', 'room'] as const) expect(isPrimaryAttachmentRelativePath(location(chatType))).toBe(true);
    expect(location('direct').split('/')).toHaveLength(9);
    expect(location('group').split('/')).toHaveLength(8);
    expect(location('room').split('/')).toHaveLength(8);
    for (const name of ['Ivy\u{13170}', '\u{1F600}\u{1F600}', 'x'.repeat(80), '未知', null]) {
      expect(isPrimaryAttachmentRelativePath(location('group', name))).toBe(true);
    }
  });

  it('accepts a sender segment cut at 48 code points on a dot or a space', () => {
    for (const filler of ['.', ' ']) {
      const name = ('a'.repeat(47) + filler).padEnd(60, 'z');
      for (const chatType of ['group', 'room'] as const) {
        const relativePath = location(chatType, name);
        expect(relativePath.split('/')[4]).toMatch(new RegExp('^a{47}[. ]-[0-9a-f]{12}$'));
        expect(isPrimaryAttachmentRelativePath(relativePath)).toBe(true);
      }
    }
  });

  it('accepts every path the builder makes for varied sender names', () => {
    const names: Array<string | null> = ['', null, ' ', '.', '...', 'Ivy...', 'Ivy   ', '\u{13170}'.repeat(60), '\u{1F600}x'.repeat(30),
      'a\uD800b', '\uDC00', 'x'.repeat(100), ('y'.repeat(47) + '.').padEnd(100, 'q'), 'a<b>c:d"e/f\\g|h?i*j', '\u0001\u001f',
      'con', 'ＡＢＣ　全形', 'é'.normalize('NFD').repeat(30), 'tab\tname', '未知發言人'];
    for (const name of names) {
      for (const chatType of ['direct', 'group', 'room'] as const) {
        expect(isPrimaryAttachmentRelativePath(location(chatType, name)), JSON.stringify([chatType, name])).toBe(true);
      }
    }
  });

  it('rejects wrong shapes', () => {
    const good = location('group');
    const parts = good.split('/');
    const mutate = (index: number, value: string) => parts.map((part, at) => at === index ? value : part).join('/');
    expect(isPrimaryAttachmentRelativePath(parts.slice(1).join('/'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(`${good}/extra`)).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(0, 'other'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(1, 'acct'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(2, 'channel'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(3, 'id-zz'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(4, '..'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(4, 'Ivy-short'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(4, 'Iv:y-65579a60d121'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(5, '2026-11-06_id-6d7367'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(6, 'f'.repeat(63)))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(6, 'g'.repeat(64)))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(7, '..'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(7, 'a.'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(7, 'con.txt'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath(mutate(7, 'a|b'))).toBe(false);
    expect(isPrimaryAttachmentRelativePath('')).toBe(false);
  });
});
