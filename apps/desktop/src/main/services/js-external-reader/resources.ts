import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const SQLITE3MC = Object.freeze({ bytes: 2_442_576, sha256: '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e' });
const FILES = ['ExternalReaderBridge.exe', 'controller.mjs', 'sqlite3mc_x64.dll'] as const;

export type JsExternalReaderResources = Readonly<{
  bridgePath: string;
  bridgeSha256: string;
  controllerPath: string;
  sqlitePath: string;
}>;

export async function verifyJsExternalReaderResources(resourceRoot: string): Promise<JsExternalReaderResources> {
  const rootInfo = await lstat(resourceRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('reader_resource_integrity_failed');
  const root = await realpath(resourceRoot);
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...FILES, 'manifest.json'].sort())) throw new Error('reader_resource_integrity_failed');
  const manifestBytes = await readBounded(path.join(root, 'manifest.json'), 16 * 1024);
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('reader_resource_integrity_failed'); }
  if (!isManifest(manifest)) throw new Error('reader_resource_integrity_failed');
  for (const name of FILES) {
    const current = await readBounded(path.join(root, name), name === 'sqlite3mc_x64.dll' ? SQLITE3MC.bytes : 16 * 1024 * 1024);
    const expected = manifest.files[name];
    if (current.byteLength !== expected.bytes || createHash('sha256').update(current).digest('hex') !== expected.sha256) {
      throw new Error('reader_resource_integrity_failed');
    }
    if (name === 'sqlite3mc_x64.dll' && (expected.bytes !== SQLITE3MC.bytes || expected.sha256 !== SQLITE3MC.sha256)) {
      throw new Error('reader_resource_integrity_failed');
    }
  }
  const bridge = await readBounded(path.join(root, 'ExternalReaderBridge.exe'), 16 * 1024 * 1024);
  if (!isX64Pe(bridge)) throw new Error('reader_resource_integrity_failed');
  return {
    bridgePath: path.join(root, 'ExternalReaderBridge.exe'),
    bridgeSha256: manifest.files['ExternalReaderBridge.exe'].sha256,
    controllerPath: path.join(root, 'controller.mjs'),
    sqlitePath: path.join(root, 'sqlite3mc_x64.dll'),
  };
}

async function readBounded(filename: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(filename).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) throw new Error('reader_resource_integrity_failed');
  const bytes = await readFile(filename);
  if (bytes.byteLength !== info.size) throw new Error('reader_resource_integrity_failed');
  return bytes;
}

function isManifest(value: unknown): value is { schemaVersion: 1; candidateVersion: 'v1'; capability: 'readonly_source_verify_candidate'; files: Record<typeof FILES[number], { bytes: number; sha256: string }> } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(',') !== 'candidateVersion,capability,files,schemaVersion' ||
      manifest.schemaVersion !== 1 || manifest.candidateVersion !== 'v1' || manifest.capability !== 'readonly_source_verify_candidate' ||
      manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) return false;
  const files = manifest.files as Record<string, unknown>;
  if (Object.keys(files).sort().join(',') !== [...FILES].sort().join(',')) return false;
  return FILES.every((name) => {
    const item = files[name];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return Object.keys(record).sort().join(',') === 'bytes,sha256' && Number.isSafeInteger(record.bytes) &&
      (record.bytes as number) > 0 && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256);
  });
}

function isX64Pe(bytes: Buffer): boolean {
  if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset + 6 <= bytes.byteLength && bytes[offset] === 0x50 && bytes[offset + 1] === 0x45 &&
    bytes[offset + 2] === 0 && bytes[offset + 3] === 0 && bytes.readUInt16LE(offset + 4) === 0x8664;
}
