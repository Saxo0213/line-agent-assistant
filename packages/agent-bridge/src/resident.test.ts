import {afterEach,describe,expect,it} from 'vitest';
import {ResidentHost,type ResidentTimers,type ResidentTurnEvent} from './resident.js';
import type {RunningProcess} from './process-runner.js';

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
  return {
    iterable,
    push(text:string) {queue.push(new TextEncoder().encode(text));wake?.();},
    end() {done=true;wake?.();},
  };
}
function fakeProcess() {
  const out=channel(),err=channel();
  let resolveExit!:(value:{code:number|null;signal:null})=>void;
  const exited=new Promise<{code:number|null;signal:null}>(resolve=>{resolveExit=resolve;});
  const writes:string[]=[];
  const state={cancels:0};
  const proc:RunningProcess={
    stdout:out.iterable,stderr:err.iterable,exited,
    cancel:async()=>{state.cancels++;out.end();err.end();resolveExit({code:null,signal:null});},
    write:(input:string)=>{writes.push(input);},
  };
  return {
    proc,writes,state,
    line(value:unknown) {out.push(JSON.stringify(value)+'\n');},
    stderr(text:string) {err.push(text);},
    exit(code=1) {out.end();err.end();resolveExit({code,signal:null});},
  };
}
type Fake=ReturnType<typeof fakeProcess>;
async function until(condition:()=>boolean,ms=3000) {
  const deadline=Date.now()+ms;
  while(!condition()) {
    if(Date.now()>deadline) throw new Error('Condition was not met in time');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
async function collect(generator:AsyncIterable<ResidentTurnEvent>) {
  const events:ResidentTurnEvent[]=[];
  for await(const event of generator) events.push(event);
  return events;
}
const request=(overrides:Partial<Parameters<ResidentHost['runTurn']>[0]>={})=>({
  key:'k',jobId:'job-1',message:'hello',timeoutMs:5000,stallMs:0,cancelled:()=>false,...overrides,
});
const assistant={type:'assistant',message:{content:[]}};
const ok=(text:string)=>({type:'result',is_error:false,result:text});
const endOf=(events:ResidentTurnEvent[])=>events.filter(event=>event.type==='end');
const linesOf=(events:ResidentTurnEvent[])=>events.filter(event=>event.type==='line').map(event=>(event as {value:{type:string;result?:string}}).value);

const hosts:ResidentHost[]=[];
function makeHost(options:ConstructorParameters<typeof ResidentHost>[0]={}) {
  const host=new ResidentHost(options);
  hosts.push(host);
  return host;
}
afterEach(()=>{for(const host of hosts.splice(0)) host.closeAll();});

describe('resident host turns',()=>{
  it('serves two turns with one process',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    let spawns=0;
    const spawn=()=>{spawns++;return fake.proc;};
    expect(host.ensure('k','h1',spawn,{cwd:'C:\\work'})).toEqual({fresh:true});
    const first=collect(host.runTurn(request()));
    await until(()=>fake.writes.length===1);
    fake.line({type:'system',session_id:'sess-1'});
    fake.line(assistant);
    fake.line(ok('one'));
    const firstEvents=await first;
    expect(host.ensure('k','h1',spawn)).toEqual({fresh:false});
    const second=collect(host.runTurn(request({jobId:'job-2',message:'again'})));
    await until(()=>fake.writes.length===2);
    fake.line(assistant);
    fake.line(ok('two'));
    const secondEvents=await second;
    expect(spawns).toBe(1);
    expect(JSON.parse(fake.writes[0]!)).toEqual({type:'user',message:{role:'user',content:'hello'}});
    expect(JSON.parse(fake.writes[1]!).message.content).toBe('again');
    expect(endOf(firstEvents)).toEqual([{type:'end',reason:'result'}]);
    expect(endOf(secondEvents)).toEqual([{type:'end',reason:'result'}]);
    expect(linesOf(secondEvents)).toHaveLength(2);
    expect(host.info('k')).toMatchObject({turnsCompleted:2,capturedSessionId:'sess-1',turnLocked:false,argsHash:'h1',cwd:'C:\\work'});
  });

  it('drops the lines of the fresh drain and keeps the lines of the turn',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const turn=collect(host.runTurn(request()));
    await new Promise(resolve=>setTimeout(resolve,20));
    fake.line(assistant);
    fake.line(ok('old'));
    await until(()=>fake.writes.length===1);
    fake.line(assistant);
    fake.line(ok('new'));
    const events=await turn;
    expect(linesOf(events).map(value=>value.result)).toEqual([undefined,'new']);
  });

  it('ignores a result before any turn activity, but accepts an error result',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const turn=collect(host.runTurn(request()));
    await until(()=>fake.writes.length===1);
    fake.line(ok('stale'));
    fake.line({type:'stream_event'});
    fake.line(ok('real'));
    const events=await turn;
    expect(linesOf(events).filter(value=>value.type==='result').map(value=>value.result)).toEqual(['real']);
    const failing=collect(host.runTurn(request({jobId:'job-2'})));
    await until(()=>fake.writes.length===2);
    fake.line({type:'result',is_error:true,result:'boom'});
    const failed=await failing;
    expect(endOf(failed)).toEqual([{type:'end',reason:'result'}]);
    expect(host.info('k')?.turnsCompleted).toBe(1);
  });

  it('ends a silent turn as stalled and keeps the process',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const events=await collect(host.runTurn(request({stallMs:60})));
    const end=events[0] as Extract<ResidentTurnEvent,{type:'end'}>;
    expect(events).toHaveLength(1);
    expect(end.reason).toBe('stalled');
    expect(end.stalledMs).toBeGreaterThanOrEqual(60);
    expect(host.has('k')).toBe(true);
    expect(host.info('k')?.turnLocked).toBe(false);
    expect(fake.state.cancels).toBe(0);
  });

  it('ends a turn at the deadline',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const events=await collect(host.runTurn(request({timeoutMs:80})));
    expect(events).toEqual([{type:'end',reason:'timeout'}]);
    expect(host.has('k')).toBe(true);
  });

  it('keeps the turn alive while a tool call is in flight',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const turn=collect(host.runTurn(request({stallMs:60})));
    await until(()=>fake.writes.length===1);
    host.noteToolActivity('job-1',1);
    expect(host.info('k')?.toolCallsInFlight).toBe(1);
    await new Promise(resolve=>setTimeout(resolve,250));
    expect(host.info('k')?.turnLocked).toBe(true);
    host.noteToolActivity('job-1',-1);
    const events=await turn;
    expect(endOf(events)).toEqual([expect.objectContaining({reason:'stalled'})]);
  });

  it('ends the turn and removes the entry when the process exits',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    const closed:string[]=[];
    host.onClosed(event=>closed.push(`${event.key}:${event.reason}`));
    host.ensure('k','h',()=>fake.proc);
    const turn=collect(host.runTurn(request()));
    await until(()=>fake.writes.length===1);
    fake.line(assistant);
    fake.stderr('Please run /login');
    fake.exit(1);
    const events=await turn;
    expect(events[events.length-1]).toEqual({type:'end',reason:'ended',stderrTail:'Please run /login'});
    expect(host.has('k')).toBe(false);
    expect(closed).toEqual(['k:ended']);
    expect(endOf(await collect(host.runTurn(request())))).toEqual([{type:'end',reason:'ended'}]);
  });

  it('removes an entry whose process exits between turns',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    fake.exit(0);
    await until(()=>!host.has('k'));
    expect(host.info('k')).toBeUndefined();
  });

  it('starts a new process when the argsHash changes',()=>{
    const host=makeHost();
    const fakes:Fake[]=[];
    const spawn=()=>{const fake=fakeProcess();fakes.push(fake);return fake.proc;};
    const closed:string[]=[];
    host.onClosed(event=>closed.push(event.reason));
    host.ensure('k','h1',spawn);
    expect(host.ensure('k','h2',spawn)).toEqual({fresh:true});
    expect(fakes).toHaveLength(2);
    expect(fakes[0]!.state.cancels).toBe(1);
    expect(closed).toEqual(['replaced']);
    expect(host.has('k')).toBe(true);
  });

  it('kills the process and removes the entry on cancel',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    let cancel=false;
    const turn=collect(host.runTurn(request({stallMs:10_000,cancelled:()=>cancel})));
    await until(()=>fake.writes.length===1);
    cancel=true;
    const events=await turn;
    expect(events).toEqual([{type:'end',reason:'cancelled'}]);
    expect(fake.state.cancels).toBe(1);
    expect(host.has('k')).toBe(false);
  });

  it('resets one entry and resets entries by predicate',()=>{
    const host=makeHost();
    const a=fakeProcess(),b=fakeProcess(),c=fakeProcess();
    host.ensure('a','h',()=>a.proc);
    host.ensure('b','h',()=>b.proc);
    host.ensure('c','h',()=>c.proc);
    host.reset('a');
    expect(host.resetWhere(key=>key==='b')).toBe(1);
    expect([host.has('a'),host.has('b'),host.has('c')]).toEqual([false,false,true]);
    expect([a.state.cancels,b.state.cancels,c.state.cancels]).toEqual([1,1,0]);
    host.closeAll();
    expect(c.state.cancels).toBe(1);
  });

  it('unlocks the entry when the consumer returns early',async()=>{
    const host=makeHost();
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const generator=host.runTurn(request());
    const pending=generator.next();
    await until(()=>fake.writes.length===1);
    fake.line(assistant);
    await pending;
    await generator.return(undefined);
    expect(host.info('k')?.turnLocked).toBe(false);
  });

  it('gives each line to the sink hook, also between turns',async()=>{
    const seen:boolean[]=[];
    const host=makeHost({onLine:signal=>{seen.push(signal.syncActive);}});
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    fake.line({type:'user'});
    await until(()=>seen.length===1);
    expect(seen).toEqual([false]);
  });
});

