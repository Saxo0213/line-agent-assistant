// Our own verified copy of the extension's secure-module assets (design ruling 12):
//   <userData>\line-chrome\ltsm\<version>\{ltsm.wasm, ltsmSandbox.js}
// Files are copied through a temp name and renamed into place. Every load re-verifies size and md5; a mismatched file is
// never handed out.

import { randomBytes } from 'node:crypto';
import nodePath from 'node:path';
import { ChromeError } from '../errors.js';
import { md5Hex, type LtsmDiscoveryMatch } from './discovery.js';
import { nodeLtsmFs, type LtsmPath, type LtsmWritableFs } from './fs.js';
import { requiredLtsmPin, type LtsmAssetPin, type LtsmVersionPin } from './pins.js';

export type LtsmStoreStatus =
  | { readonly kind: 'available'; readonly version: string; readonly dir: string }
  | { readonly kind: 'missing'; readonly required: string; readonly dir: string }
  | { readonly kind: 'wrong-version'; readonly required: string; readonly detected: readonly string[] }
  | { readonly kind: 'corrupt'; readonly required: string; readonly dir: string; readonly problems: readonly string[] };

/** Raised when something needs the ltsm assets and the store cannot provide them. */
export class LtsmUnavailableError extends ChromeError {
  readonly status: LtsmStoreStatus;

  constructor(status: LtsmStoreStatus) {
    super(describeLtsmStatus(status));
    this.status = status;
  }
}

export function describeLtsmStatus(status: LtsmStoreStatus): string {
  switch (status.kind) {
    case 'available':
      return `LINE Chrome assets for ${status.version} are available`;
    case 'missing':
      return `LINE Chrome assets are not installed (required extension version ${status.required})`;
    case 'wrong-version':
      return `LINE Chrome assets are for extension version ${status.detected.join(', ') || 'unknown'}, but ${status.required} is required`;
    case 'corrupt':
      return `LINE Chrome assets failed verification: ${status.problems.join('; ')}`;
  }
}

export interface LoadedLtsmAssets {
  readonly version: string;
  readonly wasm: Buffer;
  readonly sandbox: Buffer;
}

export interface LtsmStoreOptions {
  /** Electron userData directory. Assets live in `<userDataDir>/line-chrome/ltsm/<version>/`. */
  readonly userDataDir?: string;
  /** Explicit store root (the worker init `chromeLtsmDir`); takes precedence over `userDataDir`. */
  readonly rootDir?: string;
  readonly fs?: LtsmWritableFs;
  readonly path?: LtsmPath;
  readonly pin?: LtsmVersionPin;
}

export class LtsmStore {
  readonly pin: LtsmVersionPin;
  private readonly fs: LtsmWritableFs;
  private readonly path: LtsmPath;
  private readonly rootDir: string;

  constructor(options: LtsmStoreOptions) {
    this.fs = options.fs ?? nodeLtsmFs;
    this.path = options.path ?? nodePath;
    this.pin = options.pin ?? requiredLtsmPin();
    if (options.rootDir === undefined && options.userDataDir === undefined) throw new RangeError('LtsmStore needs rootDir or userDataDir');
    this.rootDir = options.rootDir ?? this.path.join(options.userDataDir as string, 'line-chrome', 'ltsm');
  }

  /** Directory holding the required version's assets. */
  get dir(): string {
    return this.path.join(this.rootDir, this.pin.version);
  }

  /** Verifies the stored files without exposing them. */
  async status(): Promise<LtsmStoreStatus> {
    return (await this.readVerified()).status;
  }

  /** Reads and verifies the assets. Throws `LtsmUnavailableError` unless the status is `available`. */
  async load(): Promise<LoadedLtsmAssets> {
    const result = await this.readVerified();
    if (result.status.kind !== 'available' || !result.assets) throw new LtsmUnavailableError(result.status);
    return result.assets;
  }

  /**
   * Copies verified assets from a discovery match into the store. Sources are verified again here, so a changed source
   * file cannot slip in between discovery and copy.
   */
  async install(match: LtsmDiscoveryMatch): Promise<LtsmStoreStatus> {
    if (match.extensionVersion !== this.pin.version) {
      return { kind: 'wrong-version', required: this.pin.version, detected: [match.extensionVersion] };
    }
    const staged: Array<{ asset: LtsmAssetPin; data: Uint8Array }> = [];
    for (const asset of this.pin.assets) {
      const source = match.assets.find((candidate) => candidate.fileName === asset.fileName);
      if (!source) {
        return { kind: 'corrupt', required: this.pin.version, dir: this.dir, problems: [`${asset.fileName}: not in discovery result`] };
      }
      const data = await this.fs.readFile(source.sourcePath);
      const problem = verifyBytes(asset, data);
      if (problem) {
        return { kind: 'corrupt', required: this.pin.version, dir: this.dir, problems: [problem] };
      }
      staged.push({ asset, data });
    }

    await this.fs.mkdir(this.dir);
    for (const { asset, data } of staged) {
      const finalPath = this.path.join(this.dir, asset.fileName);
      const tempPath = this.path.join(this.dir, `${asset.fileName}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await this.fs.writeFileExclusive(tempPath, data);
        await this.fs.rename(tempPath, finalPath);
      } catch (error) {
        await this.fs.rm(tempPath).catch(() => undefined);
        throw error;
      }
    }
    return this.status();
  }

  /** Removes the stored copy of the required version. */
  async remove(): Promise<void> {
    for (const asset of this.pin.assets) await this.fs.rm(this.path.join(this.dir, asset.fileName));
  }

  private async readVerified(): Promise<{ status: LtsmStoreStatus; assets?: LoadedLtsmAssets }> {
    const dir = this.dir;
    const read = new Map<string, Buffer>();
    const problems: string[] = [];
    let present = 0;
    for (const asset of this.pin.assets) {
      const file = this.path.join(dir, asset.fileName);
      let data: Uint8Array;
      try {
        data = await this.fs.readFile(file);
      } catch {
        continue;
      }
      present += 1;
      const problem = verifyBytes(asset, data);
      if (problem) problems.push(problem);
      else read.set(asset.fileName, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }

    if (present === 0) {
      const others = await this.otherVersions();
      if (others.length > 0) return { status: { kind: 'wrong-version', required: this.pin.version, detected: others } };
      return { status: { kind: 'missing', required: this.pin.version, dir } };
    }
    for (const asset of this.pin.assets) {
      if (!read.has(asset.fileName) && !problems.some((p) => p.startsWith(`${asset.fileName}:`))) {
        problems.push(`${asset.fileName}: file is missing`);
      }
    }
    if (problems.length > 0) return { status: { kind: 'corrupt', required: this.pin.version, dir, problems } };

    return {
      status: { kind: 'available', version: this.pin.version, dir },
      assets: { version: this.pin.version, wasm: read.get('ltsm.wasm')!, sandbox: read.get('ltsmSandbox.js')! },
    };
  }

  private async otherVersions(): Promise<string[]> {
    try {
      return (await this.fs.readdir(this.rootDir))
        .filter((entry) => entry.isDirectory() && entry.name !== this.pin.version)
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function verifyBytes(asset: LtsmAssetPin, data: Uint8Array): string | undefined {
  if (data.byteLength !== asset.size) {
    return `${asset.fileName}: size ${data.byteLength} does not match the expected ${asset.size}`;
  }
  const md5 = md5Hex(data);
  if (md5 !== asset.md5) return `${asset.fileName}: md5 ${md5} does not match the expected ${asset.md5}`;
  return undefined;
}
