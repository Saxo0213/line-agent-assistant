import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentAttachmentError, ATTACHMENT_DIRECTORY, attachmentPromptSection, removeJobAttachments, resolveStoredAttachments,
  sanitizeAttachmentName, sniffAttachment, storeAttachments, validateUploads,
} from './agent-attachments.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MB = 1024 * 1024;
let workspace: string;

beforeEach(async () => { workspace = await realpath(await mkdtemp(join(tmpdir(), 'linejs-attach-'))); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

describe('sanitizeAttachmentName', () => {
  it('keeps only the last path segment so traversal cannot leave the job directory', () => {
    expect(sanitizeAttachmentName('..\\..\\x.exe')).toBe('x.exe');
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('C:\\Windows\\win.ini')).toBe('win.ini');
    expect(sanitizeAttachmentName('..', 3)).toBe('file-4');
    expect(sanitizeAttachmentName('', 0)).toBe('file-1');
  });
  it('repairs Windows-reserved names and characters, trailing dots and lone surrogates', () => {
    expect(sanitizeAttachmentName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeAttachmentName('nul')).toBe('_nul');
    expect(sanitizeAttachmentName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeAttachmentName('report. . ')).toBe('report');
    expect(sanitizeAttachmentName('bad\ud800.txt')).toBe('bad_.txt');
    expect(sanitizeAttachmentName('line\nbreak.txt')).toBe('line_break.txt');
  });
  it('caps a very long name at 180 bytes and keeps the extension', () => {
    const long = sanitizeAttachmentName(`${'長'.repeat(200)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(180);
    expect(long.endsWith('.pdf')).toBe(true);
    const ascii = sanitizeAttachmentName(`${'a'.repeat(400)}.png`);
    expect(Buffer.byteLength(ascii)).toBeLessThanOrEqual(180);
    expect(ascii.endsWith('.png')).toBe(true);
  });
});

describe('sniffAttachment', () => {
  it('decides the type from magic bytes, never from the name', () => {
    expect(sniffAttachment(PNG, 'x.txt')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffAttachment(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'x.bin')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(sniffAttachment(new TextEncoder().encode('GIF89a....'), 'x')).toEqual({ kind: 'image', mime: 'image/gif' });
    expect(sniffAttachment(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '), 'x')).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(sniffAttachment(new TextEncoder().encode('%PDF-1.7'), 'x.png')).toEqual({ kind: 'file', mime: 'application/octet-stream' });
    expect(sniffAttachment(new TextEncoder().encode('hello'), 'notes.md')).toEqual({ kind: 'file', mime: 'text/markdown' });
  });
});

describe('validateUploads', () => {
  it('re-checks count, per-file and total limits and rejects bad names', () => {
    const upload = (name: string, size: number) => ({ name, bytes: new Uint8Array(size) });
    expect(() => validateUploads(Array.from({ length: 11 }, (_, i) => upload(`f${i}`, 1)))).toThrow(AgentAttachmentError);
    expect(() => validateUploads([upload('big', 20 * MB + 1)])).toThrow(AgentAttachmentError);
    expect(() => validateUploads([upload('a', 20 * MB), upload('b', 20 * MB), upload('c', 10 * MB + 1)])).toThrow(AgentAttachmentError);
    expect(() => validateUploads([upload('', 1)])).toThrow(AgentAttachmentError);
    expect(() => validateUploads([upload('n'.repeat(256), 1)])).toThrow(AgentAttachmentError);
    expect(() => validateUploads([{ name: 'x', bytes: [1, 2] as unknown as Uint8Array }])).toThrow(AgentAttachmentError);
    expect(() => validateUploads([upload('a', 20 * MB), upload('b', 20 * MB), upload('c', 10 * MB)])).not.toThrow();
  });
});

describe('storeAttachments', () => {
  it('writes sanitized, de-duplicated files under .agent-attachments/<jobId> with sha256 and sniffed kind', async () => {
    const jobId = randomUUID();
    const pdf = new TextEncoder().encode('%PDF-1.7 body');
    const stored = await storeAttachments({ workspace, jobId, uploads: [
      { name: 'shot.png', bytes: PNG }, { name: '..\\..\\shot.png', bytes: pdf }, { name: 'CON.txt', bytes: pdf }] });
    expect(stored.map((item) => item.name)).toEqual(['shot.png', 'shot (2).png', '_CON.txt']);
    expect(stored[0]).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.byteLength, relativePath: `${ATTACHMENT_DIRECTORY}/${jobId}/shot.png`,
      sha256: createHash('sha256').update(PNG).digest('hex') });
    expect(stored[1]).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });
    expect((await readdir(join(workspace, ATTACHMENT_DIRECTORY, jobId))).sort()).toEqual(['_CON.txt', 'shot (2).png', 'shot.png']);
    expect(new Uint8Array(await readFile(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'shot.png')))).toEqual(PNG);
    // Nothing escaped the job directory.
    expect((await readdir(workspace)).sort()).toEqual([ATTACHMENT_DIRECTORY]);
  });

  it('rejects a non-UUID job id and over-limit input without touching the disk', async () => {
    await expect(storeAttachments({ workspace, jobId: '..\\..', uploads: [{ name: 'a', bytes: PNG }] })).rejects.toBeInstanceOf(AgentAttachmentError);
    await expect(storeAttachments({ workspace, jobId: randomUUID(), uploads: [{ name: 'a', bytes: new Uint8Array(20 * MB + 1) }] })).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT' });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('removes the whole job directory when a write fails midway (no leftover files)', async () => {
    const jobId = randomUUID();
    // A directory named like the second file's stored name makes its exclusive write fail after the first file succeeded.
    await mkdir(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'second.txt'), { recursive: true });
    await expect(storeAttachments({ workspace, jobId, uploads: [{ name: 'first.png', bytes: PNG }, { name: 'second.txt', bytes: PNG }] }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' });
    await expect(stat(join(workspace, ATTACHMENT_DIRECTORY, jobId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write through a link that escapes the workspace', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'linejs-outside-')));
    try {
      const jobId = randomUUID();
      await mkdir(join(workspace, ATTACHMENT_DIRECTORY), { recursive: true });
      try { await symlink(outside, join(workspace, ATTACHMENT_DIRECTORY, jobId), 'junction'); } catch { return; /* links unavailable here */ }
      await expect(storeAttachments({ workspace, jobId, uploads: [{ name: 'a.png', bytes: PNG }] })).rejects.toBeInstanceOf(AgentAttachmentError);
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

describe('resolveStoredAttachments', () => {
  it('returns real paths for intact files and ATTACHMENT_MISSING when a file is gone or changed', async () => {
    const jobId = randomUUID();
    const stored = await storeAttachments({ workspace, jobId, uploads: [{ name: 'a.png', bytes: PNG }, { name: 'b.txt', bytes: new TextEncoder().encode('hello') }] });
    const resolved = await resolveStoredAttachments(workspace, jobId, stored);
    expect(resolved.map((item) => item.absolutePath)).toEqual([join(workspace, ATTACHMENT_DIRECTORY, jobId, 'a.png'), join(workspace, ATTACHMENT_DIRECTORY, jobId, 'b.txt')]);
    await writeFile(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'b.txt'), 'changed size!');
    await expect(resolveStoredAttachments(workspace, jobId, stored)).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
    await unlink(join(workspace, ATTACHMENT_DIRECTORY, jobId, 'a.png'));
    await expect(resolveStoredAttachments(workspace, jobId, stored.slice(0, 1))).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
  });

  it('rejects stored metadata whose path points outside the job directory', async () => {
    const jobId = randomUUID();
    const [item] = await storeAttachments({ workspace, jobId, uploads: [{ name: 'a.png', bytes: PNG }] });
    await expect(resolveStoredAttachments(workspace, jobId, [{ ...item!, relativePath: `${ATTACHMENT_DIRECTORY}/${jobId}/../../x.png` }])).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
    await expect(resolveStoredAttachments(workspace, jobId, [{ ...item!, relativePath: 'other/a.png' }])).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
  });
});

describe('removeJobAttachments and the prompt section', () => {
  it('removes only the named job directory and is idempotent', async () => {
    const first = randomUUID(); const second = randomUUID();
    await storeAttachments({ workspace, jobId: first, uploads: [{ name: 'a.png', bytes: PNG }] });
    await storeAttachments({ workspace, jobId: second, uploads: [{ name: 'a.png', bytes: PNG }] });
    await removeJobAttachments(workspace, first);
    await removeJobAttachments(workspace, first);
    expect(await readdir(join(workspace, ATTACHMENT_DIRECTORY))).toEqual([second]);
  });

  it('lists workspace-relative paths with image notes per provider', () => {
    const items = [
      { name: 'a.png', size: 2048, kind: 'image' as const, mime: 'image/png', sha256: 'a'.repeat(64), relativePath: '.agent-attachments/j/a.png' },
      { name: 'b.pdf', size: 12, kind: 'file' as const, mime: 'application/octet-stream', sha256: 'b'.repeat(64), relativePath: '.agent-attachments/j/b.pdf' },
    ];
    const claude = attachmentPromptSection('claude', items);
    expect(claude).toContain('---\n附件（位於工作目錄內，請直接讀取）：');
    expect(claude).toContain('[1] a.png（image/png，2.0 KB）路徑：.agent-attachments/j/a.png 這是圖片，請用 Read 讀取後再回答。');
    expect(claude).toContain('[2] b.pdf（application/octet-stream，12 B）路徑：.agent-attachments/j/b.pdf');
    expect(claude).not.toMatch(/[A-Za-z]:\\/);
    expect(attachmentPromptSection('codex', items)).toContain('這是圖片，已隨訊息附上。');
  });
});