describe('resident reaper',()=>{
  function fakeTimers() {
    const state:{interval?:{callback:()=>void;ms:number};cleared:number}={cleared:0};
    const timers:ResidentTimers={
      setTimeout:(callback,ms)=>setTimeout(callback,ms),
      clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval:(callback,ms)=>{state.interval={callback,ms};return 'interval';},
      clearInterval:()=>{state.cleared++;},
    };
    return {state,timers};
  }

  it('clamps the scan interval and the idle limit',()=>{
    expect(new ResidentHost({idleMs:1}).reapIntervalMs).toBe(30_000);
    expect(new ResidentHost({}).reapIntervalMs).toBe(150_000);
    expect(new ResidentHost({idleMs:3_600_000}).reapIntervalMs).toBe(300_000);
  });

  it('skips a locked entry and reaps an idle entry',async()=>{
    let time=0;
    const {state,timers}=fakeTimers();
    const host=makeHost({idleMs:60_000,now:()=>time,timers});
    const reaped:unknown[]=[];
    const closed:string[]=[];
    host.onReaped(event=>reaped.push(event));
    host.onClosed(event=>closed.push(event.reason));
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc,{cwd:'C:\\work'});
    expect(state.interval?.ms).toBe(30_000);
    const turn=collect(host.runTurn(request({timeoutMs:100_000_000})));
    await until(()=>fake.writes.length===1);
    time=1_000_000;
    state.interval!.callback();
    expect(host.has('k')).toBe(true);
    fake.line({type:'system',session_id:'sess-9'});
    fake.line(assistant);
    fake.line(ok('done'));
    await turn;
    time=1_030_000;
    state.interval!.callback();
    expect(host.has('k')).toBe(true);
    time=1_070_000;
    state.interval!.callback();
    expect(host.has('k')).toBe(false);
    expect(reaped).toEqual([{key:'k',turnsCompleted:1,capturedSessionId:'sess-9',cwd:'C:\\work'}]);
    expect(closed).toEqual(['idle']);
    expect(fake.state.cancels).toBe(1);
    host.closeAll();
    expect(state.cleared).toBe(1);
  });
});

