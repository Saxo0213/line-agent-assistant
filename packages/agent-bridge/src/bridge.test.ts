import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {copyFile, mkdir, readFile, symlink, writeFile, rm, realpath} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {WindowsExecutableResolver} from './executable-resolver.js';
import {NodeProcessRunner} from './process-runner.js';
import type {ProcessSpec} from './process-runner.js';
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
    const instance=bridge('codex','echo',{runner:{start(){started();return {stdout:(async function*(){})(),stderr:(async function*(){})(),exited,
      cancel:async()=>{cancelCount++;await exited;}};}}});
    const operation=instance[action]('codex');await ready;let done=false;
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
        ? ['exec','--ignore-user-config','--json','--sandbox','workspace-write','--skip-git-repo-check','-C',root,'-']
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
    if (scenario === 'malformed') expect(events.at(-1)).toMatchObject({type:'failed',code:'INVALID_JSONL'});
  });
  it.each(['codex','claude'] as const)('keeps hostile %s prompts in stdin and isolates the environment',async provider=>{
    const prompt='--version "quotes"\n& echo injected | $(whoami) > marker; 世界';
    const events=await collect(bridge(provider,'echo',{environment:{...process.env,OPENAI_API_KEY:'openai-secret',ANTHROPIC_AUTH_TOKEN:'anthropic-secret',LINE_TOKEN:'line-secret',DATABASE_URL:'pg-secret',NODE_OPTIONS:'--bad-flag'}}).run(request(provider,root,{prompt})));
    const payload=resultPayload(events);
    expect(payload.input).toBe(prompt);
    expect(payload.cwd.toLowerCase()).toBe(root.toLowerCase());
    expect(payload.args).toEqual(provider==='codex'
      ? ['exec','--ignore-user-config','--json','--sandbox','workspace-write','--skip-git-repo-check','-C',root,'-']
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
  it.each([['malformed','INVALID_JSONL'],['missing-terminal','MISSING_TERMINAL'],['invalid-terminal','INVALID_JSONL'],['nonzero','CLI_EXIT'],['terminal-then-nonzero','CLI_EXIT'],['no-session','INVALID_JSONL'],['empty-turn','INVALID_JSONL']])('contains %s output as one typed failure',async(scenario,code)=>{
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
    expect(events.at(-1)).toEqual({type:'failed',code:'PROVIDER_LIMIT',retryable:true,message:expect.stringContaining('Codex 已達用量上限：You\'ve hit your usage limit.')});
  });
  it('keeps a non-limit Codex failure as PROVIDER_FAILED with the provider text',async()=>{
    expect((await collect(bridge('codex','codex-fail').run(request('codex',root)))).at(-1))
      .toEqual({type:'failed',code:'PROVIDER_FAILED',retryable:false,message:'Codex 無法完成這次工作：model exploded unexpectedly'});
  });
  it('redacts and bounds provider messages',async()=>{
    const last=(await collect(bridge('codex','codex-secret').run(request('codex',root)))).at(-1);
    expect(last).toMatchObject({type:'failed',code:'PROVIDER_FAILED'});
    const message=(last as {message:string}).message;
    expect(message).not.toMatch(/sk-unsafe-secret-value|abcd1234/);expect(message).toContain('[REDACTED]');expect(message.length).toBeLessThan(560);
  });
  it('ignores unknown and non-fatal Codex events and still completes',async()=>{
    expect((await collect(bridge('codex','codex-unknown-event').run(request('codex',root)))).at(-1)).toEqual({type:'completed',finalText:'done',usage:{inputTokens:1,outputTokens:2}});
  });
  it('classifies Claude error results',async()=>{
    expect((await collect(bridge('claude','claude-limit').run(request('claude',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_LIMIT',retryable:true,message:expect.stringContaining('Claude 已達用量上限：Claude AI usage limit reached')});
    expect((await collect(bridge('claude','claude-fail').run(request('claude',root)))).at(-1))
      .toEqual({type:'failed',code:'PROVIDER_FAILED',retryable:false,message:'Claude 無法完成這次工作：tool crashed'});
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
  it('still rejects an error event after completed',async()=>{
    expect((await collect(bridge('codex','codex-complete-then-error').run(request('codex',root)))).at(-1)).toMatchObject({type:'failed',code:'INVALID_JSONL'});
  });
  it('classifies a Claude top-level error event',async()=>{
    expect((await collect(bridge('claude','claude-top-error').run(request('claude',root)))).at(-1))
      .toMatchObject({type:'failed',code:'PROVIDER_LIMIT',message:expect.stringContaining('Rate limit exceeded')});
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
    ['codex','0.144.4','incompatible'],['codex','0.144.5','supported'],['codex','0.144.6','unverified'],
    ['claude','2.1.294','incompatible'],['claude','2.1.295','supported'],['claude','2.1.296','unverified'],
  ] as const)('reports %s %s compatibility as %s',async(provider,version,compatibility)=>{
    const instance=bridge(provider,'echo',{resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version,kind:'native'})}});
    expect(await instance.health(provider)).toMatchObject({installed:true,version,compatibility});
    if(compatibility==='unverified') expect((await instance.health(provider)).warning).toMatch(/not been fixture-validated/);
    const events=await collect(instance.run(request(provider,root)));
    expect(events.at(-1)?.type).toBe(compatibility==='incompatible'?'failed':'completed');
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
  it('contains a cancellation failure during malformed output cleanup without leaking the runner error',async()=>{
    const instance=bridge('codex','echo',{runner:{start(spec:ProcessSpec) {
      if(!spec.args.includes('exec')) return runner.start(spec);
      return {
        stdout:(async function*(){yield Buffer.from('{bad}\n');})(),
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
