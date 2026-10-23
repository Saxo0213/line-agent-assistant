import { describe, expect, it } from 'vitest';
import { isSafeAttachment, isAllowedNavigation, resolveManagedAttachment, createAttachmentOpener, PRODUCTION_RENDERER_CSP, RENDERER_DEV_URL, rendererContentSecurityPolicy } from './security.js';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('desktop security rules', () => {
  it('keeps production CSP strict and grants HMR sources only to the exact unpackaged Vite URL', () => {
    expect(PRODUCTION_RENDERER_CSP).toBe("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: line-media:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
    const developmentPolicy = rendererContentSecurityPolicy(false, RENDERER_DEV_URL);
    expect(developmentPolicy).toContain("script-src 'self' 'unsafe-inline'");
    expect(developmentPolicy).toContain("style-src 'self' 'unsafe-inline'");
    expect(developmentPolicy).toContain('connect-src \'self\' http://127.0.0.1:5173 ws://127.0.0.1:5173');
    expect(rendererContentSecurityPolicy(true, RENDERER_DEV_URL)).toBe(PRODUCTION_RENDERER_CSP);
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5174/', 'http://127.0.0.1:5173']) {
      expect(rendererContentSecurityPolicy(false, url)).toBe(PRODUCTION_RENDERER_CSP);
    }
  });

  it('blocks external navigation, new windows and active file types', () => {
    expect(isAllowedNavigation('file:///app/index.html', 'file:///app/index.html')).toBe(true);
    expect(isAllowedNavigation('https://evil.example', 'file:///app/index.html')).toBe(false);
    for (const name of ['invoice.pdf.exe', 'note.html', 'preview.svg', 'shortcut.lnk', 'run.cmd', 'file.pdf.js']) {
      expect(isSafeAttachment(name, 'application/pdf')).toBe(false);
    }
    expect(isSafeAttachment('invoice.pdf', 'application/pdf')).toBe(true);
  });

  it('rechecks real paths and rejects a link escaping the managed root', async () => {
    const root = 'C:\\managed';
    const resolved = await resolveManagedAttachment(root, 'chat/file.pdf', async (path) => path === root ? root : 'C:\\outside\\file.pdf');
    expect(resolved).toBeNull();
  });

  it('resolves metadata by UUID at open time and never opens active content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-open-'));
    const opened: string[] = [];
    const metadata = { name: 'invoice.pdf', mimeType: 'application/pdf', relativePath: 'chat/invoice.pdf', status: 'ready' };
    const open = createAttachmentOpener({ root, lookup: async () => metadata, previewBytes: async ({ bytes }) => { opened.push(Buffer.from(bytes).toString('utf8')); return true; } });
    try {
      await mkdir(path.join(root, 'chat'));
      await writeFile(path.join(root, 'chat', 'invoice.pdf'), '%PDF-1.7 safe');
      expect(await resolveManagedAttachment(root, 'chat/invoice.pdf')).toBe(await realpath(path.join(root, 'chat', 'invoice.pdf')));
      expect(await open('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(true);
      expect(opened).toEqual(['%PDF-1.7 safe']);
      metadata.name = 'invoice.pdf.exe';
      expect(await open('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(false);
      expect(opened).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an actual executable, an in-root junction and Task 4 opaque blobs at open time', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-open-'));
    const opened: string[] = [];
    const metadata = { name: 'invoice.pdf', mimeType: 'application/pdf', relativePath: 'chat/invoice.pdf.exe', status: 'ready' };
    const open = createAttachmentOpener({ root, lookup: async () => metadata, previewBytes: async ({ bytes }) => { opened.push(Buffer.from(bytes).toString('utf8')); return true; } });
    const id = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    try {
      await mkdir(path.join(root, 'chat'));
      await mkdir(path.join(root, 'real'));
      await writeFile(path.join(root, 'chat', 'invoice.pdf.exe'), 'MZ executable');
      await writeFile(path.join(root, 'real', 'invoice.pdf'), '%PDF-1.7 safe');
      await writeFile(path.join(root, 'chat', 'att-' + 'a'.repeat(64) + '.blob'), '%PDF-1.7 opaque');
      expect(await open(id)).toBe(false);
      await symlink(path.join(root, 'real'), path.join(root, 'link'), 'junction');
      metadata.relativePath = 'link/invoice.pdf';
      expect(await open(id)).toBe(false);
      metadata.relativePath = `chat/att-${'a'.repeat(64)}.blob`;
      expect(await open(id)).toBe(false);
      metadata.relativePath = 'real/invoice.pdf';
      expect(await open(id)).toBe(true);
      expect(opened).toEqual(['%PDF-1.7 safe']);
    } finally {
      if (path.relative(tmpdir(), root).startsWith('..')) throw new Error('temporary target escaped');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps validated bytes when the checked source pathname is replaced before preview', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-source-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'desktop-outside-'));
    const source = path.join(root, 'chat', 'invoice.pdf');
    const outsideFile = path.join(outside, 'outside.pdf');
    const seen: string[] = [];
    const openAttachment = createAttachmentOpener({
      root,
      lookup: async () => ({ name: 'invoice.pdf', mimeType: 'application/pdf', relativePath: 'chat/invoice.pdf', status: 'ready' }),
      previewBytes: async ({ bytes }) => {
        await rename(source, `${source}.moved`);
        await symlink(outsideFile, source, 'file');
        seen.push(Buffer.from(bytes).toString('utf8'));
        return true;
      },
    });
    try {
      await mkdir(path.dirname(source));
      await writeFile(source, '%PDF-1.7 managed');
      await writeFile(outsideFile, '%PDF-1.7 outside');
      expect(await openAttachment('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(true);
      expect(seen).toEqual(['%PDF-1.7 managed']);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('never treats a shell-opened staged path as trusted after same-user replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-stage-race-'));
    let shellCalls = 0;
    const openAttachment = createAttachmentOpener({
      root,
      lookup: async () => ({ name: 'invoice.pdf', mimeType: 'application/pdf', relativePath: 'invoice.pdf', status: 'ready' }),
      openPath: async (file: string) => {
        shellCalls += 1;
        await rename(file, `${file}.original`);
        await writeFile(file, '<html>attacker content</html>');
        expect(await readFile(file, 'utf8')).toBe('<html>attacker content</html>');
        return '';
      },
    } as Parameters<typeof createAttachmentOpener>[0]);
    try {
      await writeFile(path.join(root, 'invoice.pdf'), '%PDF-1.7 managed');
      expect(await openAttachment('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(false);
      expect(shellCalls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('hands validated bytes to a trusted in-app preview without invoking shell paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-bytes-'));
    const seen: string[] = [];
    let shellCalls = 0;
    const openAttachment = createAttachmentOpener({
      root,
      lookup: async () => ({ name: 'invoice.pdf', mimeType: 'application/pdf', relativePath: 'invoice.pdf', status: 'ready' }),
      openPath: async () => { shellCalls += 1; return ''; },
      previewBytes: async ({ bytes }: { bytes: Uint8Array }) => { seen.push(Buffer.from(bytes).toString('utf8')); return true; },
    } as Parameters<typeof createAttachmentOpener>[0]);
    try {
      await writeFile(path.join(root, 'invoice.pdf'), '%PDF-1.7 managed');
      expect(await openAttachment('2a653934-7064-4d90-a9f0-e6e24cf4f93d')).toBe(true);
      expect(seen).toEqual(['%PDF-1.7 managed']);
      expect(shellCalls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