describe('resident autonomous relay',()=>{
  const notification={type:'user',origin:{kind:'task-notification'},message:{content:'<task-notification>done</task-notification>'}};
  it('emits a result between turns once, and never a result of a turn',async()=>{
    let time=0;
    const host=makeHost({now:()=>time});
    const replies:{key:string;texts:string[]}[]=[];
    host.onAutonomous(event=>replies.push(event));
    host.setRelayTarget(()=>true);
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    const turn=collect(host.runTurn(request({timeoutMs:100_000})));
    await until(()=>fake.writes.length===1);
    fake.line(assistant);
    fake.line(ok('[10:00] turn reply'));
    await turn;
    host.relayScan();
    expect(replies).toEqual([]);
    time=10_000;
    fake.line(notification);
    fake.line(assistant);
    fake.line(ok('[10:05] background done'));
    await until(()=>host.info('k')!==undefined&&(host as unknown as {entries:Map<string,{resultSeq:number}>}).entries.get('k')!.resultSeq===2);
    host.relayScan();
    host.relayScan();
    expect(replies).toEqual([{key:'k',texts:['background done']}]);
  });

  it('does not emit a result inside the spawn grace, and moves the mark without a target',async()=>{
    const host=makeHost({now:()=>0});
    const replies:unknown[]=[];
    host.onAutonomous(event=>replies.push(event));
    host.setRelayTarget(()=>false);
    const fake=fakeProcess();
    host.ensure('k','h',()=>fake.proc);
    fake.line(assistant);
    fake.line(ok('early'));
    await until(()=>(host as unknown as {entries:Map<string,{resultSeq:number}>}).entries.get('k')!.resultSeq===1);
    host.relayScan();
    expect(replies).toEqual([]);
  });
});

