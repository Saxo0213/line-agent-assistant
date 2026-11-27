import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {copyFile, mkdir, readFile, symlink, writeFile, rm, realpath} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {ClaudeEvents} from './claude.js';
import {CodexEvents} from './codex.js';
import {parseJsonl} from './jsonl.js';
import {WindowsExecutableResolver} from './executable-resolver.js';
import {NodeProcessRunner} from './process-runner.js';
import type {ProcessSpec} from './process-runner.js';
import type {RunningProcess} from './process-runner.js';
import {alive, cleanup, csc, fixtures, hostFile, installFixture, readPids, request, temporaryDirectory, waitDead} from './test-support.js';

let root:string;
beforeEach(async()=>{ root=await temporaryDirectory(); });
afterEach(async()=>{ await cleanup(root); });
const runner = new NodeProcessRunner();
function bridge(provider:'codex'|'claude', scenario='echo', options:Record<string,unknown>={}) {
  return new AgentCliBridge({
    enabled:true, workspaceRoots:[root], runner,
    resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,scenario],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})},
    ...options,
  });
}
async function collect(events:AsyncIterable<AgentEvent>) { const results:AgentEvent[]=[]; for await(const event of events) results.push(event); return results; }
function resultPayload(events:AgentEvent[]) {
  const last=events.at(-1); expect(last?.type).toBe('completed');
  return JSON.parse(last && 'finalText' in last ? last.finalText : '{}');
}

describe('direct provider quota queries',()=>{
  // The Codex query needs the login file of the source home (CliTalkAgent); a fake one in a temporary directory.
  beforeEach(async()=>{await writeFile(join(root,'auth.json'),'{}');});
  it('performs bounded Codex app-server initialize then rate-limit request without exposing stderr',async()=>{
    const lines:string[]=[];let wake:((value:string|null)=>void)|undefined;let initialized=false;let ended=false;
    const stdout:AsyncIterable<Uint8Array>={async *[Symbol.asyncIterator](){for(;;){const line=lines.length?lines.shift()!:await new Promise<string|null>(resolve=>{wake=resolve;});
      if(line===null)return;yield new TextEncoder().encode(`${line}\n`);}}};
    const push=(line:string)=>{if(wake){const resolve=wake;wake=undefined;resolve(line);}else lines.push(line);};
    let specification:ProcessSpec|undefined;
    const child:RunningProcess={stdout,stderr:(async function*(){yield new TextEncoder().encode('credential=never-forward-this');})(),
      exited:Promise.resolve({code:0,signal:null}),async cancel(){ended=true;},
      write(input){const messages=input.trim().split(/\r?\n/).map(line=>JSON.parse(line) as {id?:number;method?:string});
        if(messages.some(message=>message.method==='initialize')){expect(initialized).toBe(false);push(JSON.stringify({id:1,result:{serverInfo:{name:'codex'}}}));initialized=true;}
        if(messages.some(message=>message.method==='account/rateLimits/read')){expect(initialized).toBe(true);push(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:37,windowDurationMins:240,resetsAt:1790000000}}}}));}},
      endInput(){}};
    const instance=new AgentCliBridge({enabled:true,environment:{...process.env,CODEX_HOME:root},resolver:{resolve:async()=>({file:'C:\\Codex\\codex.exe',prefixArgs:[],version:'1.0.0',kind:'native'})},
      runner:{start(spec){specification=spec;return child;}}});
    await expect(instance.queryQuota('codex')).resolves.toMatchObject({rateLimits:{primary:{usedPercent:37}}});
    expect(specification?.keepStdinOpen).toBe(true);
    expect(specification?.args).toEqual(['app-server','--listen','stdio://']);
    expect(ended).toBe(true);
    await instance.shutdown();
  });
  it('fails promptly when app-server ends with a malformed unterminated stdout fragment',async()=>{
    const child:RunningProcess={stdout:(async function*(){yield new TextEncoder().encode('{"unexpected":');})(),
      stderr:(async function*(){})(),exited:Promise.resolve({code:1,signal:null}),async cancel(){},write(){},endInput(){}};
    const instance=new AgentCliBridge({enabled:true,environment:{...process.env,CODEX_HOME:root},resolver:{resolve:async()=>({file:'C:\\Codex\\codex.exe',prefixArgs:[],version:'1.0.0',kind:'native'})},
      runner:{start(){return child;}}});
    await expect(instance.queryQuota('codex')).rejects.toThrow('Codex app-server exited before returning rate limits');
    await instance.shutdown();
  });
});

