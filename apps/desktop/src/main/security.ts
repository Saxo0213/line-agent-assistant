import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';

const dangerous = new Set(['exe', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'mjs', 'cjs', 'msi', 'scr', 'lnk', 'url', 'hta', 'html', 'htm', 'svg', 'svgz', 'xhtml', 'xml']);
const allowed = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'zip', 'mp3', 'mp4', 'wav']);
export const RENDERER_DEV_URL = 'http://127.0.0.1:5173/';
export const PRODUCTION_RENDERER_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: line-media:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
const DEVELOPMENT_RENDERER_CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: line-media:", "font-src 'self'", "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
const mimeByExtension: Record<string, string[]> = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'],
  txt: ['text/plain'], csv: ['text/csv', 'application/csv'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  zip: ['application/zip', 'application/x-zip-compressed'], mp3: ['audio/mpeg'], mp4: ['video/mp4'], wav: ['audio/wav', 'audio/x-wav'],
};

export function rendererContentSecurityPolicy(isPackaged: boolean, rendererUrl: string): string {
  return !isPackaged && rendererUrl === RENDERER_DEV_URL ? DEVELOPMENT_RENDERER_CSP : PRODUCTION_RENDERER_CSP;
}

export function isAllowedNavigation(target: string, rendererUrl: string): boolean {
  return target === rendererUrl;
}

export function isSafeAttachment(name: string, mimeType: string | null): boolean {
  if (!name || /[\\/\u0000-\u001f]/.test(name)) return false;
  const segments = name.toLowerCase().split('.');
  const extension = segments.at(-1) ?? '';
  if (!allowed.has(extension) || segments.some((segment) => dangerous.has(segment))) return false;
  return mimeType !== null && (mimeByExtension[extension]?.includes(mimeType.toLowerCase()) ?? false);
}

export async function resolveManagedAttachment(root: string, relativePath: string, canonicalize: (path: string) => Promise<string> = realpath): Promise<string | null> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes(':') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  const canonicalRoot = await canonicalize(root);
  const canonicalFile = await canonicalize(path.join(root, ...relativePath.split('/')));
  const relation = path.relative(canonicalRoot, canonicalFile);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null;
  return canonicalFile;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

function matchesContent(header: Buffer, extension: string): boolean {
  const prefix = header.toString('utf8', 0, Math.min(header.length, 256)).trimStart().toLowerCase();
  if (header.subarray(0, 2).toString('ascii') === 'MZ' || prefix.startsWith('#!') || prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<svg') || prefix.startsWith('<?xml')) return false;
  if (extension === 'pdf') return header.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === 'png') return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === 'jpg' || extension === 'jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'));
  if (extension === 'webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (['zip', 'docx', 'xlsx', 'pptx'].includes(extension)) return header.subarray(0, 2).toString('ascii') === 'PK';
  return true;
}

async function inspectManagedFile(root: string, relativePath: string, displayName: string, mimeType: string | null): Promise<{ file: string; handle: Awaited<ReturnType<typeof open>> } | null> {
  const file = await resolveManagedAttachment(root, relativePath);
  if (!file || !isSafeAttachment(displayName, mimeType)) return null;
  const extension = path.extname(displayName).toLowerCase();
  if (path.extname(file).toLowerCase() !== extension || !isSafeAttachment(path.basename(file), mimeType)) return null;
  // Task 4 writes opaque att-<digest>.blob files. Shell association must never be inferred from display metadata.
  if (path.extname(file).toLowerCase() === '.blob') return null;
  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  let segmentPath = canonicalRoot;
  for (const segment of relativePath.split('/')) {
    segmentPath = path.join(segmentPath, segment);
    const entry = await lstat(segmentPath);
    if (entry.isSymbolicLink() || !samePath(await realpath(segmentPath), segmentPath)) return null;
  }
  if (!samePath(segmentPath, file)) return null;
  const handle = await open(file, 'r');
  try {
    const held = await handle.stat();
    const current = await lstat(file);
    if (!held.isFile() || !current.isFile() || held.dev !== current.dev || held.ino !== current.ino || held.size !== current.size) { await handle.close(); return null; }
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!matchesContent(header.subarray(0, bytesRead), extension.slice(1))) { await handle.close(); return null; }
    return { file, handle };
  } catch (error) { await handle.close(); throw error; }
}

async function readValidatedBytes(source: Awaited<ReturnType<typeof open>>, extension: string): Promise<Uint8Array | null> {
  const before = await source.stat();
  if (!before.isFile() || before.size < 0 || before.size > 32 * 1024 * 1024) return null;
  const bytes = Buffer.alloc(before.size);
  let position = 0;
  while (position < bytes.length) {
    const result = await source.read(bytes, position, bytes.length - position, position);
    if (!result.bytesRead) return null;
    position += result.bytesRead;
  }
  const after = await source.stat();
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
  if (!matchesContent(bytes.subarray(0, 512), extension.slice(1))) return null;
  return Uint8Array.from(bytes);
}

export function createAttachmentOpener(options: {
  root: string;
  lookup: (attachmentId: string) => Promise<{ name: string; mimeType: string | null; relativePath: string; status: string } | null>;
  // Legacy preview helper: it renders verified bytes in an isolated in-app viewer. OS opening uses AttachmentOpenService.
  previewBytes?: (attachment: { name: string; mimeType: string; bytes: Uint8Array }) => Promise<boolean>;
}) {
  return async (attachmentId: string): Promise<boolean> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return false;
    const metadata = await options.lookup(attachmentId);
    if (!metadata || metadata.status !== 'ready' || !isSafeAttachment(metadata.name, metadata.mimeType) || !metadata.mimeType || !options.previewBytes) return false;
    try {
      const inspected = await inspectManagedFile(options.root, metadata.relativePath, metadata.name, metadata.mimeType);
      if (!inspected) return false;
      try {
        const bytes = await readValidatedBytes(inspected.handle, path.extname(inspected.file));
        return bytes ? await options.previewBytes({ name: metadata.name, mimeType: metadata.mimeType, bytes }) : false;
      }
      finally { await inspected.handle.close(); }
    } catch { return false; }
  };
}
