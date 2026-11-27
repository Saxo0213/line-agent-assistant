// Builds PATH from the Windows registry. A running app keeps the PATH it started with.
// A tool that the user installs later (Node.js, Claude CLI, Codex CLI) is on the registry PATH only.
// The registry is read only. No script file runs and no execution policy changes.

import { execFile } from 'node:child_process';

export const MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const USER_ENVIRONMENT_KEY = 'HKCU\\Environment';

type RunReg = (key: string) => Promise<string | null>;

/** Value of the Path entry in `reg query <key> /v Path` output, or null. */
export function parseRegistryPath(stdout: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(stdout);
  return match?.[1] ? match[1] : null;
}

/** Replaces %NAME% with the value from env. The name match ignores case. An unknown name stays as it is. */
export function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (slot, name: string) => {
    const found = Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
    return found ?? slot;
  });
}

function reg(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : parseRegistryPath(stdout));
    });
  });
}

/** Machine PATH, then user PATH, without empty or repeated entries. Returns null when the registry has no PATH. */
export async function buildFreshPath(env: NodeJS.ProcessEnv = process.env, runReg: RunReg = reg): Promise<string | null> {
  const [machine, user] = await Promise.all([runReg(MACHINE_ENVIRONMENT_KEY), runReg(USER_ENVIRONMENT_KEY)]);
  if (machine === null && user === null) return null;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of [machine, user]) {
    if (raw === null) continue;
    for (const part of expandEnvironmentVariables(raw, env).split(';')) {
      const entry = part.trim();
      const key = entry.toLowerCase();
      if (entry === '' || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(';');
}

/** Registry entries first, then each entry of the current PATH that is not in the list yet. The compare ignores case. */
export function mergePath(registryPath: string, currentPath: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const part of [...registryPath.split(';'), ...currentPath.split(';')]) {
    const entry = part.trim();
    const key = entry.toLowerCase();
    if (entry === '' || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(';');
}

/**
 * Updates PATH of this process from the registry. Every later child process (the Agent CLI resolver,
 * the provider status check, the environment check) then finds a tool that was installed after the app started.
 * The merge keeps an entry that exists only in the process environment.
 * When the registry cannot be read, PATH stays as it is.
 */
export async function refreshProcessPath(env: NodeJS.ProcessEnv = process.env, runReg: RunReg = reg): Promise<string | null> {
  const fresh = await buildFreshPath(env, runReg);
  if (fresh !== null && fresh !== '') env.PATH = mergePath(fresh, env.PATH ?? '');
  return fresh;
}
