// Finds the installed LINE Chrome extension (design ruling 12) and verifies its secure-module assets against the pins.
// Layout searched: <LOCALAPPDATA>\Google\Chrome\User Data\<profile>\Extensions\<id>\<version>\ and the same under
// <LOCALAPPDATA>\Microsoft\Edge\User Data\. Inside a version folder the two files are located by size first, then md5;
// no relative path inside the extension is hardcoded.

import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { CHROME_EXTENSION_ID } from '../constants.js';
import { nodeLtsmFs, type LtsmFs, type LtsmPath } from './fs.js';
import { requiredLtsmPin, type LtsmAssetName, type LtsmAssetPin, type LtsmVersionPin } from './pins.js';

export type LtsmBrowser = 'chrome' | 'edge' | 'manual';

export interface LtsmVerifiedAsset {
  readonly fileName: LtsmAssetName;
  /** Absolute path of the source file inside the extension folder. */
  readonly sourcePath: string;
  /** Path relative to the searched folder, `/` separated. */
  readonly relativePath: string;
  readonly size: number;
  readonly md5: string;
}

export interface LtsmDiscoveryMatch {
  readonly browser: LtsmBrowser;
  /** Browser profile directory name, e.g. `Default` or `Profile 2`. Empty for a manual folder. */
  readonly profile: string;
  /** Extension version this install was verified as (the pinned version). */
  readonly extensionVersion: string;
  readonly extensionDir: string;
  readonly assets: readonly LtsmVerifiedAsset[];
}

export type LtsmMismatchReason = 'version-mismatch' | 'md5-mismatch' | 'assets-missing';

export interface LtsmDetectedInstall {
  readonly browser: LtsmBrowser;
  readonly profile: string;
  /** Version reported by the folder name (or manifest for a manual folder); `unknown` when it cannot be told. */
  readonly extensionVersion: string;
  readonly extensionDir: string;
  readonly reason: LtsmMismatchReason;
  /** Files whose size matched a pin but whose md5 did not. */
  readonly mismatchedFiles?: readonly string[];
}

export type LtsmDiscoveryResult =
  | { readonly kind: 'found'; readonly match: LtsmDiscoveryMatch }
  | { readonly kind: 'wrong-version'; readonly required: string; readonly detected: readonly LtsmDetectedInstall[] }
  | { readonly kind: 'not-found'; readonly required: string; readonly searched: readonly string[] };

export interface DiscoveryOptions {
  /** Environment; only `LOCALAPPDATA` is read. */
  readonly env?: { readonly LOCALAPPDATA?: string | undefined };
  readonly fs?: LtsmFs;
  readonly path?: LtsmPath;
  /** Pin to require. Defaults to the 3.7.2 pin. */
  readonly pin?: LtsmVersionPin;
  /** How deep below the version folder to look for the assets. */
  readonly maxDepth?: number;
  /** Safety bound on directory entries visited per folder. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 20_000;
const NOISE_DIRS = new Set(['node_modules', '.git', '_metadata', '__macosx']);

const BROWSER_ROOTS: ReadonlyArray<{ browser: 'chrome' | 'edge'; segments: readonly string[] }> = [
  { browser: 'chrome', segments: ['Google', 'Chrome', 'User Data'] },
  { browser: 'edge', segments: ['Microsoft', 'Edge', 'User Data'] },
];

export function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

/** Chrome stores versions as `3.7.2_0`; strip the `_<n>` suffix. */
export function versionFromFolderName(name: string): string {
  return name.replace(/_\d+$/, '');
}

function profileRank(name: string): [number, number, string] {
  if (name === 'Default') return [0, 0, name];
  const m = /^Profile (\d+)$/.exec(name);
  if (m) return [1, Number(m[1]), name];
  return [2, 0, name];
}

function compareProfiles(a: string, b: string): number {
  const ra = profileRank(a);
  const rb = profileRank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
}

/** Looks for the pinned assets below `dir`. Matches by size first, then md5. */
export async function scanForAssets(
  dir: string,
  pin: LtsmVersionPin,
  options: Pick<DiscoveryOptions, 'fs' | 'path' | 'maxDepth' | 'maxEntries'> = {},
): Promise<{ readonly verified: readonly LtsmVerifiedAsset[]; readonly mismatchedFiles: readonly string[] }> {
  const fs = options.fs ?? nodeLtsmFs;
  const path = options.path ?? nodePath;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let budget = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const wanted = new Map<LtsmAssetName, LtsmAssetPin>(pin.assets.map((a) => [a.fileName, a]));
  const found = new Map<LtsmAssetName, LtsmVerifiedAsset>();
  const mismatched: string[] = [];
  const result = (): { verified: LtsmVerifiedAsset[]; mismatchedFiles: string[] } => ({
    verified: pin.assets.flatMap((a) => {
      const hit = found.get(a.fileName);
      return hit ? [hit] : [];
    }),
    mismatchedFiles: mismatched,
  });

  let level: Array<{ dir: string; rel: string }> = [{ dir, rel: '' }];
  for (let depth = 0; depth <= maxDepth && level.length > 0 && found.size < wanted.size; depth += 1) {
    const next: Array<{ dir: string; rel: string }> = [];
    for (const current of level) {
      let entries;
      try {
        entries = await fs.readdir(current.dir);
      } catch {
        continue;
      }
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        budget -= 1;
        if (budget < 0) return result();
        const full = path.join(current.dir, entry.name);
        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!NOISE_DIRS.has(entry.name.toLowerCase())) next.push({ dir: full, rel });
          continue;
        }
        if (!entry.isFile()) continue;
        let size: number;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }
        for (const asset of wanted.values()) {
          if (asset.size !== size || found.has(asset.fileName)) continue;
          let md5: string;
          try {
            md5 = md5Hex(await fs.readFile(full));
          } catch {
            continue;
          }
          if (md5 === asset.md5) {
            found.set(asset.fileName, { fileName: asset.fileName, sourcePath: full, relativePath: rel, size, md5 });
            break;
          }
          mismatched.push(rel);
        }
      }
    }
    level = next;
  }
  return result();
}

