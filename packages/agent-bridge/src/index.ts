import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {readFile,realpath, stat} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {AgentRunRequestSchema, PROVIDER_TOOLS_UNSUPPORTED, PROVIDER_TOOLS_UNSUPPORTED_MESSAGE, type AgentEvent,type AgentProvider,type AgentRunRequest,type ResumeSessionValidationResult} from '@line-agent/contracts';
import {AuthController,type AuthStatus} from './auth.js';
import {accountCredentialFile} from './account-directory.js';
import {accountEnvironment,buildChildEnvironment,CLAUDE_GIT_BASH_PATH_ENV,gitBashPath,type AccountEnv,type AccountRef} from './child-environment.js';
import {claudeArguments,ClaudeEvents,claudeResidentArguments} from './claude.js';
import {codexArguments,codexResumeNotFound,CodexEvents,isValidCodexModel} from './codex.js';
import {extensionEnvironment} from './extensions.js';
import {claudeJudgeArguments,codexJudgeArguments,judgeInput,JUDGE_DEFAULT_TIMEOUT_MS,type JudgeRequest,type JudgeResult} from './judge.js';
import {isAuthenticationDiagnostic} from './failure.js';
export {providerFailureResetAt} from './failure.js';
export {isValidCodexModel} from './codex.js';
import {isWithin,WindowsExecutableResolver,type ExecutableResolver,type ResolvedExecutable} from './executable-resolver.js';
import {parseJsonl} from './jsonl.js';
import {NodeProcessRunner,type ProcessRunner,type RunningProcess} from './process-runner.js';
import {ResidentHost,type ResidentAutonomousReply,type ResidentCapacityExceeded,type ResidentCloseReason,type ResidentReaped,type ResidentTurnEvent} from './resident.js';
import {redactSensitive} from './redact.js';
import {spillClaudeArguments} from './spill.js';

/** Default limit of resident Claude processes (the internal MCP slot count 8, less 3 slots kept for one-shot jobs). */
export const DEFAULT_MAX_RESIDENTS=5;

export interface BridgeOptions {
  enabled?:boolean;
  workspaceRoots?:readonly string[];
  resolveWorkspaceRoots?:()=>Promise<readonly string[]>;
  resolver?:ExecutableResolver;
  runner?:ProcessRunner;
  environment?:NodeJS.ProcessEnv;
  /** Must check provider/source/generation against persisted Main-owned session state. */
  validateResumeSession?:(request:AgentRunRequest)=>Promise<ResumeSessionValidationResult>;
  /** When set, long Claude arguments (system prompt, agents, MCP config, settings) are written to files here and the arguments keep only the paths. */
  spillDirectory?:string;
  /** Idle time before a resident Claude process is reaped (ms). The host keeps at least 60 s. */
  residentIdleMs?:number;
  /** Most resident Claude processes at one time. Default 5. A spawn at the limit reaps the idle one with the oldest activity. */
  maxResidents?:number;
  /** Root of the managed account directories (userData/llm-accounts). A managed account source needs it. */
  accountsDirectory?:string;
}
/** Options of one resident Claude turn. */
export interface ResidentTurnOptions {
  /** Resident key. One process serves all turns of one key. */
  key:string;
  /** Appended to the Claude system prompt. Part of the arguments hash. */
  systemPrompt?:string;
  /** Claude model. The default is opus. */
  model?:string;
  /** Internal MCP URL. null: the process has no internal MCP. */
  mcpEndpoint:string|null;
  /** Called under the key lock. fresh=true: a new process starts; return its token. fresh=false: the process lives; return 'rebound', or null when it cannot be rebound (the process is then replaced). */
  bindMcp:(fresh:boolean)=>{token:string}|'rebound'|null;
  timeoutMs:number;
  /** 0 = stall check off. */
  stallMs:number;
}
interface JobSlot {job?:Job;jobId?:string}
type Prepared=
  |{ok:false;event:AgentEvent}
  |{ok:true;job:Job;request:AgentRunRequest;workspace:string;executionRequest:AgentRunRequest;executable:ResolvedExecutable;accountEnv:AccountEnv};

