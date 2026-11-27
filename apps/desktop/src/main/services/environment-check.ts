// Environment check: finds the tools that the app needs, and starts a fixed install action for a missing tool.
// The renderer sends only an install id. This module maps the id to a fixed action. Command text and URLs never come from the renderer.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import nodePath from 'node:path';
import { CHROME_EXTENSION_STORE_URL } from '@line-agent/contracts';
import { isSupportedNodeVersion } from '@line-agent/agent-bridge';
import type { EnvironmentCheckResult, EnvironmentItemId, EnvironmentItemStatus } from '../../environment-check-protocol.js';
import { refreshProcessPath } from './fresh-path.js';

type Item = EnvironmentCheckResult['items'][number];
type Probe = { status: EnvironmentItemStatus; version?: string | null };

export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
export const LINE_DESKTOP_DOWNLOAD_URL = 'https://line.me/download';
export const NODEJS_DOWNLOAD_URL = 'https://nodejs.org/';

/** PowerShell snippet. It sets $env:Path from the registry (machine, then user). It only reads the registry. */
const FRESH_PATH_SCRIPT = "$m=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name Path).Path; "
  + "$u=(Get-ItemProperty 'HKCU:\\Environment' -Name Path -ErrorAction SilentlyContinue).Path; "
  + "$env:Path=[Environment]::ExpandEnvironmentVariables($m + ';' + $u)";

/** The fixed scripts. Each one prints one zh-TW line first. The text has no double quote, so the argument needs no escape. */
export const INSTALL_SCRIPTS = {
  nodejs: "Write-Host '正在安裝 Node.js LTS（winget），完成後請關閉此視窗。'; winget install --id OpenJS.NodeJS.LTS -e",
  claude: "Write-Host '正在安裝 Claude CLI，完成後請關閉此視窗。'; irm https://claude.ai/install.ps1 | iex",
  codex: `Write-Host '正在安裝 Codex CLI（npm.cmd install -g @openai/codex），完成後請關閉此視窗。'; ${FRESH_PATH_SCRIPT}; npm.cmd install -g @openai/codex`,
} as const;

export interface EnvironmentCheckDeps {
  /** Environment for child processes. PATH is read at each call, after the fresh PATH was set. */
  env?: NodeJS.ProcessEnv;
  refreshPath?: () => Promise<unknown>;
  chrome(): Promise<Probe>;
  lineExtension(): Promise<Probe>;
  lineDesktop(): Promise<Probe>;
  /** Runs `<file> <args>` with the env of this service. Resolves the first output line, or null when the file is not found. Rejects for other errors. */
  runVersion?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;
  providerStatus(provider: 'claude' | 'codex'): Promise<{ status: 'authenticated' | 'logged_out' | 'not_installed' | 'error' }>;
  openExternal(url: string): Promise<void>;
  /** Starts a visible PowerShell window. */
  spawnVisible?: (script: string) => ChildProcess;
  /** Called when a visible install window closes. */
  onChange(): void;
}

function runVersion(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve(null);
        else reject(error);
        return;
      }
      resolve(stdout.trim().split(/\r?\n/)[0] ?? '');
    });
  });
}

/** powershell.exe with a new visible console. A parent without a console gives the child its own window. A detached child would have none. */
export function spawnVisiblePowerShell(script: string): ChildProcess {
  return spawn('powershell.exe', ['-NoProfile', '-NoExit', '-Command', script], { stdio: 'ignore', windowsHide: false });
}

export class EnvironmentCheckService {
  private readonly running = new Map<EnvironmentItemId, ChildProcess>();
  constructor(private readonly deps: EnvironmentCheckDeps) {}

  async check(): Promise<EnvironmentCheckResult> {
    await (this.deps.refreshPath ?? refreshProcessPath)().catch(() => undefined);
    const guarded = async (probe: () => Promise<Probe>): Promise<Probe> => { try { return await probe(); } catch { return { status: 'unknown' }; } };
    const [chrome, lineExtension, lineDesktop, nodejs, claude, codex] = await Promise.all([
      guarded(() => this.deps.chrome()), guarded(() => this.deps.lineExtension()), guarded(() => this.deps.lineDesktop()),
      guarded(() => this.nodeProbe()), guarded(() => this.providerProbe('claude')), guarded(() => this.providerProbe('codex')),
    ]);
    const item = (id: EnvironmentItemId, probe: Probe): Item => ({ id, status: probe.status, version: probe.version?.slice(0, 64) || null });
    return { items: [item('chrome', chrome), item('lineExtension', lineExtension), item('lineDesktop', lineDesktop),
      item('nodejs', nodejs), item('claude', claude), item('codex', codex)] };
  }

  /** Starts the fixed action of the id. Returns false when an install window of the same id is still open. */
  async install(id: EnvironmentItemId): Promise<boolean> {
    if (id === 'chrome') { await this.deps.openExternal(CHROME_DOWNLOAD_URL); return true; }
    if (id === 'lineDesktop') { await this.deps.openExternal(LINE_DESKTOP_DOWNLOAD_URL); return true; }
    // The same fixed Web Store page that the openChromeExtensionStore action opens.
    if (id === 'lineExtension') { await this.deps.openExternal(CHROME_EXTENSION_STORE_URL); return true; }
    if (this.running.has(id)) return false;
    if (id === 'nodejs' && !await this.wingetAvailable()) { await this.deps.openExternal(NODEJS_DOWNLOAD_URL); return true; }
    const script = INSTALL_SCRIPTS[id];
    const child = (this.deps.spawnVisible ?? spawnVisiblePowerShell)(script);
    this.running.set(id, child);
    let done = false;
    const finish = () => { if (done) return; done = true; this.running.delete(id); this.deps.onChange(); };
    child.once('exit', finish);
    child.once('error', finish);
    return true;
  }

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }

  private async wingetAvailable(): Promise<boolean> {
    await (this.deps.refreshPath ?? refreshProcessPath)().catch(() => undefined);
    try { return (await (this.deps.runVersion ?? runVersion)('winget.exe', ['--version'], this.env)) !== null; } catch { return false; }
  }

  private async nodeProbe(): Promise<Probe> {
    const line = await (this.deps.runVersion ?? runVersion)('node.exe', ['--version'], this.env);
    if (line === null) return { status: 'missing' };
    if (!/^v\d+\.\d+\.\d+\s*$/.test(line)) return { status: 'unknown' };
    // The CLI resolver accepts Node.js major version 24 or higher. An older Node.js counts as missing.
    return { status: isSupportedNodeVersion(line) ? 'ok' : 'missing', version: line };
  }

  private async providerProbe(provider: 'claude' | 'codex'): Promise<Probe> {
    const { status } = await this.deps.providerStatus(provider);
    if (status === 'not_installed') return { status: 'missing' };
    return { status: status === 'error' ? 'unknown' : 'ok' };
  }
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/**
 * Desktop LINE for the external monitor. The native reader reads `%LOCALAPPDATA%\LINE\bin\current\LINE.exe`.
 * The repository has no TypeScript detection of the install, so this checks that same path and the launcher beside it. Read only.
 */
export async function probeDesktopLine(env: { LOCALAPPDATA?: string | undefined } = process.env): Promise<Probe> {
  if (!env.LOCALAPPDATA) return { status: 'unknown' };
  const root = nodePath.win32.join(env.LOCALAPPDATA, 'LINE', 'bin');
  const candidates = [nodePath.win32.join(root, 'current', 'LINE.exe'), nodePath.win32.join(root, 'LineLauncher.exe')];
  for (const candidate of candidates) if (await exists(candidate)) return { status: 'ok' };
  return { status: 'missing' };
}
