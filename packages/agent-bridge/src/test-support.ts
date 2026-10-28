import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, readFile, realpath, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AgentRunRequest} from '@line-agent/contracts';

export const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const hostFile = fileURLToPath(new URL('../dist/native/JobHost.exe', import.meta.url));
export const csc = join(process.env.SystemRoot ?? 'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
export async function temporaryDirectory() { return realpath(await mkdtemp(join(tmpdir(),'line bridge fixture '))); }
export async function cleanup(directory:string) { await rm(directory,{recursive:true,force:true}); }
export async function installFixture(directory:string, kind:'native'|'shim') {
  await mkdir(directory,{recursive:true});
  if (kind === 'native') {
    const file=join(directory,'codex.exe');
    execFileSync(csc,['/nologo','/target:exe','/platform:x64',`/out:${file}`,join(fixtures,'VersionCli.cs')],{windowsHide:true});
    return file;
  }
  const file=join(directory,'codex.cmd');
  await copyFile(join(fixtures,'npm-shim.cmd'),file);
  const packageRoot=join(directory,'node_modules','@openai','codex');
  const entry=join(packageRoot,'bin','codex.js');
  await mkdir(dirname(entry),{recursive:true});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.144.5',bin:{codex:'bin/codex.js'}}));
  await writeFile(entry,"if(process.argv[2]==='--version')console.log('codex-cli 0.144.5'); else process.exitCode=3;");
  return file;
}
export const request = (provider:'codex'|'claude', workspacePath:string, extra:Partial<AgentRunRequest>={}):AgentRunRequest => ({
  jobId:'job-1',provider,prompt:'Hello',workspacePath,tools:{localTools:true,fileRead:true,fileWrite:true,linkedReadDirs:[],projectDirs:[],workspaceRootDir:null,level:'workspace_write',webTools:false,interactiveApproval:false},source:{type:'ui',requestId:'req-1'},...extra,
});
export async function readPids(file:string, expected:number):Promise<number[]> {
  const deadline=Date.now()+8000;
  while (Date.now()<deadline) {
    try {
      const data=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      if(data.length===expected) return data.map(row=>row.pid);
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw new Error('Process tree fixture did not become ready');
}
export function alive(pid:number) { try {process.kill(pid,0); return true;} catch {return false;} }
export async function waitDead(pids:number[]) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline && pids.some(alive)) await new Promise(resolve=>setTimeout(resolve,25));
  return pids.every(pid=>!alive(pid));
}
