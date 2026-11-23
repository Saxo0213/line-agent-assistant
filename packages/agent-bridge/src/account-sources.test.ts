import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import type {ResidentTurnOptions} from './index.js';
import {NodeProcessRunner} from './process-runner.js';
import type {ProcessSpec,RunningProcess} from './process-runner.js';
import {cleanup,fixtures,request,temporaryDirectory} from './test-support.js';

let root:string;
let accounts:string;
beforeEach(async()=>{root=await temporaryDirectory();accounts=join(root,'llm-accounts');await mkdir(accounts);});
afterEach(async()=>{await cleanup(root);});

const managed={id:'acct-0123456789',kind:'managed' as const};
async function signIn(provider:'claude'|'codex',id=managed.id) {
  const directory=join(accounts,id);
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,provider==='claude'?'.credentials.json':'auth.json'),'{"fake":"not-read"}');
  return directory;
}
async function collect(events:AsyncIterable<AgentEvent>) {const result:AgentEvent[]=[];for await(const event of events) result.push(event);return result;}
const payloadOf=(events:AgentEvent[])=>{const last=events.at(-1);expect(last?.type).toBe('completed');return JSON.parse(last&&'finalText' in last?last.finalText:'{}');};
/** The real runner with the echo fixture: the child prints its own environment. */
function realBridge(provider:'claude'|'codex',environment:NodeJS.ProcessEnv) {
  return new AgentCliBridge({
    enabled:true,workspaceRoots:[root],runner:new NodeProcessRunner(),environment,accountsDirectory:accounts,
    resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version:'1.0.0',kind:'native'})},
  });
}
/** A runner that only records. It never starts a process. */
function recordingBridge(accountsDirectory:string|undefined=accounts) {
  const specs:ProcessSpec[]=[];
  let resolves=0;
  const bridge=new AgentCliBridge({
    enabled:true,workspaceRoots:[root],...(accountsDirectory===undefined?{}:{accountsDirectory}),
    resolver:{resolve:async()=>{resolves++;return {file:'C:\\Cli\\cli.exe',prefixArgs:[],version:'1.0.0',kind:'native' as const};}},
    runner:{start(spec){specs.push(spec);throw new Error('no process in this test');}},
  });
  return {bridge,specs,resolves:()=>resolves};
}

