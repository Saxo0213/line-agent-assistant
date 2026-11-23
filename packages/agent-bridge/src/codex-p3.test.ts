import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {AgentEvent} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {codexArguments,codexResumeNotFound,isValidCodexModel} from './codex.js';
import type {ProcessSpec,RunningProcess} from './process-runner.js';
import {cleanup,request,temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});

const encoder=new TextEncoder();
/** A fake Codex process. With `hang`, stdout stays open until cancel(). */
function fakeChild(lines:unknown[],options:{stderr?:string;code?:number;hang?:boolean}={}):RunningProcess {
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const exitNow=Promise.resolve({code:options.code ?? 0,signal:null});
  return {
    stdout:(async function*(){for(const line of lines) yield encoder.encode(`${JSON.stringify(line)}\n`);if(options.hang) await gate;})(),
    stderr:(async function*(){if(options.stderr) yield encoder.encode(options.stderr);})(),
    exited:options.hang?gate.then(()=>({code:1,signal:null})):exitNow,
    async cancel(){release();},write(){},endInput(){},
  } as unknown as RunningProcess;
}
function bridge(child:RunningProcess,specs:ProcessSpec[]=[],extra:Record<string,unknown>={}) {
  return new AgentCliBridge({enabled:true,workspaceRoots:[root],
    resolver:{resolve:async()=>({file:'codex.exe',prefixArgs:[],version:'9.9.9',kind:'native' as const})},
    runner:{start(spec){specs.push(spec);return child;}},...extra});
}
async function collect(events:AsyncIterable<AgentEvent>) {const out:AgentEvent[]=[];for await(const event of events) out.push(event);return out;}
const message=(text:string)=>({type:'item.completed',item:{type:'agent_message',text}});
const validResume={validateResumeSession:async()=>({status:'valid' as const})};

describe('codexArguments order',()=>{
  const base=request('codex','C:\\ws');
  it('puts the fixed options first and ends with -',()=>{
    expect(codexArguments(base,'C:\\ws')).toEqual(['exec','--json','--skip-git-repo-check','--ignore-user-config','--sandbox','workspace-write','-']);
  });
  it('puts fresh images before --sandbox and the model after the sandbox options',()=>{
    expect(codexArguments({...base,model:' gpt-5.1 ',imagePaths:['C:\\ws\\a.png']},'C:\\ws')).toEqual(
      ['exec','--json','--skip-git-repo-check','--ignore-user-config','--image=C:\\ws\\a.png','--sandbox','workspace-write','-m','gpt-5.1','-']);
  });
  it('puts resume and its images last',()=>{
    expect(codexArguments({...base,model:'gpt-5.1',resumeSessionId:'t-1',imagePaths:['C:\\ws\\a.png']},'C:\\ws')).toEqual(
      ['exec','--json','--skip-git-repo-check','--ignore-user-config','--sandbox','workspace-write','-m','gpt-5.1','resume','t-1','--image=C:\\ws\\a.png','-']);
  });
});
describe('isValidCodexModel',()=>{
  it.each(['gpt-5.1','o3:high','openai/gpt-5','  gpt-5  '])('accepts %j',value=>expect(isValidCodexModel(value)).toBe(true));
  it.each(['','   ','Sonnet','OPUS','haiku','a b','gpt;5','x'.repeat(129)])('rejects %j',value=>expect(isValidCodexModel(value)).toBe(false));
});
describe('codexResumeNotFound',()=>{
  it.each(['Thread abc NOT FOUND','the thread does not exist','failed to load rollout x'])('matches %j',text=>expect(codexResumeNotFound(text)).toBe(true));
  it.each(['not found','thread started','rate limit'])('does not match %j',text=>expect(codexResumeNotFound(text)).toBe(false));
});
describe('Codex one-shot run',()=>{
  it('fails with INVALID_MODEL and starts nothing',async()=>{
    const specs:ProcessSpec[]=[];
    const events=await collect(bridge(fakeChild([]),specs).run(request('codex',root,{model:'sonnet'})));
    expect(events).toEqual([{type:'failed',code:'INVALID_MODEL',message:'The Codex model ID is not valid.',retryable:false}]);
    expect(specs).toHaveLength(0);
  });
  it('passes a valid model to the process',async()=>{
    const specs:ProcessSpec[]=[];
    await collect(bridge(fakeChild([message('hi'),{type:'turn.completed'}]),specs).run(request('codex',root,{model:'gpt-5.1'})));
    expect(specs[0]?.args).toEqual(expect.arrayContaining(['-m','gpt-5.1']));
    expect(specs[0]?.cwd).toBe(root);
  });
  it('maps a missing thread to RESUME_NOT_FOUND without the raw text',async()=>{
    const events=await collect(bridge(fakeChild([{type:'error',message:'thread 123 not found secret-detail'},{type:'turn.failed',error:{message:'thread 123 not found secret-detail'}}],{code:1}),[],validResume)
      .run(request('codex',root,{resumeSessionId:'t-1'})));
    expect(events.at(-1)).toEqual({type:'failed',code:'RESUME_NOT_FOUND',message:'The saved Codex thread was not found.',retryable:true,detail:'resume_not_found',hadToolActivity:false,hadEffectiveOutput:false});
  });
  it('maps a non-zero exit with the rollout error on stderr to RESUME_NOT_FOUND',async()=>{
    const events=await collect(bridge(fakeChild([],{stderr:'Error: failed to load rollout',code:1}),[],validResume).run(request('codex',root,{resumeSessionId:'t-1'})));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'RESUME_NOT_FOUND',retryable:true});
  });
  it('keeps other failures when there is no resume id',async()=>{
    const events=await collect(bridge(fakeChild([],{stderr:'thread not found',code:1})).run(request('codex',root)));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'CLI_EXIT'});
  });
  it('keeps received replies as a partial completion at the timeout',async()=>{
    const events=await collect(bridge(fakeChild([{type:'thread.started',thread_id:'t-1'},message(' first '),message('second')],{hang:true}),[]).run(request('codex',root),{timeoutMs:50}));
    expect(events.at(-1)).toEqual({type:'completed',finalText:'回覆逾時，保留已收到的內容：\n\nfirst\nsecond',partial:true});
  });
  it('fails with TIMEOUT at the timeout when no reply was received',async()=>{
    const events=await collect(bridge(fakeChild([{type:'thread.started',thread_id:'t-1'}],{hang:true}),[]).run(request('codex',root),{timeoutMs:50}));
    expect(events.at(-1)).toMatchObject({type:'failed',code:'TIMEOUT'});
  });
});
