// Finds the installed chrome.exe. The registry is read only.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import nodePath from 'node:path';
import { BridgeError } from './errors.js';

const APP_PATHS_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function readAppPathsDefault(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('reg', ['query', APP_PATHS_KEY, '/ve'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const match = /REG_SZ\s+(.+?)\s*$/m.exec(stdout);
      // The registry value can have quotes around the path.
      resolve(match?.[1]?.trim().replace(/^"+|"+$/g, ''));
    });
  });
}

export interface LocateChromeOptions {
  readonly env?: { readonly LOCALAPPDATA?: string | undefined };
}

/** Returns the absolute path of chrome.exe. Throws CHROME_NOT_FOUND. */
export async function locateChrome(options: LocateChromeOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const tail = ['Google', 'Chrome', 'Application', 'chrome.exe'];
  const candidates = [
    nodePath.win32.join('C:\\Program Files', ...tail),
    nodePath.win32.join('C:\\Program Files (x86)', ...tail),
    ...(env.LOCALAPPDATA ? [nodePath.win32.join(env.LOCALAPPDATA, ...tail)] : []),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  const registered = await readAppPathsDefault();
  if (registered && (await exists(registered))) return registered;
  throw new BridgeError('CHROME_NOT_FOUND', 'chrome.exe was not found');
}
