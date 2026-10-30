// In-memory filesystem for ltsm tests (Windows-style paths). Not part of the package build.

import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
import type { LtsmDirEntry, LtsmFileStat, LtsmWritableFs } from './fs.js';
import type { LtsmVersionPin } from './pins.js';

export class MemFs implements LtsmWritableFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  /** Every readFile call, in order. */
  readonly reads: string[] = [];
  /** Throw from rename when this returns true for the destination path. */
  failRename: ((to: string) => boolean) | undefined;

  private norm(p: string): string {
    return win32.normalize(p).replace(/[\\/]+$/, '');
  }

  addFile(path: string, data: Uint8Array | string): void {
    const p = this.norm(path);
    this.addDir(win32.dirname(p));
    this.files.set(p, typeof data === 'string' ? Buffer.from(data) : data);
  }

  addDir(path: string): void {
    let p = this.norm(path);
    while (p && !this.dirs.has(p)) {
      this.dirs.add(p);
      const parent = win32.dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }

  async readdir(dir: string): Promise<readonly LtsmDirEntry[]> {
    const d = this.norm(dir);
    if (!this.dirs.has(d)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    const out: LtsmDirEntry[] = [];
    for (const sub of this.dirs) {
      if (sub !== d && win32.dirname(sub) === d) out.push({ name: win32.basename(sub), isDirectory: () => true, isFile: () => false });
    }
    for (const file of this.files.keys()) {
      if (win32.dirname(file) === d) out.push({ name: win32.basename(file), isDirectory: () => false, isFile: () => true });
    }
    return out;
  }

  async stat(path: string): Promise<LtsmFileStat> {
    const p = this.norm(path);
    const file = this.files.get(p);
    if (file) return { size: file.byteLength, isFile: () => true };
    if (this.dirs.has(p)) return { size: 0, isFile: () => false };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = this.norm(path);
    this.reads.push(p);
    const file = this.files.get(p);
    if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return file;
  }

  async mkdir(dir: string): Promise<void> {
    this.addDir(dir);
  }

  async writeFileExclusive(path: string, data: Uint8Array): Promise<void> {
    const p = this.norm(path);
    if (this.files.has(p)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    if (!this.dirs.has(win32.dirname(p))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    this.files.set(p, data);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.norm(from);
    const t = this.norm(to);
    if (this.failRename?.(t)) throw new Error(`rename blocked: ${to}`);
    const data = this.files.get(f);
    if (!data) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
    this.files.delete(f);
    this.files.set(t, data);
  }

  async rm(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }
}

export function md5Of(data: Uint8Array | string): string {
  return createHash('md5').update(data).digest('hex');
}

/** Builds a pin for small fake assets so no real LINE file is needed. */
export function fakePin(wasm: Uint8Array | string, sandbox: Uint8Array | string, version = '3.7.2'): LtsmVersionPin {
  const size = (d: Uint8Array | string): number => (typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength);
  return {
    version,
    assets: [
      { fileName: 'ltsm.wasm', md5: md5Of(wasm), size: size(wasm) },
      { fileName: 'ltsmSandbox.js', md5: md5Of(sandbox), size: size(sandbox) },
    ],
  };
}
