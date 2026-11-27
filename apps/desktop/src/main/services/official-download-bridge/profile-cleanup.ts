// Deletes the login data of the download profile. A store-installed extension stays installed.

import { readdir, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;
/** Files of `Default` that keep the install record of the extension. They hold no login data (cookies and extension storage are in other places). */
const KEPT_DEFAULT_FILES: ReadonlySet<string> = new Set(['Preferences', 'Secure Preferences']);

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Without a store install in the profile the whole folder goes.
 * With a store install these stay: `Default/Extensions/<id>`, `Default/Preferences` and `Default/Secure Preferences`.
 * Everything else goes: cookies, local storage, IndexedDB and `Local Extension Settings` (the LINE login of the extension).
 */
export async function removeProfileData(profileDir: string): Promise<void> {
  const extensionsDir = nodePath.join(profileDir, 'Default', 'Extensions');
  if (!(await names(nodePath.join(extensionsDir, CHROME_EXTENSION_ID))).length) {
    await rm(profileDir, RM_OPTIONS);
    return;
  }
  for (const name of await names(profileDir)) {
    if (name !== 'Default') await rm(nodePath.join(profileDir, name), RM_OPTIONS);
  }
  const defaultDir = nodePath.join(profileDir, 'Default');
  for (const name of await names(defaultDir)) {
    if (name === 'Extensions') {
      for (const entry of await names(extensionsDir)) {
        if (entry !== CHROME_EXTENSION_ID) await rm(nodePath.join(extensionsDir, entry), RM_OPTIONS);
      }
    } else if (!KEPT_DEFAULT_FILES.has(name)) {
      await rm(nodePath.join(defaultDir, name), RM_OPTIONS);
    }
  }
}
