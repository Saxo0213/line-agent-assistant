import type { AgentProvider } from '@line-agent/contracts';
import {readFile, realpath, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path';
import {buildChildEnvironment} from './child-environment.js';
import {captureProcess, type ProcessRunner} from './process-runner.js';

export interface ResolvedExecutable {
  file: string;
  prefixArgs: string[];
  version: string;
  kind: 'native' | 'node';
}
export interface ExecutableResolver { resolve(provider: AgentProvider): Promise<ResolvedExecutable | null> }

export interface ResolverOptions {
  runner: ProcessRunner;
  environment?: NodeJS.ProcessEnv;
  searchPath?: string;
  /** Additional install roots are selected by Main, never by chat or workspace data. */
  trustedRoots?: string[];
  knownInstallations?: Partial<Record<AgentProvider, string[]>>;
  nodeCandidates?: string[];
}
export function isWithin(root: string, target: string): boolean {
  const rest=relative(root,target);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

export class WindowsExecutableResolver implements ExecutableResolver {
  constructor(private readonly options: ResolverOptions) {}

  async resolve(provider: AgentProvider): Promise<ResolvedExecutable | null> {
    const {env}=buildChildEnvironment(this.options.environment ?? process.env);
    const defaults = [
      env.APPDATA && join(env.APPDATA,'npm'),
      env.USERPROFILE && join(env.USERPROFILE,'.local','bin'),
      env.USERPROFILE && join(env.USERPROFILE,'.local','share','claude'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA,'Microsoft','WinGet'),
      env.PROGRAMFILES && join(env.PROGRAMFILES,'nodejs'),
    ].filter((p):p is string=>Boolean(p));
    const trustedRoots=(await Promise.all((this.options.trustedRoots ?? defaults).map(p=>realpath(p).catch(()=>null)))).filter((p):p is string=>p!==null);
    async function trusted(file:string) {
      if(!isAbsolute(file)) return null;
      try {
        const canonical=await realpath(file);
        return trustedRoots.some(root=>isWithin(root,canonical)) && (await stat(canonical)).isFile() ? canonical : null;
      } catch {return null;}
    }
    const directories=(this.options.searchPath ?? env.PATH ?? '').split(';').filter(isAbsolute);
    const nativeCandidates=[...(this.options.knownInstallations?.[provider] ?? []),...directories.map(d=>join(d,`${provider}.exe`))];
    if(provider === 'codex') {
      for(const directory of directories) {
        nativeCandidates.push(join(directory,'node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'));
        nativeCandidates.push(join(directory,'node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','bin','codex.exe'));
      }
    }
    for(const candidate of nativeCandidates) {
      if(basename(candidate).toLowerCase()!==`${provider}.exe`) continue;
      const file=await trusted(candidate);
      if(!file || !await isPortableExecutable(file)) continue;
      const version=await this.version(file,[],provider,env);
      if(version) return {file,prefixArgs:[],version,kind:'native'};
    }
    const packageName=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
    const entryRelative=provider==='codex'?'bin/codex.js':'cli.js';
    for(const directory of directories) {
      const shim=await trusted(join(directory,`${provider}.cmd`));
      if(!shim) continue;
      try {
        const shimText=(await readFile(shim,'utf8')).replace(/\r\n/g,'\n').trim();
        if(shimText!==npmShim(packageName,entryRelative)) continue;
        const packageRoot=await realpath(join(dirname(shim),'node_modules',...packageName.split('/')));
        const entry=await trusted(join(packageRoot,...entryRelative.split('/')));
        if(!entry || !isWithin(packageRoot,entry)) continue;
        const manifest:unknown=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
        if(!manifest || typeof manifest!=='object' || !('name' in manifest) || manifest.name!==packageName || !('bin' in manifest)) continue;
        const bin=manifest.bin;
        if(!bin || typeof bin!=='object' || !(provider in bin) || (bin as Record<string,unknown>)[provider]!==entryRelative) continue;
        // Never use process.execPath: in Electron that is the desktop executable.
        const nodeCandidates=this.options.nodeCandidates ?? directories.map(d=>join(d,'node.exe'));
        for(const candidate of nodeCandidates) {
          if(basename(candidate).toLowerCase()!=='node.exe') continue;
          const node=await trusted(candidate);
          if(!node || !await isPortableExecutable(node)) continue;
          const check=await captureProcess(this.options.runner,{file:node,args:['--version'],env});
          if(check.code!==0 || !/^v24\.\d+\.\d+\s*$/.test(check.stdout)) continue;
          const version=await this.version(node,[entry],provider,env);
          if(version) return {file:node,prefixArgs:[entry],version,kind:'node'};
        }
      } catch { /* A broken install is optional, not a host failure. */ }
    }
    return null;
  }

  private async version(file:string,prefixArgs:string[],provider:AgentProvider,env:NodeJS.ProcessEnv) {
    try {
      const result=await captureProcess(this.options.runner,{file,args:[...prefixArgs,'--version'],env});
      if(result.code!==0) return null;
      const match=result.stdout.trim().match(provider==='codex'?/^codex-cli (\d+\.\d+\.\d+)$/:/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
      return match?.[1] ?? null;
    } catch {return null;}
  }
}

async function isPortableExecutable(file:string) {
  // Check the header only; never load credentials or arbitrary companion files.
  const {open}=await import('node:fs/promises');
  const handle=await open(file,'r');
  try { const bytes=Buffer.alloc(2); await handle.read(bytes,0,2,0); return bytes.toString('ascii')==='MZ'; }
  finally {await handle.close();}
}

function npmShim(packageName:string,entry:string) {
  const target=`node_modules\\${packageName.replaceAll('/','\\')}\\${entry.replaceAll('/','\\')}`;
  return `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`;
}

export type Compatibility='supported'|'unverified'|'incompatible';
export function protocolCompatibility(provider:AgentProvider,version:string):Compatibility {
  const fixture=provider==='codex'?'0.144.5':'2.1.295';
  if(version===fixture) return 'supported';
  if(!/^\d+\.\d+\.\d+$/.test(version)) return 'incompatible';
  const numbers=version.split('.').map(Number), minimum=fixture.split('.').map(Number);
  if(numbers[0]!==minimum[0]) return 'incompatible';
  for(let i=1;i<3;i++) {
    if(numbers[i]!<minimum[i]!) return 'incompatible';
    if(numbers[i]!>minimum[i]!) return 'unverified';
  }
  return 'incompatible';
}
