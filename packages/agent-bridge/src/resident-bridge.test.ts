import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge,type ResidentTurnOptions} from './index.js';
import type {ProcessSpec,RunningProcess} from './process-runner.js';
import {cleanup,request,temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});

function channel() {
  const queue:Uint8Array[]=[];
  let wake:(()=>void)|undefined;
  let done=false;
  const iterable:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>({
    async next() {
      for(;;) {
        const chunk=queue.shift();
        if(chunk) return {value:chunk,done:false};
        if(done) return {value:undefined,done:true};
        await new Promise<void>(resolve=>{wake=resolve;});
      }
    },
  })};
  return {iterable,push(text:string) {queue.push(new TextEncoder().encode(text));wake?.();},end() {done=true;wake?.();}};
}
const assistant={type:'assistant',session_id:'s1',message:{content:[{type:'text',text:'hi'}]}};
const ok={type:'result',is_error:false,result:'done'};
interface Fake {proc:RunningProcess;writes:string[];cancels:number;line(value:unknown):void}
/** `reply` runs on each stdin write. It may answer at once, or do nothing. */
function fakeProcess(reply:(fake:Fake,count:number)=>void):Fake {
  const out=channel(),err=channel();
  let resolveExit!:(value:{code:number|null;signal:null})=>void;
  const exited=new Promise<{code:number|null;signal:null}>(resolve=>{resolveExit=resolve;});
  const fake:Fake={
    writes:[],cancels:0,
    line(value) {out.push(JSON.stringify(value)+'\n');},
    proc:{
      stdout:out.iterable,stderr:err.iterable,exited,
      cancel:async()=>{fake.cancels++;out.end();err.end();resolveExit({code:null,signal:null});},
      write:(input:string)=>{fake.writes.push(input);reply(fake,fake.writes.length);},
    },
  };
  return fake;
}
const answer=(fake:Fake)=>{fake.line(assistant);fake.line(ok);};