describe('trusted executable resolution',()=>{
  it.each(['codex','claude'] as const)('validates %s resume against the execution cwd after an alias is retargeted',async provider=>{
    const a=join(root,'a'),b=join(root,'b'),alias=join(root,'alias');await mkdir(a);await mkdir(b);await symlink(a,alias,'junction');
    const canonicalA=await realpath(a),canonicalB=await realpath(b);const checked:string[]=[];
    const instance=bridge(provider,'echo',{validateResumeSession:async(input:{workspacePath:string})=>{
      checked.push(input.workspacePath);
      return input.workspacePath===canonicalA?{status:'valid'}:{status:'workspace_mismatch'};
    }});
    const first=await collect(instance.run(request(provider,alias)));
    expect(first.find(event=>event.type==='started')).toMatchObject({workspacePath:canonicalA});
    await rm(alias);await symlink(b,alias,'junction');
    const second=await collect(instance.run(request(provider,alias,{resumeSessionId:'session-a'})));
    expect(checked).toEqual([canonicalB]);expect(second.at(-1)?.type).toBe('completed');
    const secondPayload=resultPayload(second);
    expect(secondPayload.cwd.toLowerCase()).toBe(canonicalB.toLowerCase());
    expect(secondPayload.args).not.toContain(provider==='codex'?'resume':'--resume');
    const fresh=await collect(instance.run(request(provider,alias)));
    expect(fresh.find(event=>event.type==='started')).toMatchObject({workspacePath:canonicalB});
  });
  it('permanently closes every launch path even when an executable lookup returns late',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let launched=0;
    const instance=bridge('codex','echo',{resolver:{resolve:async()=>{await gate;return {file:process.execPath,prefixArgs:[],version:'0.144.5',kind:'native'};}},
      runner:{start(){launched++;throw new Error('unexpected launch');}}});
    const login=instance.openLogin('codex');let drained=false;const shutdown=instance.shutdown().then(()=>{drained=true;});
    await new Promise(resolve=>setTimeout(resolve,10));expect(drained).toBe(false);
    release();await Promise.all([login,shutdown]);
    await instance.openLogin('codex').catch(()=>undefined);
    await collect(instance.run(request('codex',root)));
    expect(launched).toBe(0);
  });
  it.each(['openLogin','logout','getAuthStatus','agentRefreshStatus'] as const)('cancels and awaits owned %s children before shutdown resolves',async action=>{
    let exit!:()=>void;let cancelCount=0;
    const exited=new Promise<{code:number;signal:null}>(resolve=>{exit=()=>resolve({code:0,signal:null});});
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    // Claude starts a process for every one of these actions. Codex reads its login file instead.
    const instance=bridge('claude','echo',{runner:{start(){started();return {stdout:(async function*(){})(),stderr:(async function*(){})(),exited,
      cancel:async()=>{cancelCount++;await exited;}};}}});
    const operation=instance[action]('claude');await ready;let done=false;
    const shutdown=instance.shutdown().then(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,10));
    expect(cancelCount).toBeGreaterThan(0);expect(done).toBe(false);exit();await Promise.all([operation,shutdown]);
  });
  it('owns the default executable resolver health probe under the same shutdown registry',async()=>{
    const bin=join(root,'npm');await installFixture(bin,'native');
    let exit!:()=>void;let started!:()=>void;let cancelled=0;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const exited=new Promise<{code:number;signal:null}>(resolve=>{exit=()=>resolve({code:0,signal:null});});
    const instance=new AgentCliBridge({workspaceRoots:[root],environment:{...process.env,APPDATA:root,PATH:bin},
      runner:{start(){started();return {stdout:(async function*(){yield Buffer.from('codex-cli 0.144.5');})(),stderr:(async function*(){})(),exited,
        cancel:async()=>{cancelled++;await exited;}};}}});
    const health=instance.health('codex');await ready;let done=false;
    const shutdown=instance.shutdown().then(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,10));
    expect(cancelled).toBeGreaterThan(0);expect(done).toBe(false);exit();await Promise.all([health,shutdown]);
    await expect(instance.health('codex')).rejects.toThrow('closing');
  });
  it('resolves live roots per launch and fails closed for stale queued work',async()=>{
    const a=join(root,'a'), b=join(root,'b'); await mkdir(a); await mkdir(b);
    let current=a;
    const instance=bridge('codex','echo',{workspaceRoots:[],resolveWorkspaceRoots:async()=>[current]});
    expect((await collect(instance.run(request('codex',a)))).at(-1)?.type).toBe('completed');
    current=b;
    expect((await collect(instance.run(request('codex',b)))).at(-1)?.type).toBe('completed');
    expect((await collect(instance.run(request('codex',a)))).at(-1)).toMatchObject({code:'INVALID_WORKSPACE'});
    current=root;
    expect((await collect(instance.run(request('codex',a)))).at(-1)?.type).toBe('completed');
  });
  it('keeps the authorized canonical cwd when settings change after the root snapshot',async()=>{
    const a=join(root,'a'), b=join(root,'b'); await mkdir(a); await mkdir(b);
    let current=a; let release!:()=>void; let ready!:()=>void;
    const paused=new Promise<void>(resolve=>{ready=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const instance=bridge('codex','echo',{workspaceRoots:[],resolveWorkspaceRoots:async()=>[current],
      resolver:{resolve:async()=>{ready();await gate;return {file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),'codex','echo'],version:'0.144.5',kind:'native'};}}});
    const result=collect(instance.run(request('codex',join(a,'.'))));
    await Promise.race([paused,result]); current=b;release();
    expect(resultPayload(await result).cwd.toLowerCase()).toBe(a.toLowerCase());
  });
  it('prefers a native executable over a trusted npm shim, including spaces',async()=>{
    const shimDir=join(root,'npm folder'), nativeDir=join(root,'native folder');
    await installFixture(shimDir,'shim'); const native=await installFixture(nativeDir,'native');
    const resolver=new WindowsExecutableResolver({runner,searchPath:`${shimDir};${nativeDir}`,trustedRoots:[root]});
    expect(await resolver.resolve('codex')).toMatchObject({file:native,kind:'native',prefixArgs:[],version:'0.144.5'});
  });
  it('parses only the fixed npm entrypoint and uses an external version-checked node.exe',async()=>{
    await installFixture(root,'shim');
    const resolver=new WindowsExecutableResolver({runner,searchPath:root,trustedRoots:[root,dirname(process.execPath)],nodeCandidates:[process.execPath]});
    expect(await resolver.resolve('codex')).toMatchObject({file:process.execPath,kind:'node',prefixArgs:[join(root,'node_modules','@openai','codex','bin','codex.js')],version:'0.144.5'});
  });
  it('rejects altered shim programs, workspace shadow executables and missing external Node',async()=>{
    const file=await installFixture(root,'shim');
    await writeFile(file,(await readFile(file,'utf8'))+'\nmalicious-command\n');
    expect(await new WindowsExecutableResolver({runner,searchPath:root,trustedRoots:[root],nodeCandidates:[process.execPath]}).resolve('codex')).toBeNull();
    await installFixture(root,'native');
    expect(await new WindowsExecutableResolver({runner,searchPath:root,trustedRoots:[]}).resolve('codex')).toBeNull();
    const onlyShim=join(root,'only shim'); await installFixture(onlyShim,'shim');
    expect(await new WindowsExecutableResolver({runner,searchPath:onlyShim,trustedRoots:[root],nodeCandidates:[]}).resolve('codex')).toBeNull();
  });
});

