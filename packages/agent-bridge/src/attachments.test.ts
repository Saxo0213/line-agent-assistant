import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {claudeArguments} from './claude.js';
import {codexArguments} from './codex.js';
import {NodeProcessRunner} from './process-runner.js';
import {cleanup, fixtures, request, temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{ root=await temporaryDirectory(); });
afterEach(async()=>{ await cleanup(root); });

function bridge(provider:'codex'|'claude',options:Record<string,unknown>={}) {
  return new AgentCliBridge({
    enabled:true,workspaceRoots:[root],runner:new NodeProcessRunner(),
    resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})},
    ...options,
  });
}
async function collect(events:AsyncIterable<AgentEvent>) { const results:AgentEvent[]=[]; for await(const event of events) results.push(event); return results; }
function payload(events:AgentEvent[]) {
  const last=events.at(-1); expect(last?.type).toBe('completed');
  return JSON.parse(last && 'finalText' in last ? last.finalText : '{}');
}
async function workspaceWithImage(name='shot.png') {
  const workspace=join(root,'ws'); const directory=join(workspace,'.agent-attachments','job-1');
  await mkdir(directory,{recursive:true}); await writeFile(join(directory,name),'png');
  return {workspace:await realpath(workspace),image:join(await realpath(directory),name)};
}

describe('codexArguments image flags',()=>{
  const base=request('codex','C:\\ws');
  it('passes one --image=<path> per image before -C, keeping the trailing - last',()=>{
    const args=codexArguments({...base,imagePaths:['C:\\ws\\a.png','C:\\ws\\b b.png']},'C:\\ws');
    expect(args.filter(arg=>arg.startsWith('--image='))).toEqual(['--image=C:\\ws\\a.png','--image=C:\\ws\\b b.png']);
    expect(args.indexOf('--image=C:\\ws\\a.png')).toBeLessThan(args.indexOf('-C'));
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('--image');
    expect(args).not.toContain('-i');
  });
  it('places the flags after resume <id> when resuming and still ends with -',()=>{
    const args=codexArguments({...base,resumeSessionId:'sess-1',imagePaths:['C:\\ws\\a.png']},'C:\\ws');
    const resume=args.indexOf('resume');
    expect(args.slice(resume,resume+3)).toEqual(['resume','sess-1','--image=C:\\ws\\a.png']);
    expect(args.at(-1)).toBe('-');
    expect(args.filter(arg=>arg.startsWith('--image=')).length).toBe(1);
  });
  it('does not pass a path containing a comma as a flag (Codex splits image values on commas)',()=>{
    const args=codexArguments({...base,imagePaths:['C:\\ws\\a,b.png','C:\\ws\\c.png']},'C:\\ws');
    expect(args.filter(arg=>arg.startsWith('--image='))).toEqual(['--image=C:\\ws\\c.png']);
  });
  it('is unchanged without images and Claude never gets image flags',()=>{
    expect(codexArguments(base,'C:\\ws').some(arg=>arg.includes('image'))).toBe(false);
    expect(claudeArguments({...base,provider:'claude',imagePaths:['C:\\ws\\a.png']}).some(arg=>arg.includes('image'))).toBe(false);
  });
});

describe('bridge image path validation',()=>{
  it('hands Codex the canonical image path as --image and keeps - last, fresh and on resume',async()=>{
    const {workspace,image}=await workspaceWithImage();
    const fresh=payload(await collect(bridge('codex').run(request('codex',workspace,{imagePaths:[image]}))));
    expect(fresh.args).toContain(`--image=${image}`);
    expect(fresh.args.at(-1)).toBe('-');
    const resumed=payload(await collect(bridge('codex',{validateResumeSession:async()=>({status:'valid'})}).run(request('codex',workspace,{imagePaths:[image],resumeSessionId:'session-a'}))));
    const resume=resumed.args.indexOf('resume');
    expect(resumed.args.slice(resume,resume+3)).toEqual(['resume','session-a',`--image=${image}`]);
    expect(resumed.args.at(-1)).toBe('-');
  });
  it('fails ATTACHMENT_MISSING for a missing file, a directory, or a path outside the roots, without starting the CLI',async()=>{
    const {workspace}=await workspaceWithImage();
    const outside=await realpath(await mkdtemp(join(tmpdir(),'bridge-outside-')));
    await writeFile(join(outside,'x.png'),'png');
    try {
      for(const imagePaths of [[join(workspace,'.agent-attachments','job-1','missing.png')],[join(workspace,'.agent-attachments')],[join(outside,'x.png')]]) {
        const events=await collect(bridge('codex').run(request('codex',workspace,{imagePaths})));
        expect(events).toEqual([expect.objectContaining({type:'failed',code:'ATTACHMENT_MISSING'})]);
      }
    } finally { await cleanup(outside); }
  });
  it('ignores image paths for Claude and rejects an oversize list at the schema',async()=>{
    const {workspace,image}=await workspaceWithImage();
    const claude=payload(await collect(bridge('claude').run(request('claude',workspace,{imagePaths:[image]}))));
    expect(claude.args.some((arg:string)=>arg.includes('--image'))).toBe(false);
    const events=await collect(bridge('codex').run(request('codex',workspace,{imagePaths:Array.from({length:11},()=>image)})));
    expect(events).toEqual([expect.objectContaining({type:'failed',code:'INVALID_REQUEST'})]);
  });
});
