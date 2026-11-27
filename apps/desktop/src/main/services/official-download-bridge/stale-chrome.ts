// Closes a left-over bridge Chrome of this app before a new start.
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
 * True only for a bridge Chrome of this profile: the command line has `--remote-debugging-pipe`
 * and `--user-data-dir=` with this profile folder (plain or quoted, any slash form, any case).
 */
export function isBridgeChromeOfProfile(commandLine: string, profileDir: string): boolean {
  if (!/(^|\s)"?--remote-debugging-pipe(\s|"|$)/.test(commandLine)) return false;
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
 * Kills each left-over bridge Chrome process tree of this profile. Windows only.
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
  const stale = processes.filter((info) => isBridgeChromeOfProfile(info.commandLine, profileDir));
  for (const info of stale) await killTree(info.pid);
  if (stale.length > 0) onError?.(new Error(`closed ${stale.length} left-over bridge Chrome process tree(s) before start`));
  return stale.length;
}