async function inspectFolder(
  dir: string,
  pin: LtsmVersionPin,
  context: { browser: LtsmBrowser; profile: string; folderVersion: string },
  options: DiscoveryOptions,
): Promise<{ match?: LtsmDiscoveryMatch; detected: LtsmDetectedInstall }> {
  const scan = await scanForAssets(dir, pin, options);
  const detected: LtsmDetectedInstall = {
    browser: context.browser,
    profile: context.profile,
    extensionVersion: context.folderVersion,
    extensionDir: dir,
    reason: scan.mismatchedFiles.length > 0 ? 'md5-mismatch' : 'assets-missing',
    ...(scan.mismatchedFiles.length > 0 ? { mismatchedFiles: scan.mismatchedFiles } : {}),
  };
  if (scan.verified.length === pin.assets.length) {
    return {
      match: {
        browser: context.browser,
        profile: context.profile,
        extensionVersion: pin.version,
        extensionDir: dir,
        assets: scan.verified,
      },
      detected,
    };
  }
  return { detected };
}

/** Searches every Chrome and Edge profile for the installed extension. */
export async function discoverLtsmAssets(options: DiscoveryOptions = {}): Promise<LtsmDiscoveryResult> {
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeLtsmFs;
  const path = options.path ?? nodePath;
  const pin = options.pin ?? requiredLtsmPin();
  const searched: string[] = [];
  const detected: LtsmDetectedInstall[] = [];

  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return { kind: 'not-found', required: pin.version, searched };

  for (const root of BROWSER_ROOTS) {
    const userData = path.join(localAppData, ...root.segments);
    let profiles: string[];
    try {
      profiles = (await fs.readdir(userData)).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    profiles.sort(compareProfiles);
    for (const profile of profiles) {
      const extRoot = path.join(userData, profile, 'Extensions', CHROME_EXTENSION_ID);
      let versions: string[];
      try {
        versions = (await fs.readdir(extRoot)).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        continue;
      }
      searched.push(extRoot);
      // Newest-looking first so a current install wins over a stale leftover folder.
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const folder of versions) {
        const folderVersion = versionFromFolderName(folder);
        const dir = path.join(extRoot, folder);
        if (folderVersion !== pin.version) {
          detected.push({ browser: root.browser, profile, extensionVersion: folderVersion, extensionDir: dir, reason: 'version-mismatch' });
          continue;
        }
        const inspected = await inspectFolder(dir, pin, { browser: root.browser, profile, folderVersion }, options);
        if (inspected.match) return { kind: 'found', match: inspected.match };
        detected.push(inspected.detected);
      }
    }
  }

  if (detected.length > 0) return { kind: 'wrong-version', required: pin.version, detected };
  return { kind: 'not-found', required: pin.version, searched };
}

/**
 * Checks a folder the user picked by hand. The folder may be a version folder or any parent of the assets; it must pass
 * exactly the same size and md5 check as an automatic find.
 */
export async function verifyManualFolder(folder: string, options: DiscoveryOptions = {}): Promise<LtsmDiscoveryResult> {
  const fs = options.fs ?? nodeLtsmFs;
  const path = options.path ?? nodePath;
  const pin = options.pin ?? requiredLtsmPin();

  const inspected = await inspectFolder(folder, pin, { browser: 'manual', profile: '', folderVersion: 'unknown' }, options);
  if (inspected.match) return { kind: 'found', match: inspected.match };

  let version = versionFromFolderName(path.basename(folder));
  try {
    const manifest = JSON.parse(Buffer.from(await fs.readFile(path.join(folder, 'manifest.json'))).toString('utf8')) as {
      version?: unknown;
    };
    if (typeof manifest.version === 'string') version = manifest.version;
  } catch {
    // no readable manifest: keep the folder-name guess
  }
  const known = /^\d+(\.\d+)*$/.test(version) ? version : 'unknown';
  const reason: LtsmMismatchReason =
    inspected.detected.reason === 'assets-missing' && known !== 'unknown' && known !== pin.version
      ? 'version-mismatch'
      : inspected.detected.reason;
  return {
    kind: 'wrong-version',
    required: pin.version,
    detected: [{ ...inspected.detected, extensionVersion: known, reason }],
  };
}
