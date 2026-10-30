// Minimal filesystem and path surfaces used by ltsm discovery and the asset store. Injected so tests run on a fake tree.

import { promises as nodeFs } from 'node:fs';
import type nodePath from 'node:path';

export interface LtsmDirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface LtsmFileStat {
  readonly size: number;
  isFile(): boolean;
}

export interface LtsmFs {
  readdir(dir: string): Promise<readonly LtsmDirEntry[]>;
  stat(path: string): Promise<LtsmFileStat>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface LtsmWritableFs extends LtsmFs {
  /** Creates the directory and any missing parents. */
  mkdir(dir: string): Promise<void>;
  /** Fails when the file already exists (exclusive create). */
  writeFileExclusive(path: string, data: Uint8Array): Promise<void>;
  /** Replaces an existing destination. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; a missing file is not an error. */
  rm(path: string): Promise<void>;
}

export type LtsmPath = Pick<typeof nodePath, 'join' | 'basename' | 'dirname'>;

export const nodeLtsmFs: LtsmWritableFs = {
  readdir: (dir) => nodeFs.readdir(dir, { withFileTypes: true }),
  stat: (path) => nodeFs.stat(path),
  readFile: (path) => nodeFs.readFile(path),
  mkdir: async (dir) => {
    await nodeFs.mkdir(dir, { recursive: true });
  },
  writeFileExclusive: (path, data) => nodeFs.writeFile(path, data, { flag: 'wx' }),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (path) => nodeFs.rm(path, { force: true, recursive: true }),
};
