import {readFile,realpath, stat} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {AgentRunRequestSchema, PROVIDER_TOOLS_UNSUPPORTED, PROVIDER_TOOLS_UNSUPPORTED_MESSAGE, type AgentEvent,type AgentProvider,type AgentRunRequest,type ResumeSessionValidationResult} from '@line-agent/contracts';
import {AuthController,type AuthStatus} from './auth.js';
import {buildChildEnvironment} from './child-environment.js';
import {claudeArguments,ClaudeEvents} from './claude.js';
import {codexArguments,CodexEvents} from './codex.js';
import {extensionEnvironment} from './extensions.js';
import {claudeJudgeArguments,codexJudgeArguments,judgeInput,JUDGE_DEFAULT_TIMEOUT_MS,type JudgeRequest,type JudgeResult} from './judge.js';
import {isAuthenticationDiagnostic} from './failure.js';
export {providerFailureResetAt} from './failure.js';
import {isWithin,protocolCompatibility,WindowsExecutableResolver,type ExecutableResolver} from './executable-resolver.js';
import {parseJsonl,ProtocolError} from './jsonl.js';
import {NodeProcessRunner,type ProcessRunner,type RunningProcess} from './process-runner.js';
import {redactSensitive} from './redact.js';

export interface BridgeOptions {
  enabled?:boolean;
  workspaceRoots?:readonly string[];
  resolveWorkspaceRoots?:()=>Promise<readonly string[]>;
  resolver?:ExecutableResolver;
  runner?:ProcessRunner;
  environment?:NodeJS.ProcessEnv;
  /** Must check provider/source/generation against persisted Main-owned session state. */
  validateResumeSession?:(request:AgentRunRequest)=>Promise<ResumeSessionValidationResult>;
}
interface Job {cancelled:boolean; cancellationFailed?:boolean; child?:RunningProcess; launchSettled:Promise<void>; finishLaunch():void}
const failed=(code:string,message:string):AgentEvent=>({type:'failed',code,message,retryable:false});