describe('resident capacity',()=>{
  function spawnAt(host:ResidentHost,key:string) {
    const fake=fakeProcess();
    host.ensure(key,'h',()=>fake.proc);
    return fake;
  }
  it('reaps the idle entry with the oldest activity when a new key spawns at the limit',()=>{
    let time=1000;
    const host=makeHost({maxResidents:2,now:()=>time});
    const reaped:string[]=[],closed:Array<{key:string;reason:string}>=[];
    host.onReaped(event=>reaped.push(event.key));
    host.onClosed(event=>closed.push(event));
    const a=spawnAt(host,'a');
    time=2000;
    spawnAt(host,'b');
    time=3000;
    spawnAt(host,'c');
    expect(host.has('a')).toBe(false);
    expect(host.has('b')&&host.has('c')).toBe(true);
    expect(a.state.cancels).toBe(1);
    expect(reaped).toEqual(['a']);
    expect(closed).toEqual([{key:'a',reason:'idle'}]);
  });
  it('gives the reaped event the CLAUDE_CONFIG_DIR of the resident, and omits it for a default resident',()=>{
    const host=makeHost({maxResidents:1});
    const reaped:Array<{key:string;claudeConfigDir?:string}>=[];
    host.onReaped(event=>reaped.push(event));
    host.ensure('a','h',()=>fakeProcess().proc,{claudeConfigDir:'C:\accounts\acct-aaaaaaaaaa'});
    host.ensure('b','h',()=>fakeProcess().proc);
    host.ensure('c','h',()=>fakeProcess().proc);
    expect(reaped[0]).toMatchObject({key:'a',claudeConfigDir:'C:\accounts\acct-aaaaaaaaaa'});
    expect(reaped[1]?.key).toBe('b');
    expect('claudeConfigDir' in (reaped[1] ?? {})).toBe(false);
  });
  it('skips a locked entry and reaps a younger idle one',async()=>{
    let time=1000;
    const host=makeHost({maxResidents:2,now:()=>time});
    spawnAt(host,'a');
    time=2000;
    spawnAt(host,'b');
    const release=await host.lockKey('a');
    time=3000;
    spawnAt(host,'c');
    expect(host.has('a')).toBe(true);
    expect(host.has('b')).toBe(false);
    expect(host.has('c')).toBe(true);
    release();
  });
  it('still spawns and calls the capacity listener when no entry can be reaped',async()=>{
    const host=makeHost({maxResidents:1});
    const events:unknown[]=[];
    host.onCapacityExceeded(event=>events.push(event));
    spawnAt(host,'a');
    const release=await host.lockKey('a');
    const fake=spawnAt(host,'b');
    expect(host.has('a')&&host.has('b')).toBe(true);
    expect(fake.state.cancels).toBe(0);
    expect(events).toEqual([{key:'b',live:1,max:1}]);
    release();
  });
});