/** SHA-256 of the arguments without the resume pair, the workspace, the Git Bash path, a digest of the extension environment values and the account environment (a source change replaces the process). No executable path, no MCP token. */
function residentArgsHash(args:readonly string[],resumeSessionId:string|undefined,workspace:string,gitBash:string,extensionEnv:Record<string,string>,accountEnv:AccountEnv={}):string {
  const finalArgs=[...args];
  const at=resumeSessionId===undefined?-1:finalArgs.findIndex((value,index)=>value==='--resume'&&finalArgs[index+1]===resumeSessionId);
  if(at>=0) finalArgs.splice(at,2);
  const extensionDigest=createHash('sha256').update(JSON.stringify(Object.entries(extensionEnv).sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
  return createHash('sha256').update(JSON.stringify([finalArgs,workspace,gitBash,extensionDigest,accountEnv])).digest('hex');
}
interface Job {residentKey?:string; cancelled:boolean; cancellationFailed?:boolean; child?:RunningProcess; launchSettled:Promise<void>; finishLaunch():void}
const failed=(code:string,message:string):AgentEvent=>({type:'failed',code,message,retryable:false});

async function claudeOAuthToken(env:NodeJS.ProcessEnv,configDir?:string):Promise<string> {
  const home=env.USERPROFILE ?? env.HOME;
  if(!configDir && !home) throw new Error('Claude OAuth credentials are unavailable');
  const file=join(configDir ?? join(home as string,'.claude'),accountCredentialFile('claude'));
  const data=JSON.parse(await readFile(file,'utf8')) as Record<string,unknown>;
  const oauth=(data.claudeAiOauth ?? data.claude_ai_oauth) as Record<string,unknown>|undefined;
  const token=oauth?.accessToken ?? oauth?.access_token;
  if(typeof token!=='string'||!token) throw new Error('Claude OAuth credentials are unavailable');
  return token;
}

/** Main/background only. Enabled by default; LINE services do not depend on it. */
export class AgentCliBridge {
  private readonly runner:ProcessRunner;
  private readonly resolver:ExecutableResolver;
  private readonly auth:AuthController;
  private readonly jobs=new Map<string,Job>();
  private closing=false;
  private shutdownPromise:Promise<void>|undefined;
  private readonly children=new Set<RunningProcess>();
  private readonly operations=new Set<Promise<unknown>>();
  private readonly authStatusListeners=new Set<(status:AuthStatus)=>void>();
  private readonly host:ResidentHost;
  constructor(private readonly options:BridgeOptions) {
    this.host=new ResidentHost({maxResidents:options.maxResidents??DEFAULT_MAX_RESIDENTS,...(options.residentIdleMs===undefined?{}:{idleMs:options.residentIdleMs})});
    const runner=options.runner ?? new NodeProcessRunner();
    this.runner={start:(spec)=>{
      if(this.closing) throw new Error('Agent bridge is closing');
      const child=runner.start(spec);
      this.children.add(child);
      void child.exited.then(()=>this.children.delete(child),()=>undefined);
      return child;
    }};
    this.resolver=options.resolver ?? new WindowsExecutableResolver({runner:this.runner,...(options.environment?{environment:options.environment}:{})});
    this.auth=new AuthController({runner:this.runner,resolver:this.resolver,...(options.environment?{environment:options.environment}:{}),...(options.accountsDirectory?{accountsDirectory:options.accountsDirectory}:{})});
  }
  /**
   * Account environment of a source, and the login-file check of a managed source (stat only, the file is never read).
   * `signedIn=false` means a managed source without its login file, or without an accounts directory.
   */
  private async accountLaunch(provider:AgentProvider,account:AccountRef|undefined):Promise<{signedIn:boolean;accountEnv:AccountEnv}> {
    try {
      const accountEnv=accountEnvironment(provider,account,this.options.accountsDirectory,this.options.environment ?? process.env);
      if(account?.kind!=='managed') return {signedIn:true,accountEnv};
      const home=provider==='claude'?accountEnv.CLAUDE_CONFIG_DIR:accountEnv.CODEX_HOME;
      const signedIn=home!==undefined && await stat(join(home,accountCredentialFile(provider))).then(facts=>facts.isFile(),()=>false);
      return {signedIn,accountEnv};
    } catch {return {signedIn:false,accountEnv:{}};}
  }
  /** Apply the argument spill to Claude arguments, only when `spillDirectory` is set. */
  private spillClaude(args:string[]):string[] {
    return this.options.spillDirectory?spillClaudeArguments(args,this.options.spillDirectory):args;
  }
  /** Git Bash path for the Claude child only. The child environment filter removes CLAUDE_* variables, so it goes through `extraEnv`. */
  private claudeGitBashEnvironment():Record<string,string> {
    const path=gitBashPath(this.options.environment ?? process.env,candidate=>{try {return statSync(candidate).isFile();} catch {return false;}});
    return path?{[CLAUDE_GIT_BASH_PATH_ENV]:path}:{};
  }
  onAuthStatus(listener:(status:AuthStatus)=>void):()=>void {
    this.authStatusListeners.add(listener);
    return ()=>this.authStatusListeners.delete(listener);
  }
  private reportAuthStatus(status:AuthStatus):void {
    for(const listener of this.authStatusListeners) { try { listener(status); } catch { /* Health observers must not affect agent execution. */ } }
  }
  private reportLoggedOut(provider:AgentProvider,sourceId?:string):void {
    const {isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
    this.reportAuthStatus({provider,installed:true,status:'logged_out',isolatedOverrideNames,...(sourceId===undefined?{}:{sourceId}),detail:'The CLI reported that authentication is required.'});
  }
  private operation<T>(work:()=>Promise<T>):Promise<T> {
    if(this.closing) return Promise.reject(new Error('Agent bridge is closing'));
    const operation=Promise.resolve().then(work);
    this.operations.add(operation);
    void operation.then(()=>this.operations.delete(operation),()=>this.operations.delete(operation));
    return operation;
  }
  getAuthStatus(provider:AgentProvider,account?:AccountRef) {return this.agentRefreshStatus(provider,account);}
  agentRefreshStatus(provider:AgentProvider,account?:AccountRef) {return this.operation(async()=>{
    const status=await this.auth.getAuthStatus(provider,account);
    this.reportAuthStatus(status);
    return status;
  });}
  /** Read quota through the same executable resolver and isolated identity used by Agent runs. */
  queryQuota(provider:AgentProvider,account?:AccountRef) {return this.operation(async()=>{
    const {env}=buildChildEnvironment(this.options.environment ?? process.env);
    const {accountEnv}=await this.accountLaunch(provider,account);
    if(provider==='claude') {
      try {
        const token=await claudeOAuthToken(env,accountEnv.CLAUDE_CONFIG_DIR);
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),12_000);
        try {
          const response=await fetch('https://api.anthropic.com/api/oauth/usage',{
            headers:{authorization:`Bearer ${token}`,'anthropic-beta':'oauth-2025-04-20'},signal:controller.signal,
          });
          if(!response.ok) throw new Error(`Anthropic usage API returned HTTP ${response.status}`);
          return await response.json();
        } finally {clearTimeout(timer);}
      } catch(error) {
        if(error instanceof Error && /^Anthropic usage API returned HTTP \d+$/.test(error.message)) throw error;
        throw new Error('Anthropic OAuth usage query failed');
      }
    }
    const executable=await this.resolver.resolve('codex');
    if(!executable) throw new Error('Codex CLI is unavailable');
    // CliTalkAgent: no auth.json in the source home means no app-server query.
    const codexHome=accountEnv.CODEX_HOME;
    if(codexHome===undefined || !await stat(join(codexHome,accountCredentialFile('codex'))).then(facts=>facts.isFile(),()=>false)) throw new Error('Codex CLI is not signed in');
    const child=this.runner.start({file:executable.file,args:[...executable.prefixArgs,'app-server','--listen','stdio://'],env,keepStdinOpen:true,accountEnv});
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;void child.cancel().catch(()=>undefined);},12_000);
    const stderrDrain=(async()=>{let size=0;for await(const chunk of child.stderr){size+=chunk.byteLength;if(size>64_000) break;}})();
    const iterator=child.stdout[Symbol.asyncIterator]();let buffer='';let total=0;
    const nextLine=async():Promise<string|null>=>{for(;;){const newline=buffer.indexOf('\n');if(newline>=0){const line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);return line;}
      const next=await iterator.next();if(next.done){if(!buffer)return null;const finalLine=buffer;buffer='';return finalLine;}const chunk=Buffer.from(next.value).toString('utf8');total+=chunk.length;
      if(total>256_000)throw new Error('Codex app-server response exceeded the limit');buffer+=chunk;}};
    const responseFor=async(id:number):Promise<Record<string,unknown>>=>{for(;;){const line=await nextLine();if(line===null)throw new Error('Codex app-server exited before returning rate limits');
      if(!line.trim())continue;let message:Record<string,unknown>;try{message=JSON.parse(line) as Record<string,unknown>;}catch{continue;}
      if(message.id===id){if(message.error)throw new Error(id===1?'Codex app-server initialization failed':'Codex app-server could not read rate limits');
        return message;}}};
    try {
      child.write?.('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"linejs","version":"1.0.0"},"capabilities":null}}\n');
      await responseFor(1);
      child.write?.('{"method":"initialized"}\n{"id":2,"method":"account/rateLimits/read"}\n');
      const message=await responseFor(2);
      child.endInput?.();
      const exit=await child.exited;
      if(timedOut) throw new Error('Codex app-server query timed out');
      if(exit.code!==0) throw new Error('Codex app-server exited before returning rate limits');
      void stderrDrain.catch(()=>undefined);
      return message.result;
    } catch(error) {
      if(timedOut) throw new Error('Codex app-server query timed out');
      if(error instanceof Error && /^(Codex app-server (?:initialization failed|could not read rate limits|response exceeded the limit|exited before returning rate limits))$/.test(error.message)) throw error;
      throw new Error('Codex app-server rate limit query failed');
    } finally {clearTimeout(timer);await child.cancel().catch(()=>undefined);}
  });}
  openLogin(provider:AgentProvider,account?:AccountRef) {return this.operation(()=>this.auth.openLogin(provider,account));}
  logout(provider:AgentProvider,account?:AccountRef) {return this.operation(()=>this.auth.logout(provider,account));}
  health(provider:AgentProvider) {return this.operation(async()=>{
    try {
      const exe=await this.resolver.resolve(provider);
      if(!exe) return {provider,installed:false,detail:'Install the official CLI in a trusted installation directory.'};
      return {provider,installed:true,executable:basename(exe.file),kind:exe.kind,version:exe.version};
    } catch {return {provider,installed:false,detail:'Unable to inspect the official CLI.'};}
  });}
  async cancel(jobId:string):Promise<void> {
    const job=this.jobs.get(jobId);
    if(!job) return;
    job.cancelled=true;
    // A resident job owns its entry only after it took the key lock; the entry is removed, then the process exit is awaited.
    if(job.residentKey!==undefined) this.host.reset(job.residentKey);
    try {
      await job.child?.cancel();
      if(job.residentKey!==undefined) await job.child?.exited;
    }
    catch {job.cancellationFailed=true;throw new Error('Unable to confirm job termination.');}
  }
  /** Change the resident settings after the bridge exists (the idle time of the reaper). */
  configureResidents(options:{idleMs?:number}):void {if(options.idleMs!==undefined) this.host.setIdleMs(options.idleMs);}
  hasResident(key:string):boolean {return this.host.has(key);}
  /** Kill and remove each resident that the predicate accepts. Returns the number of residents. */
  resetResidents(predicate:(key:string)=>boolean):number {return this.host.resetWhere(key=>predicate(key));}
  /** Mark each accepted resident stale; a resident without a running turn or key lock is removed now. Returns the number of residents. */
  markResidentsStale(predicate:(key:string)=>boolean):number {return this.host.markStaleWhere(key=>predicate(key));}
  /** Change the tool call counter of the resident turn of this job. A counter above 0 keeps the turn alive. */
  noteToolActivity(jobId:string,delta:1|-1):void {this.host.noteToolActivity(jobId,delta);}
  onResidentClosed(listener:(event:{key:string;reason:ResidentCloseReason})=>void):()=>void {return this.host.onClosed(listener);}
  /** Listener for a resident spawn at the limit when each live resident is busy. The spawn still happens. */
  onResidentCapacityExceeded(listener:(event:ResidentCapacityExceeded)=>void):()=>void {return this.host.onCapacityExceeded(listener);}
  onResidentReaped(listener:(event:ResidentReaped)=>void):()=>void {return this.host.onReaped(listener);}
  /** Listener for the result of a turn that no LINEJS job started (a background sub-agent finished). The texts are ready to deliver. */
  onAutonomousReply(listener:(event:ResidentAutonomousReply)=>void):()=>void {return this.host.onAutonomous(listener);}
  /** Set the check that tells if a resident key has a chat to deliver to. Without a target, an autonomous result is dropped. */
  setRelayTarget(hasTarget:(key:string)=>boolean):void {this.host.setRelayTarget(hasTarget);}
  /**
   * One tool-less, read-only fast-model turn for the group free-mode judge. Reuses the trusted executable resolver, child environment
   * and process runner of normal jobs. Resolves with the final text and the provider session id; every failure (disabled, closing,
   * not installed, timeout, non-zero exit, bad output) rejects so the caller can treat it as "do not reply".
   */
  async judge(input:JudgeRequest):Promise<JudgeResult> {
    if(this.closing) throw new Error('Agent bridge is closing');
    if(this.options.enabled===false) throw new Error('Agent support is disabled');
    if(input.resumeSessionId!==undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(input.resumeSessionId)) throw new Error('Invalid judge session');
    const workspace=await realpath(input.workspacePath);
    if(!(await stat(workspace)).isDirectory()) throw new Error('Judge workspace is not a directory');
    const executable=await this.resolver.resolve(input.provider);
    if(!executable) throw new Error('The official CLI is unavailable');
    const launch=await this.accountLaunch(input.provider,input.account);
    if(!launch.signedIn) throw new Error('The CLI account is not signed in');
    const {env}=buildChildEnvironment(this.options.environment ?? process.env);
    const child=this.runner.start({file:executable.file,
      args:[...executable.prefixArgs,...(input.provider==='codex'?codexJudgeArguments(input,workspace):claudeJudgeArguments(input))],
      cwd:workspace,input:judgeInput(input),env,...(Object.keys(launch.accountEnv).length?{accountEnv:launch.accountEnv}:{})});
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;void child.cancel().catch(()=>{});},input.timeoutMs ?? JUDGE_DEFAULT_TIMEOUT_MS);
    const stderr=(async()=>{let length=0;for await(const chunk of child.stderr) length+=chunk.byteLength;})().catch(()=>undefined);
    const parser=input.provider==='codex'?new CodexEvents():new ClaudeEvents();
    let sessionId:string|undefined,finalText:string|undefined,failure:string|undefined;
    try {
      for await(const value of parseJsonl(child.stdout)) {
        for(const event of parser.accept(value)) {
          if(event.type==='started') sessionId=event.externalSessionId;
          else if(event.type==='completed') finalText=event.finalText;
          else if(event.type==='failed') failure=event.message;
        }
      }
      const exit=await child.exited;
      await stderr;
      if(timedOut) throw new Error('Judge timed out');
      if(failure!==undefined) throw new Error(`Judge failed: ${failure}`);
      if(exit.code!==0) throw new Error('Judge CLI exited unsuccessfully');
      if(finalText===undefined || sessionId===undefined) throw new Error('Judge produced no answer');
      return {text:finalText,sessionId};
    } finally {
      clearTimeout(timer);
      await child.cancel().catch(()=>{});
      await child.exited.catch(()=>undefined);
    }
  }
  shutdown():Promise<void> {
    this.closing=true;
    return this.shutdownPromise ??= (async()=>{
      // Stops the reaper and kills the resident processes first.
      this.host.closeAll();
      for(const job of this.jobs.values()) job.cancelled=true;
      const jobs=[...this.jobs.values()];
      const owned=[...this.children];
      const cancellations=await Promise.allSettled(owned.map(child=>child.cancel()));
      await Promise.all(owned.map(child=>child.exited));
      await Promise.allSettled([...this.operations]);
      // Consumers may pause an async iterator after started; process exit, not
      // consumer iteration, is the shutdown boundary. Pre-spawn awaits must drain.
      await Promise.all(jobs.map(job=>job.launchSettled));
      this.authStatusListeners.clear();
      const errors=cancellations.filter(result=>result.status==='rejected').map(result=>(result as PromiseRejectedResult).reason);
      if(errors.length) throw new AggregateError(errors,'Agent process shutdown failed');
    })();
  }

  /**
   * Shared validation of run() and runResident(): closing, enabled, schema, provider checks, DUPLICATE_JOB, workspace roots,
   * attachments, resume validation and executable resolve. It registers the job in `jobs` and puts it in `slot`
   * (also when it throws later), so the caller always cleans up through `slot`.
   */
  private async prepare(input:AgentRunRequest,slot:JobSlot,onlyProvider?:AgentProvider):Promise<Prepared> {
    if(this.closing) return {ok:false,event:failed('AGENT_CLOSING','Agent bridge is closing.')};
    if(this.options.enabled === false) return {ok:false,event:failed('AGENT_DISABLED','Agent support is disabled.')};
    const parsed=AgentRunRequestSchema.safeParse(input);
    if(!parsed.success) return {ok:false,event:failed('INVALID_REQUEST','Invalid agent request.')};
    const request=parsed.data;
    if(onlyProvider!==undefined && request.provider!==onlyProvider) return {ok:false,event:failed('INVALID_REQUEST','Invalid agent request.')};
    // Codex cannot confine its shell/file tools, so a job without the local tools permission fails closed.
    if(request.provider==='codex' && !request.tools.localTools) return {ok:false,event:failed(PROVIDER_TOOLS_UNSUPPORTED,PROVIDER_TOOLS_UNSUPPORTED_MESSAGE)};
    // Same rule as CliTalkAgent: a Codex model ID that is not valid does not start a run. A Claude one-shot run ignores `model`.
    if(request.provider==='codex' && request.model!==undefined && !isValidCodexModel(request.model)) return {ok:false,event:{type:'failed',code:'INVALID_MODEL',message:'The Codex model ID is not valid.',retryable:false}};
    if(this.jobs.has(request.jobId)) return {ok:false,event:failed('DUPLICATE_JOB','This job is already active.')};
    let finish!:()=>void;
    const done=new Promise<void>(resolve=>{finish=resolve;});
    const job:Job={cancelled:false,launchSettled:done,finishLaunch:finish}; this.jobs.set(request.jobId,job);
    slot.job=job;slot.jobId=request.jobId;
    let workspace:string;
    let roots:string[];
    try {
      const selectedRoots=this.options.resolveWorkspaceRoots ? await this.options.resolveWorkspaceRoots() : this.options.workspaceRoots ?? [];
      roots=await Promise.all(selectedRoots.map(root=>realpath(root)));
      workspace=await realpath(request.workspacePath);
      if(!roots.some(root=>isWithin(root,workspace)) || !(await stat(workspace)).isDirectory()) throw new Error();
    } catch {return {ok:false,event:failed('INVALID_WORKSPACE','Select a workspace inside the configured roots.')};}
    // Image files are validated like the workspace: inside the configured roots and an existing regular file.
    const imagePaths:string[]=[];
    try {
      if(request.provider==='codex') for(const candidate of request.imagePaths ?? []) {
        const image=await realpath(candidate);
        if(!roots.some(root=>isWithin(root,image)) || !(await stat(image)).isFile()) throw new Error();
        imagePaths.push(image);
      }
    } catch {return {ok:false,event:failed('ATTACHMENT_MISSING','An attached image is missing or outside the workspace.')};}
    let executionRequest:AgentRunRequest=imagePaths.length?{...request,imagePaths}:request;
    if(request.resumeSessionId) {
      const validation=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(request.resumeSessionId)
        ? await this.options.validateResumeSession?.({...request,workspacePath:workspace}) ?? {status:'invalid' as const}
        : {status:'invalid' as const};
      if(validation.status==='invalid') return {ok:false,event:failed('INVALID_SESSION','Resume requires a validated stored session.')};
      if(validation.status==='workspace_mismatch') {
        const {resumeSessionId:_,...freshRequest}=request;
        executionRequest=freshRequest;
      }
    }
    // A managed account without its login file fails before any process starts (the file is only stat-ed).
    const launch=await this.accountLaunch(request.provider,request.account);
    if(!launch.signedIn) return {ok:false,event:{type:'failed',code:'ACCOUNT_NOT_LOGGED_IN',message:'The CLI account is not signed in.',retryable:false}};
    const executable=await this.resolver.resolve(request.provider);
    if(!executable) return {ok:false,event:failed('NOT_INSTALLED','The official CLI is unavailable.')};
    if(job.cancelled) return {ok:false,event:{type:'cancelled'}};
    return {ok:true,job,request,workspace,executionRequest,executable,accountEnv:launch.accountEnv};
  }
  /** Release the job slot of run() and runResident(). */
  private releaseJob(slot:JobSlot):void {
    if(slot.job===undefined || slot.jobId===undefined) return;
    this.jobs.delete(slot.jobId);
    slot.job.finishLaunch();
  }

  async *run(input:AgentRunRequest,runOptions?:{timeoutMs?:number}):AsyncIterable<AgentEvent> {
    const slot:JobSlot={};
    try {
      const prepared=await this.prepare(input,slot);
      if(!prepared.ok) {yield prepared.event;return;}
      const {job,request,workspace,executionRequest,executable,accountEnv}=prepared;
      const {env}=buildChildEnvironment(this.options.environment ?? process.env);
      const child=this.runner.start({
        ...(Object.keys(accountEnv).length?{accountEnv}:{}),
        file:executable.file, args:[...executable.prefixArgs,...(executionRequest.provider==='codex'?codexArguments(executionRequest,workspace):this.spillClaude(claudeArguments(executionRequest)))],
        cwd:workspace, input:request.prompt, env, ...(executionRequest.mcp?{mcpToken:executionRequest.mcp.token}:{}),
        ...(()=>{
          const extraEnv={...(executionRequest.extensions?extensionEnvironment(executionRequest):{}),...(executionRequest.provider==='claude'?this.claudeGitBashEnvironment():{})};
          return Object.keys(extraEnv).length?{extraEnv}:{};
        })(),
      }); job.child=child;job.finishLaunch();
      // Drain bounded diagnostics concurrently so stderr cannot deadlock stdout.
      const diagnostics=(async()=>{
        const chunks:Buffer[]=[];let length=0;
        for await(const chunk of child.stderr) {length+=chunk.byteLength;if(length<=64*1024) chunks.push(Buffer.from(chunk));}
        return length>64*1024?'CLI diagnostics exceeded their size limit.':redactSensitive(Buffer.concat(chunks).toString('utf8')).slice(0,2000).trim();
      })();
      // Observe failures immediately, even while stdout is idle or the consumer pauses.
      void diagnostics.catch(()=>{void child.cancel().catch(()=>{});});
      const parser=request.provider==='codex'?new CodexEvents():new ClaudeEvents();
      let terminal:AgentEvent|undefined;
      let timedOut=false;
      const timer=request.provider==='codex' && runOptions?.timeoutMs!==undefined
        ?setTimeout(()=>{timedOut=true;void child.cancel().catch(()=>{});},runOptions.timeoutMs):undefined;
      /** CliTalkAgent: a timeout keeps the replies already received. Without any reply it is a TIMEOUT failure. */
      const timeoutEvent=():AgentEvent=>{
        const text=parser instanceof CodexEvents?parser.messageText:'';
        return text?{type:'completed',finalText:`回覆逾時，保留已收到的內容：\n\n${text}`,partial:true}:failed('TIMEOUT','The CLI did not finish in time.');
      };
      // CliTalkAgent should_retry_without_resume: the saved Codex thread is gone. The raw text is only tested, never shown.
      const resumeFix=(event:AgentEvent,diagnostic:string):AgentEvent=>
        event.type==='failed' && parser instanceof CodexEvents && executionRequest.resumeSessionId!==undefined && codexResumeNotFound(`${parser.rawError ?? ''}\n${diagnostic}`)
          ?{type:'failed',code:'RESUME_NOT_FOUND',message:'The saved Codex thread was not found.',retryable:true,detail:'resume_not_found',
            ...(event.hadToolActivity!==undefined?{hadToolActivity:event.hadToolActivity}:{}),...(event.hadEffectiveOutput!==undefined?{hadEffectiveOutput:event.hadEffectiveOutput}:{})}
          :event;
      // A failure after the CLI started carries the activity flags of the run.
      const withActivity=(event:AgentEvent):AgentEvent=>event.type==='failed'?{...event,hadToolActivity:parser.hadToolActivity,hadEffectiveOutput:parser.hadEffectiveOutput}:event;
      try {
        for await(const value of parseJsonl(child.stdout)) {
          if(job.cancelled) break;
          for(const event of parser.accept(value)) {
            if(event.type==='completed' || event.type==='failed') terminal??=event;
            else yield event.type==='started'?{...event,workspacePath:workspace}:event;
          }
        }
        // A remembered provider error without a terminal event still names the real reason.
        terminal ??= parser.pendingFailure();
        const [exit,diagnostic]=await Promise.all([child.exited,diagnostics]);
        if(job.cancellationFailed) yield withActivity(failed('CANCELLATION_FAILED','Unable to confirm job termination.'));
        else if(job.cancelled) yield {type:'cancelled'};
        else if(timedOut && terminal===undefined) yield withActivity(timeoutEvent());
        else if(exit.code!==0 && terminal?.type!=='failed') {
          if(isAuthenticationDiagnostic(diagnostic)) {
            this.reportLoggedOut(request.provider,request.account?.id);
            yield withActivity(failed('AUTH_REQUIRED','Sign in through Settings → Agent and retry the job.'));
          } else yield resumeFix(withActivity(failed('CLI_EXIT',`The agent CLI exited unsuccessfully.${diagnostic?` ${diagnostic}`:''}`)),diagnostic);
        }
        else if(!terminal) yield withActivity(failed('MISSING_TERMINAL','The CLI ended without a terminal event.'));
        else {
          // A parsed provider failure (even with a non-zero exit) carries the real reason.
          if(terminal.type==='failed' && terminal.code==='AUTH_REQUIRED') this.reportLoggedOut(request.provider,request.account?.id);
          if(terminal.type==='completed') {
            const {isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
            this.reportAuthStatus({provider:request.provider,installed:true,status:'authenticated',isolatedOverrideNames,...(request.account===undefined?{}:{sourceId:request.account.id})});
          }
          yield resumeFix(withActivity(terminal),diagnostic);
        }
      } catch(error) {
        try {await child.cancel();} catch {job.cancellationFailed=true;}
        await diagnostics.catch(()=>{});
        const parsedFailure=terminal?.type==='failed'?terminal:terminal?undefined:parser.pendingFailure();
        if(parsedFailure && !job.cancelled && !job.cancellationFailed && parsedFailure.type==='failed' && parsedFailure.code==='AUTH_REQUIRED') this.reportLoggedOut(request.provider,request.account?.id);
        yield job.cancellationFailed?withActivity(failed('CANCELLATION_FAILED','Unable to confirm job termination.')):
          job.cancelled?{type:'cancelled'}:timedOut&&terminal===undefined?withActivity(timeoutEvent()):withActivity(parsedFailure ?? failed('CLI_IO','The CLI returned invalid or incomplete output.'));
      } finally {
        if(timer) clearTimeout(timer);
      }
    } catch {
      yield slot.job?.cancelled?{type:'cancelled'}:failed('BRIDGE_ERROR','The optional agent could not start.');
    } finally {
      // Iterator consumers may stop early; cleanup errors must never escape into Main.
      const job=slot.job;
      if (job?.child) {
        await job.child.cancel().catch(()=>{});
        // Keep this job's ownership slot quarantined until the provider tree's
        // exit is observed, even when cancellation itself could not confirm it.
        await job.child.exited;
      }
      this.releaseJob(slot);
    }
  }

  /**
   * One turn on a resident Claude process (port of CliTalkAgent run_turn, stream_json_host.rs:454-680). One process serves many turns of one key.
   * The process starts on the first turn and stays after the turn. It is killed or replaced when the arguments change, the entry is stale,
   * the turn stalls or times out, the CLI asks for authentication, or the job is cancelled.
   */
  async *runResident(input:AgentRunRequest,turn:ResidentTurnOptions):AsyncIterable<AgentEvent> {
    const slot:JobSlot={};
    let release:(()=>void)|undefined;
    // True from the moment this job may own the entry until its turn ends in a clean way.
    let owns=false;
    try {
      const prepared=await this.prepare(input,slot,'claude');
      if(!prepared.ok) {yield prepared.event;return;}
      const {job,request,workspace,executionRequest,executable,accountEnv}=prepared;
      const args=[...executable.prefixArgs,...this.spillClaude(claudeResidentArguments(executionRequest,{systemPrompt:turn.systemPrompt,model:turn.model,mcpEndpoint:turn.mcpEndpoint ?? undefined}))];
      const extensionEnv=executionRequest.extensions?extensionEnvironment(executionRequest):{};
      const gitBashEnv=this.claudeGitBashEnvironment();
      const argsHash=residentArgsHash(args,executionRequest.resumeSessionId,workspace,gitBashEnv[CLAUDE_GIT_BASH_PATH_ENV] ?? '',extensionEnv,accountEnv);
      release=await this.host.lockKey(turn.key);
      if(job.cancelled || this.closing) {yield {type:'cancelled'};return;}
      owns=true;job.residentKey=turn.key;
      // Reset before bindMcp(true): the close listener of a replaced entry releases the MCP slot of the key.
      const existing=this.host.info(turn.key);
      let live=existing!==undefined && existing.argsHash===argsHash && !existing.stale;
      if(existing && !live) this.host.reset(turn.key);
      if(live && turn.bindMcp(false)===null) {this.host.reset(turn.key);live=false;}
      let token:string|undefined;
      if(!live) {
        const bound=turn.bindMcp(true);
        if(bound!==null && bound!=='rebound') token=bound.token;
      }
      const {env}=buildChildEnvironment(this.options.environment ?? process.env);
      const extraEnv={...extensionEnv,...gitBashEnv};
      this.host.ensure(turn.key,argsHash,()=>this.runner.start({
        file:executable.file,args,cwd:workspace,env,keepStdinOpen:true,
        ...(token!==undefined?{mcpToken:token}:{}),
        ...(Object.keys(extraEnv).length?{extraEnv}:{}),
        ...(Object.keys(accountEnv).length?{accountEnv}:{}),
      }),{cwd:workspace,...(accountEnv.CLAUDE_CONFIG_DIR===undefined?{}:{claudeConfigDir:accountEnv.CLAUDE_CONFIG_DIR})});
      const residentChild=this.host.child(turn.key);
      if(residentChild) job.child=residentChild;
      job.finishLaunch();
      const parser=new ClaudeEvents();
      let terminal:AgentEvent|undefined;
      let end:Extract<ResidentTurnEvent,{type:'end'}>|undefined;
      const withActivity=(event:AgentEvent):AgentEvent=>event.type==='failed'?{...event,hadToolActivity:parser.hadToolActivity,hadEffectiveOutput:parser.hadEffectiveOutput}:event;
      for await(const item of this.host.runTurn({key:turn.key,jobId:request.jobId,message:request.prompt,timeoutMs:turn.timeoutMs,stallMs:turn.stallMs,cancelled:()=>job.cancelled})) {
        if(item.type==='end') {end=item;continue;}
        for(const event of parser.accept(item.value)) {
          if(event.type==='completed' || event.type==='failed') terminal??=event;
          else yield event.type==='started'?{...event,workspacePath:workspace}:event;
        }
      }
      // Every branch below resets the entry before it yields when the entry must not stay.
      owns=false;
      if(job.cancellationFailed) {
        this.host.reset(turn.key);
        yield withActivity(failed('CANCELLATION_FAILED','Unable to confirm job termination.'));
      } else if(job.cancelled || end?.reason==='cancelled') {
        this.host.reset(turn.key);
        yield {type:'cancelled'};
      } else switch(end?.reason) {
        case 'result': {
          if(!terminal) {this.host.reset(turn.key);yield withActivity(failed('MISSING_TERMINAL','The CLI ended without a terminal event.'));break;}
          if(terminal.type==='completed') {
            const {isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
            this.reportAuthStatus({provider:'claude',installed:true,status:'authenticated',isolatedOverrideNames,...(request.account===undefined?{}:{sourceId:request.account.id})});
          } else if(terminal.type==='failed' && terminal.code==='AUTH_REQUIRED') {
            // Decision D2: an authentication failure resets the entry, with no retry.
            this.reportLoggedOut('claude',request.account?.id);
            this.host.reset(turn.key);
          }
          yield withActivity(terminal);
          break;
        }
        case 'stalled':
          // The old turn can still write lines. The next turn must not get them.
          this.host.reset(turn.key);
          yield withActivity(failed('TURN_STALLED',`No CLI output for ${Math.round((end.stalledMs ?? turn.stallMs)/1000)}s.`));
          break;
        case 'timeout':
          this.host.reset(turn.key);
          yield withActivity(failed('TIMEOUT','The CLI did not finish in time.'));
          break;
        default: {
          // 'ended' (or a missing end event): the process ended or the entry was closed.
          this.host.reset(turn.key);
          const diagnostic=redactSensitive(end?.stderrTail ?? '').slice(-2000).trim();
          if(isAuthenticationDiagnostic(diagnostic)) {
            this.reportLoggedOut('claude',request.account?.id);
            yield withActivity(failed('AUTH_REQUIRED','Sign in through Settings → Agent and retry the job.'));
          } else {
            const pending=parser.pendingFailure();
            yield withActivity(pending ?? failed('CLI_EXIT',`The agent CLI exited unsuccessfully.${diagnostic?` ${diagnostic}`:''}`));
          }
        }
      }
    } catch {
      if(owns) this.host.reset(turn.key);
      owns=false;
      yield slot.job?.cancelled?{type:'cancelled'}:failed('BRIDGE_ERROR','The optional agent could not start.');
    } finally {
      // A consumer that stops early leaves a turn that can still write lines; the entry must not serve another turn.
      if(owns) this.host.reset(turn.key);
      release?.();
      this.releaseJob(slot);
    }
  }
}

export {AuthController} from './auth.js';
export type {ResidentCapacityExceeded,ResidentAutonomousReply,ResidentCloseReason,ResidentReaped} from './resident.js';
export {classifyAutonomous,planRelay,shouldRelay} from './relay.js';
export {EXTENSION_ENV_PREFIX,claudeExtensionPlan,codexExtensionPlan,extensionEnvironment} from './extensions.js';
export {claudeArguments,claudeIsTaskNotification,claudeIsTurnActivity,claudeResidentArguments,claudeResultOf,claudeToolArguments,claudeUserTurnLine} from './claude.js';
export {gitBashPath} from './child-environment.js';
export {homeDirectoryFrom,slimReason,transcriptBytes} from './transcript.js';
export type {AutoSlimOptions} from './transcript.js';
export {fnv1a64,spillClaudeArguments} from './spill.js';
export {INTERNAL_MCP_TOKEN_ENV,LINEJS_MCP_TOOLS,LINEJS_MCP_SERVER,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
export type {AuthStatus} from './auth.js';
export {WindowsExecutableResolver} from './executable-resolver.js';
export type {ExecutableResolver,ResolvedExecutable} from './executable-resolver.js';
export {NodeProcessRunner} from './process-runner.js';
export type {ProcessRunner,ProcessSpec,RunningProcess} from './process-runner.js';
export {CLAUDE_JUDGE_MODEL,CODEX_JUDGE_REASONING_OVERRIDE,JUDGE_DEFAULT_TIMEOUT_MS,claudeJudgeArguments,codexJudgeArguments} from './judge.js';
export type {JudgeRequest,JudgeResult} from './judge.js';
export {ACCOUNT_MARKER,accountCredentialFile,accountDirectory,createAccountDirectory,removeAccountDirectory} from './account-directory.js';
export {accountEnvironment} from './child-environment.js';
export type {AccountEnv,AccountRef} from './child-environment.js';
