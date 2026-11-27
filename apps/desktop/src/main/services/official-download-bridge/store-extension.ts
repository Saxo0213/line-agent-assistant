// Finds the LINE Chrome extension that Chrome installed from the Web Store into the download profile.
// Folder: `<profileDir>/Default/Extensions/<id>/<version>_<n>/`. This module only reads. It writes no Chrome file.

import { readdir, readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';
import { checkExtensionFolderFeatures } from './extension-features.js';

export interface StoreExtensionInfo {
  /** Absolute path of the highest version folder. */
  readonly dir: string;
  /** Version text of the folder name, for example `3.7.2`. */
  readonly version: string;
  /** `extensions.settings[id].location` of Preferences (Chrome number: 1 = internal, 4 = unpacked, 5 = external). Absent when unknown. */
  readonly location?: number;
  /** `extensions.settings[id].state` of Preferences (1 = enabled, 0 = disabled). Absent when unknown. */
  readonly state?: number;
}

export type StoreExtensionDetection =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'ready' } & StoreExtensionInfo)
  | ({ readonly kind: 'changed'; readonly failed: readonly string[] } & StoreExtensionInfo);

/** Parses `3.7.2_0` into numbers. Returns null for a name that is not `<digits and dots>_<digits>`. */
export function parseVersionFolder(name: string): { version: string; parts: number[]; build: number } | null {
  const match = /^(\d+(?:\.\d+){0,3})_(\d+)$/.exec(name);
  if (!match) return null;
  return { version: match[1] as string, parts: (match[1] as string).split('.').map(Number), build: Number(match[2]) };
}

function compareVersionFolders(a: { parts: number[]; build: number }, b: { parts: number[]; build: number }): number {
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.build - b.build;
}

/** Chrome keeps the install record in `Preferences` or (on Windows, with a MAC) in `Secure Preferences`. Both files are only read. */
async function readPreferenceEntry(profileDir: string): Promise<{ location?: number; state?: number }> {
  for (const file of ['Preferences', 'Secure Preferences']) {
    try {
      const parsed = JSON.parse(await readFile(nodePath.join(profileDir, 'Default', file), 'utf8')) as {
        extensions?: { settings?: Record<string, { location?: unknown; state?: unknown } | undefined> };
      };
      const entry = parsed.extensions?.settings?.[CHROME_EXTENSION_ID];
      if (!entry || typeof entry !== 'object') continue;
      return {
        ...(typeof entry.location === 'number' ? { location: entry.location } : {}),
        ...(typeof entry.state === 'number' ? { state: entry.state } : {}),
      };
    } catch {
      // A missing or invalid file: try the next one.
    }
  }
  return {};
}

/**
 * Detects a store install in the profile. The highest version folder is used.
 * `ready`: every feature signature of the extension code is found (any version is accepted).
 * `changed`: one or more signatures are missing; `failed` has their names.
 */
export async function detectStoreExtension(profileDir: string): Promise<StoreExtensionDetection> {
  const extensionsDir = nodePath.join(profileDir, 'Default', 'Extensions', CHROME_EXTENSION_ID);
  let names: string[];
  try {
    names = await readdir(extensionsDir);
  } catch {
    return { kind: 'none' };
  }
  const folders = names.map((name) => ({ name, parsed: parseVersionFolder(name) }))
    .filter((item): item is { name: string; parsed: NonNullable<typeof item.parsed> } => item.parsed !== null)
    .sort((a, b) => compareVersionFolders(b.parsed, a.parsed));
  const best = folders[0];
  if (!best) return { kind: 'none' };
  const info: StoreExtensionInfo = { dir: nodePath.join(extensionsDir, best.name), version: best.parsed.version, ...(await readPreferenceEntry(profileDir)) };
  const check = await checkExtensionFolderFeatures(info.dir);
  return check.ok ? { kind: 'ready', ...info } : { kind: 'changed', failed: check.failed, ...info };
}