describe('account source environment of a run',()=>{
  it('gives a managed Codex account its own CODEX_HOME in place of the parent value',async()=>{
    const directory=await signIn('codex');
    const events=await collect(realBridge('codex',{...process.env,CODEX_HOME:join(root,'host-codex')}).run(request('codex',root,{account:managed})));
    expect(payloadOf(events).env.CODEX_HOME).toBe(directory);
  });
  it('gives a managed Claude account CLAUDE_CONFIG_DIR and no host credential variable',async()=>{
    const directory=await signIn('claude');
    const events=await collect(realBridge('claude',{...process.env,CLAUDE_CONFIG_DIR:join(root,'host-claude'),CLAUDE_CODE_OAUTH_TOKEN:'host-oauth',ANTHROPIC_API_KEY:'host-key',ANTHROPIC_AUTH_TOKEN:'host-token'}).run(request('claude',root,{account:managed})));
    const env=payloadOf(events).env as Record<string,string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(directory);
    expect(Object.keys(env).filter(name=>/^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/i.test(name))).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(/host-oauth|host-key|host-token|host-claude/);
  });
  it('gives the system Claude source no CLAUDE_CONFIG_DIR, and the system Codex source the parent CODEX_HOME',async()=>{
    const claude=payloadOf(await collect(realBridge('claude',{...process.env,CLAUDE_CONFIG_DIR:join(root,'host-claude')}).run(request('claude',root,{account:{id:'claude',kind:'system'}}))));
    expect(claude.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const codex=payloadOf(await collect(realBridge('codex',{...process.env,CODEX_HOME:join(root,'host-codex')}).run(request('codex',root))));
    expect(codex.env.CODEX_HOME).toBe(join(root,'host-codex'));
  });
});

describe('managed account without a login',()=>{
  const failure={type:'failed',code:'ACCOUNT_NOT_LOGGED_IN',message:'The CLI account is not signed in.',retryable:false};
  it.each(['claude','codex'] as const)('fails %s before the executable resolves or any process starts',async provider=>{
    const {bridge,specs,resolves}=recordingBridge();
    expect(await collect(bridge.run(request(provider,root,{account:managed})))).toEqual([failure]);
    expect(specs).toHaveLength(0);
    expect(resolves()).toBe(0);
  });
  it('fails when the login file is a directory, and when no accounts directory is set',async()=>{
    await mkdir(join(accounts,managed.id,'.credentials.json'),{recursive:true});
    const {bridge,specs}=recordingBridge();
    expect(await collect(bridge.run(request('claude',root,{account:managed})))).toEqual([failure]);
    const none=recordingBridge(undefined);
    expect(await collect(none.bridge.run(request('claude',root,{account:managed})))).toEqual([failure]);
    expect(specs.length+none.specs.length).toBe(0);
  });
  it('fails a resident turn and a judge call the same way',async()=>{
    const {bridge,specs}=recordingBridge();
    const turn:ResidentTurnOptions={key:'k',mcpEndpoint:null,bindMcp:()=>'rebound',timeoutMs:1000,stallMs:0};
    expect(await collect(bridge.runResident(request('claude',root,{account:managed}),turn))).toEqual([failure]);
    await expect(bridge.judge({provider:'claude',prompt:'p',systemPrompt:'s',workspacePath:root,account:managed})).rejects.toThrow('The CLI account is not signed in');
    expect(specs).toHaveLength(0);
  });
});

describe('account source and the resident process',()=>{
  const assistant={type:'assistant',session_id:'s1',message:{content:[{type:'text',text:'hi'}]}};
  function residentBridge() {
    const specs:ProcessSpec[]=[];
    const cancels:number[]=[];
    const bridge=new AgentCliBridge({
      enabled:true,workspaceRoots:[root],accountsDirectory:accounts,
      resolver:{resolve:async()=>({file:'C:\\Claude\\claude.exe',prefixArgs:[],version:'2.1.295',kind:'native'})},
      runner:{start(spec){
        specs.push(spec);
        const index=specs.length-1;
        const lines:Uint8Array[]=[];let wake:(()=>void)|undefined;let done=false;
        const stdout:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>({async next(){for(;;){const line=lines.shift();if(line)return {value:line,done:false};if(done)return {value:undefined,done:true};await new Promise<void>(resolve=>{wake=resolve;});}}})};
        let exit!:(value:{code:number|null;signal:null})=>void;
        const exited=new Promise<{code:number|null;signal:null}>(resolve=>{exit=resolve;});
        const child:RunningProcess={stdout,stderr:(async function*(){})(),exited,
          cancel:async()=>{cancels.push(index);done=true;wake?.();exit({code:null,signal:null});},
          write:()=>{for(const value of [assistant,{type:'result',is_error:false,result:'done'}]) lines.push(new TextEncoder().encode(JSON.stringify(value)+'\n'));wake?.();}};
        return child;
      }},
    });
    return {bridge,specs,cancels};
  }
  const turn:ResidentTurnOptions={key:'k',mcpEndpoint:null,bindMcp:()=>'rebound',timeoutMs:3000,stallMs:0};
  it('keeps one process for one account, and replaces it when the account changes',async()=>{
    const first=await signIn('claude');
    await signIn('claude','acct-9876543210');
    const {bridge,specs,cancels}=residentBridge();
    const run=(jobId:string,account?:{id:string;kind:'system'|'managed'})=>collect(bridge.runResident(request('claude',root,{jobId,...(account?{account}:{})}),turn));
    await run('job-1',managed);
    await run('job-2',managed);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.accountEnv).toEqual({CLAUDE_CONFIG_DIR:first});
    await run('job-3',{id:'acct-9876543210',kind:'managed'});
    expect(specs).toHaveLength(2);
    expect(specs[1]?.accountEnv).toEqual({CLAUDE_CONFIG_DIR:join(accounts,'acct-9876543210')});
    expect(cancels).toEqual([0]);
    await run('job-4');
    expect(specs).toHaveLength(3);
    expect(specs[2]?.accountEnv).toBeUndefined();
    await bridge.shutdown();
  });
});

describe('account source quota query',()=>{
  it('starts no Codex app-server when the account has no auth.json, and starts it with the account CODEX_HOME otherwise',async()=>{
    const {bridge,specs}=recordingBridge();
    await expect(bridge.queryQuota('codex',managed)).rejects.toThrow('Codex CLI is not signed in');
    expect(specs).toHaveLength(0);
    const directory=await signIn('codex');
    await expect(bridge.queryQuota('codex',managed)).rejects.toThrow();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.accountEnv).toEqual({CODEX_HOME:directory});
    expect(specs[0]?.args).toEqual(['app-server','--listen','stdio://']);
  });
});
