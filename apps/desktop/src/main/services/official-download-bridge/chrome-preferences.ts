// Chrome `Preferences` file of the bridge profile. Written before each Chrome launch.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';

/**
 * Returns the new text of the Preferences file, or null when the existing text is not a JSON object.
 * Input null means that the file does not exist.
 * It adds the extension to `message_center.disabled_extension_ids` (no Windows notification of the extension).
 * It sets `session.restore_on_startup` to 1 (Chrome keeps session cookies at exit). Other keys stay as they are.
 */
export function applyBridgePreferences(existing: string | null): string | null {
  let root: Record<string, unknown> = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    root = parsed as Record<string, unknown>;
  }
  const child = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
    const value = parent[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  };
  const messageCenter = child(root, 'message_center');
  const ids = Array.isArray(messageCenter.disabled_extension_ids) ? (messageCenter.disabled_extension_ids as unknown[]) : [];
  messageCenter.disabled_extension_ids = ids.includes(CHROME_EXTENSION_ID) ? ids : [...ids, CHROME_EXTENSION_ID];
  child(root, 'session').restore_on_startup = 1;
  return JSON.stringify(root);
}

/** Reads, changes and writes `<profileDir>/Default/Preferences`. An invalid existing file stays as it is and the error goes to `onError`. */
export async function writeBridgePreferences(profileDir: string, onError?: (error: unknown) => void): Promise<void> {
  try {
    const dir = nodePath.join(profileDir, 'Default');
    const file = nodePath.join(dir, 'Preferences');
    let existing: string | null = null;
    try {
      existing = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
    const next = applyBridgePreferences(existing);
    if (next === null) {
      onError?.(new Error('Bridge Chrome Preferences file is not valid JSON and was not changed'));
      return;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(file, next, 'utf8');
  } catch (error) {
    onError?.(error);
  }
}