describe('provider CLI invocation and observed auth events',()=>{
  it('refreshes provider status as a read-only bridge operation',async()=>{
    const instance=bridge('claude');
    const observed:unknown[]=[];
    instance.onAuthStatus(status=>observed.push(status));

    const status=await instance.agentRefreshStatus('claude');

    expect(status).toMatchObject({provider:'claude',status:'authenticated'});
    expect(observed).toEqual([expect.objectContaining({provider:'claude',status:'authenticated'})]);
  });
  it('exposes sanitized auth outcomes to the health owner after explicit checks',async()=>{
    const instance=bridge('claude');
    const observed:unknown[]=[];
    instance.onAuthStatus(status=>observed.push(status));

    await instance.getAuthStatus('claude');

    expect(observed).toEqual([expect.objectContaining({provider:'claude',status:'authenticated'})]);
    expect(JSON.stringify(observed)).not.toMatch(/accessToken|private@example/);
  });
  it.each(['codex','claude'] as const)('starts %s inference without an auth-status preflight',async provider=>{
    const specifications:ProcessSpec[]=[];
    const recordingRunner={start(spec:ProcessSpec) {specifications.push(spec);return runner.start(spec);}};
    const instance=bridge(provider,'echo',{runner:recordingRunner});
    const authStatuses:unknown[]=[];
    instance.onAuthStatus(status=>authStatuses.push(status));
    const events=await collect(instance.run(request(provider,root)));
    expect(events.at(-1)?.type).toBe('completed');
    expect(authStatuses).toMatchObject([{provider,status:'authenticated'}]);
    expect(specifications.map(spec=>spec.args.slice(3))).toEqual([
      provider==='codex'
        ? ['exec','--json','--skip-git-repo-check','--ignore-user-config','--sandbox','workspace-write','-']
        : ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--restricted','--permission-mode','dontAsk','--strict-mcp-config','--tools','Read,Glob,Grep,Write,Edit','--disallowedTools','Bash','--allowedTools','Write,Edit'],
    ]);
    if (provider==='claude') expect(specifications[0]?.args[specifications[0]!.args.indexOf('--allowedTools')+1]).not.toContain('Bash');
  });
  it.each(['api','malformed','unknown','unavailable'] as const)('does not add a status gate for %s CLI state',async scenario=>{
    const specifications:ProcessSpec[]=[];
    const recordingRunner={start(spec:ProcessSpec) {specifications.push(spec);return runner.start(spec);}};
    const events=await collect(bridge('claude',scenario,{runner:recordingRunner}).run(request('claude',root)));
    expect(specifications).toHaveLength(1);
    expect(specifications[0]?.args.slice(3)).toContain('-p');
    expect(specifications[0]?.args.slice(3)).not.toContain('status');
    // A bad line is skipped, so the run ends without a terminal event.
    if (scenario === 'malformed') expect(events.at(-1)).toMatchObject({type:'failed',code:'MISSING_TERMINAL'});
  });
  it.each(['codex','claude'] as const)('keeps hostile %s prompts in stdin and isolates the environment',async provider=>{
    const prompt='--version "quotes"\n& echo injected | $(whoami) > marker; 世界';
    const events=await collect(bridge(provider,'echo',{environment:{...process.env,OPENAI_API_KEY:'openai-secret',ANTHROPIC_AUTH_TOKEN:'anthropic-secret',LINE_TOKEN:'line-secret',DATABASE_URL:'pg-secret',NODE_OPTIONS:'--bad-flag'}}).run(request(provider,root,{prompt})));
    const payload=resultPayload(events);
    expect(payload.input).toBe(prompt);
    expect(payload.cwd.toLowerCase()).toBe(root.toLowerCase());
    expect(payload.args).toEqual(provider==='codex'
      ? ['exec','--json','--skip-git-repo-check','--ignore-user-config','--sandbox','workspace-write','-']
      : ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--restricted','--permission-mode','dontAsk','--strict-mcp-config','--tools','Read,Glob,Grep,Write,Edit','--disallowedTools','Bash','--allowedTools','Write,Edit']);
    if (provider==='claude') expect(payload.args[payload.args.indexOf('--allowedTools')+1]).not.toContain('Bash');
    expect(JSON.stringify(payload.env)).not.toMatch(/openai-secret|anthropic-secret|line-secret|pg-secret|NODE_OPTIONS/);
  });
  it('preserves the configured Codex home for ordinary agent execution',async()=>{
    const configuredHome=join(root,'codex-auth-home');
    const events=await collect(bridge('codex','echo',{environment:{...process.env,CODEX_HOME:configuredHome}}).run(request('codex',root)));
    expect(resultPayload(events).env.CODEX_HOME).toBe(configuredHome);
  });
  it.each(['codex','claude'] as const)('requires trusted resume provenance and keeps %s resume options in their correct position',async provider=>{
    const id='33333333-3333-4333-8333-333333333333';
    const denied=await collect(bridge(provider).run(request(provider,root,{resumeSessionId:id})));
    expect(denied.at(-1)).toMatchObject({type:'failed',code:'INVALID_SESSION'});
    const invalid=await collect(bridge(provider,'echo',{validateResumeSession:async()=>({status:'invalid'})}).run(request(provider,root,{resumeSessionId:id})));
    expect(invalid.at(-1)).toMatchObject({type:'failed',code:'INVALID_SESSION'});
    const payload=resultPayload(await collect(bridge(provider,'echo',{validateResumeSession:async()=>({status:'valid'})}).run(request(provider,root,{resumeSessionId:id}))));
    expect(payload.args.slice(-3)).toEqual(provider==='codex'?['resume',id,'-']:['Write,Edit','--resume',id]);
    if (provider==='claude') expect(payload.args[payload.args.indexOf('--allowedTools')+1]).not.toContain('Bash');
    expect(await collect(bridge(provider,'echo',{validateResumeSession:async()=>({status:'valid'})}).run(request(provider,root,{resumeSessionId:'--bad-flag'})))).toEqual([expect.objectContaining({type:'failed',code:'INVALID_SESSION'})]);
  });
  it('defaults on while allowing an explicit opt-out and rejecting canonical workspace escapes through junctions',async()=>{
    const defaultEvents = await collect(bridge('codex','echo',{enabled:undefined}).run(request('codex',root)));
    expect(defaultEvents.at(-1)?.type).toBe('completed');
    expect(await collect(bridge('codex','echo',{enabled:false}).run(request('codex',root)))).toEqual([expect.objectContaining({type:'failed',code:'AGENT_DISABLED'})]);
    const outside=await temporaryDirectory();
    try {
      await symlink(outside,join(root,'escape'),'junction');
      expect(await collect(bridge('codex').run(request('codex',join(root,'escape'))))).toEqual([expect.objectContaining({type:'failed',code:'INVALID_WORKSPACE'})]);
    } finally { await cleanup(outside); }
  });
  it.each(['codex','claude'] as const)('parses chunked %s JSONL, exposes session/deltas and retains final text',async provider=>{
    const events=await collect(bridge(provider,'chunks').run(request(provider,root)));
    expect(events[0]).toMatchObject({type:'started',externalSessionId:provider==='codex'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222'});
    expect(events.filter(e=>e.type==='text_delta').map(e=>e.text).join('')).toBe('Hello 世界');
    expect(events.at(-1)).toEqual({type:'completed',finalText:'Hello 世界',usage:{inputTokens:12,outputTokens:4}});
  });
  it.each([['malformed','MISSING_TERMINAL'],['missing-terminal','MISSING_TERMINAL'],['invalid-terminal','NO_ASSISTANT_TEXT'],['nonzero','CLI_EXIT'],['terminal-then-nonzero','CLI_EXIT'],['empty-turn','NO_ASSISTANT_TEXT']])('contains %s output as one typed failure',async(scenario,code)=>{
    const events=await collect(bridge('codex',scenario).run(request('codex',root)));
    expect(events.at(-1)).toMatchObject({type:'failed',code});
    expect(events.filter(event=>event.type==='failed')).toHaveLength(1);
    expect(events.some(event=>event.type==='completed')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/sk-unsafe-secret-value/);
  });
  it('maps Claude result errors to a failure',async()=>{
    expect((await collect(bridge('claude','claude-error').run(request('claude',root)))).at(-1)).toMatchObject({type:'failed'});
  });
  it.each(['codex-limit','codex-limit-reverse'])('surfaces a Codex usage limit once as PROVIDER_LIMIT (%s)',async scenario=>{
    const events=await collect(bridge('codex',scenario).run(request('codex',root)));
    expect(events.filter(event=>event.type==='failed')).toHaveLength(1);
    expect(events.at(-1)).toEqual({type:'failed',code:'PROVIDER_LIMIT',retryable:true,hadToolActivity:false,hadEffectiveOutput:false,message:expect.stringContaining('Codex 已達用量上限：You\'ve hit your usage limit.')});
  });
  it('keeps a non-limit Codex failure as PROVIDER_FAILED with the provider text',async()=>{
    expect((await collect(bridge('codex','codex-fail').run(request('codex',root)))).at(-1))
      .toEqual({type:'failed',code:'PROVIDER_FAILED',retryable:false,hadToolActivity:false,hadEffectiveOutput:false,message:'Codex 無法完成這次工作：model exploded unexpectedly'});
  });
  it('redacts and bounds provider messages',async()=>{
    const last=(await collect(bridge('codex','codex-secret').run(request('codex',root)))).at(-1);
    expect(last).toMatchObject({type:'failed',code:'PROVIDER_FAILED'});
    const message=(last as {message:string}).message;
    expect(message).not.toMatch(/sk-unsafe-secret-value|abcd1234/);expect(message).toContain('[REDACTED]');expect(message.length).toBeLessThan(560);
  });
  it('skips unknown Codex events and fails the turn on an error event, as CliTalkAgent does',async()=>{
    expect((await collect(bridge('codex','codex-unknown-event').run(request('codex',root)))).at(-1)).toMatchObject({type:'failed',code:'PROVIDER_FAILED',message:expect.stringContaining('Reconnecting... 1/5'),hadEffectiveOutput:true});
  });
  it('classifies Claude error results',async()=>{
    expect((await collect(bridge('claude','claude-limit').run(request('claude',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_LIMIT',retryable:true,message:expect.stringContaining('Claude 已達用量上限：Claude AI usage limit reached')});
    expect((await collect(bridge('claude','claude-fail').run(request('claude',root)))).at(-1))
      .toEqual({type:'failed',code:'PROVIDER_FAILED',retryable:false,hadToolActivity:false,hadEffectiveOutput:false,message:'Claude 無法完成這次工作：tool crashed'});
  });
  it('classifies a remembered Codex error when the CLI exits without turn.failed',async()=>{
    expect((await collect(bridge('codex','codex-error-exit').run(request('codex',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_LIMIT',message:expect.stringContaining('hit your usage limit')});
  });
  it('yields the parsed failure when garbage follows turn.failed',async()=>{
    const events=await collect(bridge('codex','codex-failed-garbage').run(request('codex',root)));
    expect(events.filter(event=>event.type==='failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({type:'failed',code:'PROVIDER_LIMIT'});
  });
  it('classifies on the full message but truncates the display',async()=>{
    const last=(await collect(bridge('codex','codex-late-limit').run(request('codex',root)))).at(-1) as {code:string;message:string};
    expect(last.code).toBe('PROVIDER_LIMIT');expect(last.message.length).toBeLessThan(560);
  });
  it('ignores an error event after completed',async()=>{
    expect((await collect(bridge('codex','codex-complete-then-error').run(request('codex',root)))).at(-1)).toMatchObject({type:'completed',finalText:'done'});
  });
  it('classifies a Claude top-level error event',async()=>{
    expect((await collect(bridge('claude','claude-top-error').run(request('claude',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_RATE_LIMITED',message:expect.stringContaining('Rate limit exceeded')});
  });
  it('does not treat a generic "try again later" server error as a limit',async()=>{
    expect((await collect(bridge('claude','claude-500').run(request('claude',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_FAILED',message:expect.stringContaining('API Error: 500')});
  });
  it('notifies logged_out listeners for a parsed authentication failure',async()=>{
    const instance=bridge('claude','claude-auth-result');const statuses:unknown[]=[];
    instance.onAuthStatus(status=>statuses.push(status));
    expect((await collect(instance.run(request('claude',root)))).at(-1)).toMatchObject({type:'failed',code:'AUTH_REQUIRED'});
    expect(statuses).toMatchObject([{provider:'claude',status:'logged_out'}]);
  });
  it('retains a safe redacted diagnostic for nonzero process exits',async()=>{
    expect((await collect(bridge('codex','nonzero').run(request('codex',root)))).at(-1)).toMatchObject({type:'failed',code:'CLI_EXIT',message:expect.stringContaining('[REDACTED]')});
  });
  it.each(['codex','claude'] as const)('reports authentication required only after the %s CLI returns an authentication diagnostic',async provider=>{
    const instance=bridge(provider,'auth-required');
    const authStatuses:unknown[]=[];
    instance.onAuthStatus(status=>authStatuses.push(status));
    expect((await collect(instance.run(request(provider,root)))).at(-1)).toMatchObject({type:'failed',code:'AUTH_REQUIRED'});
    expect(authStatuses).toMatchObject([{provider,status:'logged_out'}]);
  });
  it.each([
    ['codex','0.144.4'],['codex','0.144.5'],['codex','0.144.6'],['claude','2.1.294'],['claude','2.1.295'],['claude','2.1.296'],
  ] as const)('does not gate %s %s on its version',async(provider,version)=>{
    const instance=bridge(provider,'echo',{resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version,kind:'native'})}});
    const health=await instance.health(provider);
    expect(health).toMatchObject({installed:true,version});
    expect(health).not.toHaveProperty('compatibility');
    expect(health).not.toHaveProperty('warning');
    expect((await collect(instance.run(request(provider,root)))).at(-1)?.type).toBe('completed');
  });
  it('cancels only the requested bridge job and rejects duplicate active IDs',async()=>{
    const instance=bridge('codex','hang');
    const first=instance.run(request('codex',root,{jobId:'first'}))[Symbol.asyncIterator]();
    const second=instance.run(request('codex',root,{jobId:'second'}))[Symbol.asyncIterator]();
    try {
      expect((await first.next()).value.type).toBe('started');
      expect((await second.next()).value.type).toBe('started');
      expect(await collect(instance.run(request('codex',root,{jobId:'second'})))).toEqual([expect.objectContaining({type:'failed',code:'DUPLICATE_JOB'})]);
      await instance.cancel('first');
      expect((await first.next()).value).toEqual({type:'cancelled'});
      await instance.shutdown();
      expect((await second.next()).value).toEqual({type:'cancelled'});
    } finally {await instance.shutdown();await first.return?.();await second.return?.();}
  });
  it('retains bridge ownership until a child exits after cancellation rejects',async()=>{
    const childScript = "process.stdout.write('{\\\"type\\\":\\\"thread.started\\\",\\\"thread_id\\\":\\\"11111111-1111-4111-8111-111111111111\\\"}\\n');setTimeout(()=>{},250)";
    const instance=bridge('codex','echo',{runner:{start() {
      const child=spawn(process.execPath,['-e',childScript],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
      return {stdout:child.stdout!,stderr:child.stderr!,exited,cancel:async()=>{throw new Error('cancel rejected while child is alive');}};
    }}});
    const iterator=instance.run(request('codex',root,{jobId:'uncertain-exit'}))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({type:'started'});
    let returned=false;
    const returning=iterator.return!().then(()=>{returned=true;});
    await new Promise(resolve=>setTimeout(resolve,30));
    expect(returned).toBe(false);
    expect(await collect(instance.run(request('codex',root,{jobId:'uncertain-exit'})))).toEqual([
      expect.objectContaining({type:'failed',code:'DUPLICATE_JOB'}),
    ]);
    await returning;
    expect(returned).toBe(true);
  });
  it('honors cancellation requested during asynchronous preflight without spawning a prompt',async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const instance=bridge('codex','echo',{validateResumeSession:async()=>{await gate;return {status:'valid'};}});
    const events=collect(instance.run(request('codex',root,{resumeSessionId:'trusted-session'})));
    await instance.cancel('job-1');release();
    expect(await events).toEqual([{type:'cancelled'}]);
  });
  it('contains a cancellation failure during broken output cleanup without leaking the runner error',async()=>{
    const instance=bridge('codex','echo',{runner:{start(spec:ProcessSpec) {
      if(!spec.args.includes('exec')) return runner.start(spec);
      return {
        stdout:(async function*(){throw new Error('stream broke');})(),
        stderr:(async function*(){})(),exited:Promise.resolve({code:1,signal:null}),
        cancel:async()=>{throw new Error('Private credential path and sk-secret-value');},
      };
    }}});
    const events=await collect(instance.run(request('codex',root)));
    expect(events).toEqual([expect.objectContaining({type:'failed',code:'CANCELLATION_FAILED'})]);
    expect(JSON.stringify(events)).not.toMatch(/Private|sk-secret/);
  });
  it('handles an early stderr read failure without an unhandled rejection in Main',async()=>{
    const instance=bridge('codex','echo',{runner:{start(spec:ProcessSpec) {
      if(!spec.args.includes('exec')) return runner.start(spec);
      return {
        stdout:(async function*(){await new Promise(resolve=>setTimeout(resolve,30));})(),
        stderr:(async function*(){throw new Error('private pipe failure');})(),
        exited:Promise.resolve({code:1,signal:null}),cancel:async()=>{},
      };
    }}});
    expect(await collect(instance.run(request('codex',root)))).toEqual([expect.objectContaining({type:'failed',code:'CLI_IO'})]);
  });
});

describe('Windows owned process tree',()=>{
  it('bounds cancellation even if its native signal helper stops responding',async()=>{
    const fakeHost=join(root,'UnresponsiveHost.exe');
    execFileSync(csc,['/nologo','/target:exe',`/out:${fakeHost}`,join(fixtures,'UnresponsiveHost.cs')],{windowsHide:true});
    const child=new NodeProcessRunner({hostFile:fakeHost}).start({file:process.execPath,args:[],env:process.env});
    const cancellation=child.cancel().then(()=> 'unexpected success',(error:Error)=>error.message);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([cancellation,new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('still waiting'),6500);})]);
      expect(result).toBe('Process cancellation timed out');
    } finally {
      if(timer) clearTimeout(timer);
      const pids=(await readFile(fakeHost+'.pids','utf8')).trim().split('\n').map(Number);
      for(const pid of pids){try{process.kill(pid);}catch{}}
      await cancellation;
      await child.exited;
    }
  },12000);
  it('cancels wrapper and grandchildren and leaves the other job alive',async()=>{
    const firstFile=join(root,'first.jsonl'), secondFile=join(root,'second.jsonl');
    const first=runner.start({file:process.execPath,args:[join(fixtures,'tree.cjs'),'root',firstFile],env:process.env});
    const second=runner.start({file:process.execPath,args:[join(fixtures,'tree.cjs'),'root',secondFile],env:process.env});
    let firstPids:number[]=[],secondPids:number[]=[];
    try {
      [firstPids,secondPids]=await Promise.all([readPids(firstFile,3),readPids(secondFile,3)]);
      const rootProcess=JSON.parse((await readFile(firstFile,'utf8')).split('\n')[0]!);
      expect(rootProcess.ppid).not.toBe(process.pid); // A separately owned native host must contain the CLI.
      await first.cancel();
      expect(await first.exited).toMatchObject({code:130}); // Host confirms Job Object is empty before exit.
      expect(firstPids.some(alive)).toBe(false);
      expect(await waitDead(firstPids)).toBe(true);
      expect(secondPids.every(alive)).toBe(true);
    } finally {
      await Promise.all([first.cancel(),second.cancel()]);
      for (const pid of [...firstPids,...secondPids]) {try{process.kill(pid);}catch{}}
    }
  },20000);
  it('cleans up all descendants when the native host crashes',async()=>{
    const output=join(root,'crash.jsonl');
    const child=runner.start({file:process.execPath,args:[join(fixtures,'tree.cjs'),'root',output],env:process.env});
    let pids:number[]=[];
    try {
      pids=await readPids(output,3);
      const hostPid=JSON.parse((await readFile(output,'utf8')).split('\n')[0]!).ppid;
      expect(hostPid).not.toBe(process.pid);
      process.kill(hostPid,'SIGKILL');
      await child.exited;
      expect(await waitDead(pids)).toBe(true);
    } finally {await child.cancel();for(const pid of pids){try{process.kill(pid);}catch{}}}
  },15000);
  it('cleans the tree if the owning application exits unexpectedly',async()=>{
    const output=join(root,'parent-exit.jsonl');
    let pids:number[]=[],hostPid:number|undefined;
    try {
      const result=await promisify(execFile)(process.execPath,[join(fixtures,'parent-exit.cjs'),hostFile,process.execPath,join(fixtures,'tree.cjs'),output],{windowsHide:true,timeout:10000});
      hostPid=Number(result.stdout.trim());
      pids=await readPids(output,3);
      expect(await waitDead([...pids,hostPid])).toBe(true);
    } finally {for(const pid of [...pids,...(hostPid?[hostPid]:[])]){try{process.kill(pid);}catch{}}}
  },20000);
});

describe('output protocol (same as CliTalkAgent)',()=>{
  const feed=(events:{accept(value:unknown):AgentEvent[]},lines:unknown[])=>lines.flatMap(line=>events.accept(line));
  // 1.1
  it('skips an invalid UTF-8 line, a line that is not JSON and a value that is not an object',async()=>{
    const bytes=[Buffer.from('{"a":1}\n'),Buffer.from([0xff,0xfe,0x0a]),Buffer.from('not json\n'),Buffer.from('[1]\n"text"\n'),Buffer.from('{"b":2}')];
    const values:unknown[]=[];
    for await(const value of parseJsonl((async function*(){yield* bytes;})())) values.push(value);
    expect(values).toEqual([{a:1},[1],'text',{b:2}]);
    const claude=new ClaudeEvents();
    expect(feed(claude,[[1],'text',null,{type:5},{type:'assistant',message:{content:7}},{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:9}}}])).toEqual([]);
    const codex=new CodexEvents();
    expect(feed(codex,[[1],{type:'item.completed',item:'x'},{type:'thread.started',thread_id:7},{type:'turn.completed',usage:'bad'}])).toMatchObject([{type:'failed',code:'NO_ASSISTANT_TEXT'}]);
  });
  // 1.2
  it('fails a Claude result only when is_error is true, with no session or subtype rule',()=>{
    expect(feed(new ClaudeEvents(),[{type:'result',subtype:'error_max_turns',is_error:false,result:'partial'}])).toEqual([{type:'completed',finalText:'partial'}]);
    expect(feed(new ClaudeEvents(),[{type:'result',result:'ok'},{type:'result',is_error:true,result:'late'},{type:'error',message:'late'}])).toEqual([{type:'completed',finalText:'ok'}]);
  });
  // 1.3
  it('takes the Claude session id from any line and reports started once',()=>{
    const events=feed(new ClaudeEvents(),[{type:'assistant',sessionId:'sess-1',message:{content:[]}},{type:'system',subtype:'init',session_id:'sess-2'},{type:'result',result:'ok',session_id:'sess-3'}]);
    expect(events.filter(event=>event.type==='started')).toEqual([{type:'started',externalSessionId:'sess-1'}]);
  });
  // 1.4
  it('uses the assistant text when result is empty and removes a leading timestamp',()=>{
    const events=feed(new ClaudeEvents(),[{type:'assistant',message:{content:[{type:'text',text:'[07:12] '},{type:'text',text:'hello'}]}},{type:'result',is_error:false,result:'  '}]);
    expect(events.at(-1)).toEqual({type:'completed',finalText:'hello'});
    expect(feed(new ClaudeEvents(),[{type:'result',result:'[3/9 07:12]　done [07:12]'}]).at(-1)).toEqual({type:'completed',finalText:'done [07:12]'});
    expect(feed(new ClaudeEvents(),[{type:'result',result:'[99:99] [TODO] x'}]).at(-1)).toEqual({type:'completed',finalText:'[99:99] [TODO] x'});
  });
  // 1.5
  it('reports tool starts once in a row and keeps the activity flags',()=>{
    const claude=new ClaudeEvents();
    const events=feed(claude,[{type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read'}]}},{type:'assistant',message:{content:[{type:'tool_use',id:'t2',name:'Read'}]}},{type:'assistant',message:{content:[{type:'tool_use',id:'t3',name:'mcp__x__y'}]}}]);
    expect(events).toEqual([{type:'tool_started',toolName:'讀取檔案…',toolUseId:'t1'},{type:'tool_started',toolName:'使用工具：mcp__x__y…',toolUseId:'t3'}]);
    expect([claude.hadToolActivity,claude.hadEffectiveOutput]).toEqual([true,false]);
    const codex=new CodexEvents();
    expect(feed(codex,[{type:'item.started',item:{id:'i1',type:'command_execution',command:'secret'}},{type:'item.started',item:{id:'i2',type:'mcp_tool_call',server:'s',name:'n'}},{type:'item.completed',item:{id:'i3',type:'agent_message',text:'hi'}}]))
      .toEqual([{type:'tool_started',toolName:'執行命令',toolUseId:'i1'},{type:'tool_started',toolName:'MCP：s.n',toolUseId:'i2'},{type:'text_delta',text:'hi'}]);
    expect([codex.hadToolActivity,codex.hadEffectiveOutput]).toEqual([true,true]);
  });
  it('adds the activity flags to a failure after the CLI started',async()=>{
    expect((await collect(bridge('claude','claude-fail').run(request('claude',root)))).at(-1)).toMatchObject({type:'failed',hadToolActivity:false,hadEffectiveOutput:false});
  });
  // 1.6
  it('lets the last Codex error or turn.failed win and reads message, error text, then error.message',()=>{
    expect(feed(new CodexEvents(),[{type:'error',message:'first'},{type:'turn.failed',error:{message:'second'}}])).toMatchObject([{type:'failed',message:expect.stringContaining('second')}]);
    expect(feed(new CodexEvents(),[{type:'error',error:'plain text'},{type:'turn.completed'}])).toMatchObject([{type:'failed',message:expect.stringContaining('plain text')}]);
  });
  // 1.7
  it('replies with the trimmed completed agent messages joined by a new line',()=>{
    const events=feed(new CodexEvents(),[{type:'item.started',item:{id:'a',type:'agent_message',text:'draft'}},{type:'item.updated',item:{id:'a',type:'agent_message',text:'other'}},
      {type:'item.completed',item:{id:'a',type:'agent_message',text:'  one '}},{type:'item.completed',item:{id:'b',type:'agent_message',text:'two\n'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}]);
    expect(events.at(-1)).toEqual({type:'completed',finalText:'one\ntwo',usage:{inputTokens:1,outputTokens:2}});
    expect(events.filter(event=>event.type==='text_delta').map(event=>event.text).join('')).toBe('one\ntwo');
    expect(feed(new CodexEvents(),[{type:'turn.completed'}])).toMatchObject([{type:'failed',code:'NO_ASSISTANT_TEXT'}]);
  });
  it('replies with the messages after the last tool item, or the last earlier message',()=>{
    const message=(text:string)=>({type:'item.completed',item:{type:'agent_message',text}});
    const tool={type:'item.completed',item:{id:'t',type:'command_execution'}};
    expect(feed(new CodexEvents(),[message('before'),tool,message('answer'),{type:'turn.completed'}]).at(-1)).toEqual({type:'completed',finalText:'answer'});
    expect(feed(new CodexEvents(),[message('before'),tool,{type:'turn.completed'}]).at(-1)).toEqual({type:'completed',finalText:'before'});
  });
  // 1.8
  it('ignores usage that is not valid',()=>{
    expect(feed(new CodexEvents(),[{type:'item.completed',item:{type:'agent_message',text:'a'}},{type:'turn.completed',usage:{input_tokens:-1,output_tokens:'x'}}]).at(-1)).toEqual({type:'completed',finalText:'a'});
    expect(feed(new ClaudeEvents(),[{type:'result',result:'a',usage:'bad'}]).at(-1)).toEqual({type:'completed',finalText:'a'});
  });
});