function setup(reply:(fake:Fake,count:number)=>void=answer) {
  const specs:ProcessSpec[]=[];
  const fakes:Fake[]=[];
  const bridge=new AgentCliBridge({
    enabled:true,workspaceRoots:[root],
    resolver:{resolve:async()=>({file:'C:\\Claude\\claude.exe',prefixArgs:[],version:'2.1.295',kind:'native'})},
    runner:{start(spec){specs.push(spec);const fake=fakeProcess(reply);fakes.push(fake);return fake.proc;}},
  });
  return {bridge,specs,fakes};
}
const turnOptions=(overrides:Partial<ResidentTurnOptions>={}):ResidentTurnOptions=>({
  key:'resident-1',mcpEndpoint:null,bindMcp:()=>'rebound',timeoutMs:5000,stallMs:0,...overrides,
});
async function collect(events:AsyncIterable<AgentEvent>) {const result:AgentEvent[]=[];for await(const event of events) result.push(event);return result;}
async function until(condition:()=>boolean,ms=3000) {
  const deadline=Date.now()+ms;
  while(!condition()) {
    if(Date.now()>deadline) throw new Error('Condition was not met in time');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
const job=(jobId:string)=>request('claude',root,{jobId,prompt:`prompt of ${jobId}`});

describe('AgentCliBridge.runResident',()=>{
  it('serves two turns of one key with one process and two stdin lines',async()=>{
    const {bridge,specs,fakes}=setup();
    const first=await collect(bridge.runResident(job('job-1'),turnOptions()));
    const second=await collect(bridge.runResident(job('job-2'),turnOptions()));
    expect(first.at(-1)).toMatchObject({type:'completed',finalText:'done'});
    expect(second.at(-1)?.type).toBe('completed');
    expect(first[0]).toMatchObject({type:'started',workspacePath:root});
    expect(specs).toHaveLength(1);
    expect(specs[0]?.keepStdinOpen).toBe(true);
    expect(specs[0]?.input).toBeUndefined();
    expect(specs[0]?.cwd).toBe(root);
    expect(fakes[0]?.writes.map(line=>JSON.parse(line).message.content)).toEqual(['prompt of job-1','prompt of job-2']);
    expect(bridge.hasResident('resident-1')).toBe(true);
    await bridge.shutdown();
    expect(fakes[0]?.cancels).toBeGreaterThan(0);
  });

  it('respawns when the arguments hash changes',async()=>{
    const {bridge,specs,fakes}=setup();
    await collect(bridge.runResident(job('job-1'),turnOptions({model:'sonnet'})));
    await collect(bridge.runResident(job('job-2'),turnOptions({model:'haiku'})));
    expect(specs).toHaveLength(2);
    expect(fakes[0]?.cancels).toBeGreaterThan(0);
    await bridge.shutdown();
  });

  it('resets a live entry when bindMcp returns null, then binds fresh',async()=>{
    const {bridge,specs,fakes}=setup();
    const calls:boolean[]=[];
    const bindMcp=(fresh:boolean)=>{calls.push(fresh);return fresh?{token:`li_job_${'a'.repeat(32)}`}:null;};
    await collect(bridge.runResident(job('job-1'),turnOptions({bindMcp,mcpEndpoint:'http://127.0.0.1:1/mcp'})));
    await collect(bridge.runResident(job('job-2'),turnOptions({bindMcp,mcpEndpoint:'http://127.0.0.1:1/mcp'})));
    expect(calls).toEqual([true,false,true]);
    expect(specs).toHaveLength(2);
    expect(specs[1]?.mcpToken).toBe(`li_job_${'a'.repeat(32)}`);
    expect(fakes[0]?.cancels).toBeGreaterThan(0);
    await bridge.shutdown();
  });

  it('fails with TURN_STALLED and resets the entry',async()=>{
    const {bridge,specs,fakes}=setup(()=>{});
    const events=await collect(bridge.runResident(job('job-1'),turnOptions({stallMs:60})));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'TURN_STALLED',message:'No CLI output for 0s.'});
    expect(bridge.hasResident('resident-1')).toBe(false);
    expect(fakes[0]?.cancels).toBeGreaterThan(0);
    expect(specs).toHaveLength(1);
    await bridge.shutdown();
  });

  it('kills the resident when cancel(jobId) is called',async()=>{
    const {bridge,fakes}=setup(()=>{});
    const running=collect(bridge.runResident(job('job-1'),turnOptions()));
    await until(()=>(fakes[0]?.writes.length??0)===1);
    await bridge.cancel('job-1');
    const events=await running;
    expect(events.at(-1)).toEqual({type:'cancelled'});
    expect(fakes[0]?.cancels).toBeGreaterThan(0);
    expect(bridge.hasResident('resident-1')).toBe(false);
    await bridge.shutdown();
  });

  it('resets the entry and reports logged out on an AUTH_REQUIRED result',async()=>{
    const {bridge,specs}=setup(fake=>{fake.line(assistant);fake.line({type:'result',is_error:true,result:'Invalid API key · Please run /login'});});
    const statuses:string[]=[];
    bridge.onAuthStatus(status=>statuses.push(status.status));
    const events=await collect(bridge.runResident(job('job-1'),turnOptions()));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'AUTH_REQUIRED'});
    expect(statuses).toContain('logged_out');
    expect(bridge.hasResident('resident-1')).toBe(false);
    await collect(bridge.runResident(job('job-2'),turnOptions()));
    expect(specs).toHaveLength(2);
    await bridge.shutdown();
  });

  it('makes a second job on the same key wait for the first turn',async()=>{
    const {bridge,specs,fakes}=setup(()=>{});
    const first=collect(bridge.runResident(job('job-1'),turnOptions()));
    await until(()=>(fakes[0]?.writes.length??0)===1);
    const second=collect(bridge.runResident(job('job-2'),turnOptions()));
    await new Promise(resolve=>setTimeout(resolve,150));
    expect(fakes[0]?.writes).toHaveLength(1);
    expect(specs).toHaveLength(1);
    answer(fakes[0]!);
    expect((await first).at(-1)?.type).toBe('completed');
    await until(()=>(fakes[0]?.writes.length??0)===2);
    answer(fakes[0]!);
    expect((await second).at(-1)?.type).toBe('completed');
    expect(specs).toHaveLength(1);
    await bridge.shutdown();
  });
});