async function claudeOAuthToken(env:NodeJS.ProcessEnv):Promise<string> {
  const home=env.USERPROFILE ?? env.HOME;
  if(!home) throw new Error('Claude OAuth credentials are unavailable');
  const file=join(home,'.claude','.credentials.json');
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
  constructor(private readonly options:BridgeOptions) {
    const runner=options.runner ?? new NodeProcessRunner();
    this.runner={start:(spec)=>{
      if(this.closing) throw new Error('Agent bridge is closing');
      const child=runner.start(spec);
      this.children.add(child);
      void child.exited.then(()=>this.children.delete(child),()=>undefined);
      return child;
    }};
    this.resolver=options.resolver ?? new WindowsExecutableResolver({runner:this.runner,...(options.environment?{environment:options.environment}:{})});
    this.auth=new AuthController({runner:this.runner,resolver:this.resolver,...(options.environment?{environment:options.environment}:{})});
  }
  onAuthStatus(listener:(status:AuthStatus)=>void):()=>void {
    this.authStatusListeners.add(listener);
    return ()=>this.authStatusListeners.delete(listener);
  }
  private reportAuthStatus(status:AuthStatus):void {
    for(const listener of this.authStatusListeners) { try { listener(status); } catch { /* Health observers must not affect agent execution. */ } }
  }
  private reportLoggedOut(provider:AgentProvider):void {
    const {isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
    this.reportAuthStatus({provider,installed:true,status:'logged_out',isolatedOverrideNames,detail:'The CLI reported that authentication is required.'});
  }
  private operation<T>(work:()=>Promise<T>):Promise<T> {
    if(this.closing) return Promise.reject(new Error('Agent bridge is closing'));
    const operation=Promise.resolve().then(work);
    this.operations.add(operation);
    void operation.then(()=>this.operations.delete(operation),()=>this.operations.delete(operation));
    return operation;
  }
  getAuthStatus(provider:AgentProvider) {return this.agentRefreshStatus(provider);}
  agentRefreshStatus(provider:AgentProvider) {return this.operation(async()=>{
    const status=await this.auth.getAuthStatus(provider);
    this.reportAuthStatus(status);
    return status;
  });}
  /** Read quota through the same executable resolver and isolated identity used by Agent runs. */
  queryQuota(provider:AgentProvider) {return this.operation(async()=>{
    const {env}=buildChildEnvironment(this.options.environment ?? process.env);
    if(provider==='claude') {
      try {
        const token=await claudeOAuthToken(env);
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
    const child=this.runner.start({file:executable.file,args:[...executable.prefixArgs,'app-server','--listen','stdio://'],env,keepStdinOpen:true});
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
  openLogin(provider:AgentProvider) {return this.operation(()=>this.auth.openLogin(provider));}
  logout(provider:AgentProvider) {return this.operation(()=>this.auth.logout(provider));}
  health(provider:AgentProvider) {return this.operation(async()=>{
    try {
      const exe=await this.resolver.resolve(provider);
      if(!exe) return {provider,installed:false,compatibility:'incompatible' as const,detail:'Install the official CLI in a trusted installation directory.'};
      const compatibility=protocolCompatibility(provider,exe.version);
      return {provider,installed:true,executable:basename(exe.file),kind:exe.kind,version:exe.version,compatibility,
        ...(compatibility==='unverified'?{warning:'This CLI version has not been fixture-validated. Unexpected output will fail the job safely.'}:{})};
    } catch {return {provider,installed:false,compatibility:'incompatible' as const,detail:'Unable to inspect the official CLI.'};}
  });}
  async cancel(jobId:string):Promise<void> {
    const job=this.jobs.get(jobId);
    if(!job) return;
    job.cancelled=true;
    try {await job.child?.cancel();}
    catch {job.cancellationFailed=true;throw new Error('Unable to confirm job termination.');}
  }
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
    if(protocolCompatibility(input.provider,executable.version)==='incompatible') throw new Error('The CLI version is not compatible');
    const {env}=buildChildEnvironment(this.options.environment ?? process.env);
    const child=this.runner.start({file:executable.file,
      args:[...executable.prefixArgs,...(input.provider==='codex'?codexJudgeArguments(input,workspace):claudeJudgeArguments(input))],
      cwd:workspace,input:judgeInput(input),env});
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

  async *run(input:AgentRunRequest):AsyncIterable<AgentEvent> {
    if(this.closing) {yield failed('AGENT_CLOSING','Agent bridge is closing.');return;}
    if(this.options.enabled === false) {yield failed('AGENT_DISABLED','Agent support is disabled.');return;}
    const parsed=AgentRunRequestSchema.safeParse(input);
    if(!parsed.success) {yield failed('INVALID_REQUEST','Invalid agent request.');return;}
    const request=parsed.data;
    // Codex cannot confine its shell/file tools, so a job without the local tools permission fails closed.
    if(request.provider==='codex' && !request.tools.localTools) {yield failed(PROVIDER_TOOLS_UNSUPPORTED,PROVIDER_TOOLS_UNSUPPORTED_MESSAGE);return;}
    if(this.jobs.has(request.jobId)) {yield failed('DUPLICATE_JOB','This job is already active.');return;}
    let finish!:()=>void;
    const done=new Promise<void>(resolve=>{finish=resolve;});
    const job:Job={cancelled:false,launchSettled:done,finishLaunch:finish}; this.jobs.set(request.jobId,job);
    try {
      let workspace:string;
      let roots:string[];
      try {
        const selectedRoots=this.options.resolveWorkspaceRoots ? await this.options.resolveWorkspaceRoots() : this.options.workspaceRoots ?? [];
        roots=await Promise.all(selectedRoots.map(root=>realpath(root)));
        workspace=await realpath(request.workspacePath);
        if(!roots.some(root=>isWithin(root,workspace)) || !(await stat(workspace)).isDirectory()) throw new Error();
      } catch {yield failed('INVALID_WORKSPACE','Select a workspace inside the configured roots.');return;}
      // Image files are validated like the workspace: inside the configured roots and an existing regular file.
      const imagePaths:string[]=[];
      try {
        if(request.provider==='codex') for(const candidate of request.imagePaths ?? []) {
          const image=await realpath(candidate);
          if(!roots.some(root=>isWithin(root,image)) || !(await stat(image)).isFile()) throw new Error();
          imagePaths.push(image);
        }
      } catch {yield failed('ATTACHMENT_MISSING','An attached image is missing or outside the workspace.');return;}
      let executionRequest:AgentRunRequest=imagePaths.length?{...request,imagePaths}:request;
      if(request.resumeSessionId) {
        const validation=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(request.resumeSessionId)
          ? await this.options.validateResumeSession?.({...request,workspacePath:workspace}) ?? {status:'invalid' as const}
          : {status:'invalid' as const};
        if(validation.status==='invalid') {
          yield failed('INVALID_SESSION','Resume requires a validated stored session.');return;
        }
        if(validation.status==='workspace_mismatch') {
          const {resumeSessionId:_,...freshRequest}=request;
          executionRequest=freshRequest;
        }
      }
      const executable=await this.resolver.resolve(request.provider);
      if(!executable) {yield failed('NOT_INSTALLED','The official CLI is unavailable.');return;}
      if(protocolCompatibility(request.provider,executable.version)==='incompatible') {yield failed('INCOMPATIBLE_CLI','The CLI version is not compatible.');return;}
      if(job.cancelled) {yield {type:'cancelled'};return;}
      const {env}=buildChildEnvironment(this.options.environment ?? process.env);
      const child=this.runner.start({
        file:executable.file, args:[...executable.prefixArgs,...(executionRequest.provider==='codex'?codexArguments(executionRequest,workspace):claudeArguments(executionRequest))],
        cwd:workspace, input:request.prompt, env, ...(executionRequest.mcp?{mcpToken:executionRequest.mcp.token}:{}),
        ...(executionRequest.extensions?{extraEnv:extensionEnvironment(executionRequest)}:{}),
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
      let hasSession=false;
      try {
        for await(const value of parseJsonl(child.stdout)) {
          if(job.cancelled) break;
          for(const event of parser.accept(value)) {
            if(event.type==='started') {
              if(hasSession) throw new ProtocolError('Duplicate session event');
              hasSession=true;
            }
            if(event.type==='completed' && !hasSession) throw new ProtocolError('Missing session event');
            if(event.type==='completed' || event.type==='failed') terminal=event;
            else yield event.type==='started'?{...event,workspacePath:workspace}:event;
          }
        }
        // A remembered provider error without a terminal event still names the real reason.
        terminal ??= parser.pendingFailure();
        const [exit,diagnostic]=await Promise.all([child.exited,diagnostics]);
        if(job.cancellationFailed) yield failed('CANCELLATION_FAILED','Unable to confirm job termination.');
        else if(job.cancelled) yield {type:'cancelled'};
        else if(exit.code!==0 && terminal?.type!=='failed') {
          if(isAuthenticationDiagnostic(diagnostic)) {
            this.reportLoggedOut(request.provider);
            yield failed('AUTH_REQUIRED','Sign in through Settings → Agent and retry the job.');
          } else yield failed('CLI_EXIT',`The agent CLI exited unsuccessfully.${diagnostic?` ${diagnostic}`:''}`);
        }
        else if(!terminal) yield failed('MISSING_TERMINAL','The CLI ended without a terminal event.');
        else {
          // A parsed provider failure (even with a non-zero exit) carries the real reason.
          if(terminal.type==='failed' && terminal.code==='AUTH_REQUIRED') this.reportLoggedOut(request.provider);
          if(terminal.type==='completed') {
            const {isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
            this.reportAuthStatus({provider:request.provider,installed:true,status:'authenticated',isolatedOverrideNames});
          }
          yield terminal;
        }
      } catch(error) {
        try {await child.cancel();} catch {job.cancellationFailed=true;}
        await diagnostics.catch(()=>{});
        const parsedFailure=terminal?.type==='failed'?terminal:terminal?undefined:parser.pendingFailure();
        if(parsedFailure && !job.cancelled && !job.cancellationFailed && parsedFailure.type==='failed' && parsedFailure.code==='AUTH_REQUIRED') this.reportLoggedOut(request.provider);
        yield job.cancellationFailed?failed('CANCELLATION_FAILED','Unable to confirm job termination.'):
          job.cancelled?{type:'cancelled'}:parsedFailure ?? failed(error instanceof ProtocolError?'INVALID_JSONL':'CLI_IO','The CLI returned invalid or incomplete output.');
      }
    } catch {
      yield job.cancelled?{type:'cancelled'}:failed('BRIDGE_ERROR','The optional agent could not start.');
    } finally {
      // Iterator consumers may stop early; cleanup errors must never escape into Main.
      if (job.child) {
        await job.child.cancel().catch(()=>{});
        // Keep this job's ownership slot quarantined until the provider tree's
        // exit is observed, even when cancellation itself could not confirm it.
        await job.child.exited;
      }
      this.jobs.delete(request.jobId);
      job.finishLaunch();
    }
  }
}

export {AuthController} from './auth.js';
export {EXTENSION_ENV_PREFIX,claudeExtensionPlan,codexExtensionPlan,extensionEnvironment} from './extensions.js';
export {INTERNAL_MCP_TOKEN_ENV,LINEJS_MCP_TOOLS,LINEJS_MCP_SERVER,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
export type {AuthStatus} from './auth.js';
export {WindowsExecutableResolver} from './executable-resolver.js';
export type {ExecutableResolver,ResolvedExecutable} from './executable-resolver.js';
export {NodeProcessRunner} from './process-runner.js';
export type {ProcessRunner,ProcessSpec,RunningProcess} from './process-runner.js';
export {CLAUDE_JUDGE_MODEL,CODEX_JUDGE_REASONING_OVERRIDE,JUDGE_DEFAULT_TIMEOUT_MS,claudeJudgeArguments,codexJudgeArguments} from './judge.js';
export type {JudgeRequest,JudgeResult} from './judge.js';
