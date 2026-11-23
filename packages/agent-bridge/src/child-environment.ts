import {homedir} from 'node:os';
import { win32 } from 'node:path';
import type {AgentProvider} from '@line-agent/contracts';
import {accountDirectory} from './account-directory.js';
const ALLOWED = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME',
  'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMDATA', 'COMMONPROGRAMFILES', 'OS', 'PROCESSOR_ARCHITECTURE',
]);
const OVERRIDE = /^(?:OPENAI|ANTHROPIC|CODEX|CLAUDE|AZURE_OPENAI|AWS|GOOGLE|GEMINI|VERTEX|BEDROCK)(?:_|$)/i;

export function buildChildEnvironment(source: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {};
  const isolatedOverrideNames: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED.has(name.toUpperCase())) env[name.toUpperCase()] = value;
    else if (OVERRIDE.test(name)) isolatedOverrideNames.push(name);
  }
  return {env, isolatedOverrideNames: isolatedOverrideNames.sort()};
}

/** Names the child environment already owns (system variables and provider credentials/overrides); extension env may not reuse them. */
export function isReservedEnvironmentName(name:string):boolean {
  return ALLOWED.has(name.toUpperCase()) || OVERRIDE.test(name) || /^LINEJS_/i.test(name) || /^MCP_/i.test(name);
}

/** Child-environment variable that tells Claude Code where Git Bash is. */
export const CLAUDE_GIT_BASH_PATH_ENV='CLAUDE_CODE_GIT_BASH_PATH';

/**
 * Path of Git Bash for the Claude child. Port of CliTalkAgent `git_bash_env` (session_spawn.rs).
 * A parent value is used only when it is an absolute path to an existing file named bash.exe.
 * Otherwise the first existing file of the CliTalkAgent candidate list is used. It returns undefined when none exists.
 */
export function gitBashPath(source: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string | undefined {
  const read = (name: string) => Object.entries(source).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  const parent = read(CLAUDE_GIT_BASH_PATH_ENV);
  if (parent && win32.isAbsolute(parent) && win32.basename(parent).toLowerCase() === 'bash.exe' && isFile(parent)) return parent;
  const candidates: string[] = [];
  for (const name of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const dir = read(name);
    if (dir) candidates.push(win32.join(dir, 'Git', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  return candidates.find(path => isFile(path));
}

/** The only variables an account source may set. */
export type AccountEnv=Partial<Record<'CODEX_HOME'|'CLAUDE_CONFIG_DIR',string>>;
export interface AccountRef {id:string;kind:'system'|'managed'}

/**
 * Environment of an account source (CliTalkAgent llm_sources.rs:266-342, default_codex_home).
 * System Claude: none (the CLI default home). System Codex: the parent CODEX_HOME when it is set and not empty, else `<home>/.codex`.
 * Managed: CLAUDE_CONFIG_DIR or CODEX_HOME is the account directory. The Claude host credential variables are never passed:
 * the child whitelist removes each `CLAUDE_*` and `ANTHROPIC_*` name, so only this value reaches the child.
 */
export function accountEnvironment(provider:AgentProvider,account:AccountRef|undefined,accountsDirectory:string|undefined,parentEnv:NodeJS.ProcessEnv):AccountEnv {
  if(account===undefined || account.kind==='system') {
    if(provider==='claude') return {};
    const read=(name:string)=>Object.entries(parentEnv).find(([key])=>key.toUpperCase()===name)?.[1];
    const parent=read('CODEX_HOME');
    if(parent) return {CODEX_HOME:parent};
    return {CODEX_HOME:win32.join(read('USERPROFILE') || read('HOME') || homedir(),'.codex')};
  }
  if(!accountsDirectory) throw new Error('The accounts directory is not set');
  const directory=accountDirectory(accountsDirectory,account.id);
  return provider==='claude'?{CLAUDE_CONFIG_DIR:directory}:{CODEX_HOME:directory};
}
