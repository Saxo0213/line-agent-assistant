// Closes a left-over Chrome of the bridge profile of this app (bridge or store install) before a new start.
// A second Chrome with the same profile folder hands over to the first one and ends at once.

import { execFile } from 'node:child_process';
import { killTree } from './cdp-pipe.js';

const LIST_TIMEOUT_MS = 10_000;
const LIST_COMMAND = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;

export interface ChromeProcessInfo {
  readonly pid: number;
  readonly commandLine: string;
}

function normalizePath(value: string): string {
  return value.replace(/["']/g, '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * True only for a Chrome of the bridge profile: the command line has `--user-data-dir=` with this profile folder
 * (plain or quoted, any slash form, any case). The folder is only for this app, so every such Chrome belongs to this app
 * (the bridge Chrome and the visible Chrome of the store install). A Chrome of any other profile never matches.
 */
export function isChromeOfBridgeProfile(commandLine: string, profileDir: string): boolean {
  const profile = normalizePath(profileDir);
  if (!profile) return false;
  const pattern = /(?:^|\s)"?--user-data-dir=(?:"([^"]*)"|(\S*))/g;
  for (const match of commandLine.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? '';
    if (normalizePath(value) === profile) return true;
  }
  return false;
}

/** Parses the JSON of the process listing. PowerShell gives one object or an array. */
export function parseChromeProcessList(json: string): ChromeProcessInfo[] {
  const text = json.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const pid = record['ProcessId'];
    const commandLine = record['CommandLine'];
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof commandLine === 'string' ? [{ pid, commandLine }] : [];
  });
}

function listChromeProcesses(): Promise<ChromeProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', LIST_COMMAND], { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseChromeProcessList(String(stdout)));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/**
 * Kills each left-over Chrome process tree of the bridge profile. Windows only.
 * No other Chrome process is touched. A failed listing is reported and does not stop the start.
 * Returns the number of killed trees. `onError` also gets a count-only note for kills (no path, no command line).
 */
export async function closeStaleBridgeChrome(profileDir: string, onError?: (error: unknown) => void): Promise<number> {
  if (process.platform !== 'win32') return 0;
  let processes: ChromeProcessInfo[];
  try {
    processes = await listChromeProcesses();
  } catch (error) {
    onError?.(error);
    return 0;
  }
  const stale = processes.filter((info) => isChromeOfBridgeProfile(info.commandLine, profileDir));
  for (const info of stale) await killTree(info.pid);
  if (stale.length > 0) onError?.(new Error(`closed ${stale.length} left-over bridge-profile Chrome process tree(s)`));
  return stale.length;
}
