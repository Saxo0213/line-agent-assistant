import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {randomUUID} from 'node:crypto';
import {buildChildEnvironment} from './child-environment.js';
import {CLAUDE_MCP_TOOL_TIMEOUT_ENV,INTERNAL_MCP_TOKEN_ENV,LINEJS_MCP_TOOL_TIMEOUT_SEC} from './mcp.js';

export interface ProcessSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  keepStdinOpen?: boolean;
  interactive?: boolean;
  /** Per-run internal MCP capability; injected into the child environment only, never into args. */
  mcpToken?: string;
  /** Extension-server secrets (generated variable names, or the stdio key names Codex forwards); merged into the child environment only. */
  extraEnv?: Record<string,string>;
}
export interface ExitResult { code: number | null; signal: NodeJS.Signals | null }
export interface RunningProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<ExitResult>;
  cancel(): Promise<void>;
  write?(input: string): void;
  endInput?(): void;
}
export interface ProcessRunner { start(spec: ProcessSpec): RunningProcess }

export class NodeProcessRunner implements ProcessRunner {
  private readonly hostFile:string;
  constructor(options:{hostFile?:string}={}) {
    this.hostFile=options.hostFile ?? fileURLToPath(new URL('../dist/native/JobHost.exe',import.meta.url));
  }
  start(spec: ProcessSpec): RunningProcess {
    if(process.platform!=='win32') throw new Error('Windows process isolation is required');
    if (!isAbsolute(spec.file) || !isAbsolute(this.hostFile)) throw new Error('An absolute executable is required');
    const jobId=randomUUID();
    // Inherited copies of the capability variable are always stripped; only the
    // app-issued, well-formed per-run value reaches the provider child.
    const env=buildChildEnvironment(spec.env).env;
    const childEnv:NodeJS.ProcessEnv=spec.mcpToken&&/^li_job_[A-Za-z0-9_-]{43}$/.test(spec.mcpToken)?{...env,[INTERNAL_MCP_TOKEN_ENV]:spec.mcpToken,[CLAUDE_MCP_TOOL_TIMEOUT_ENV]:String(LINEJS_MCP_TOOL_TIMEOUT_SEC*1000)}:env;
    // Extension secrets: only well-formed names, never the capability variable, and never over a variable the runner already set.
    for(const [name,value] of Object.entries(spec.extraEnv ?? {})) {
      if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)&&name!==INTERNAL_MCP_TOKEN_ENV&&childEnv[name]===undefined) childEnv[name]=value;
    }
    const child = spawn(this.hostFile,[jobId,String(process.pid),spec.interactive?'interactive':'pipe',spec.file,spec.cwd ?? process.cwd(),...spec.args], {
      cwd: spec.cwd, env:childEnv, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<ExitResult>((resolve) => {
      child.once('error', () => resolve({code: -1, signal: null}));
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    child.stdin.on('error', () => {}); // EPIPE is reported by the process exit, never thrown in Main.
    if(spec.keepStdinOpen) { if(spec.input) child.stdin.write(spec.input); }
    else child.stdin.end(spec.input ?? '');
    let cancellation:Promise<void>|undefined;
    return {
      stdout: child.stdout, stderr: child.stderr, exited,
      write:(input:string)=>{if(child.stdin.destroyed||child.stdin.writableEnded) throw new Error('Process stdin is closed');child.stdin.write(input);},
      endInput:()=>{if(!child.stdin.destroyed&&!child.stdin.writableEnded) child.stdin.end();},
      cancel: () => cancellation ??= (async()=>{
        const signals=new Set<ChildProcess>();
        let timer:ReturnType<typeof setTimeout>|undefined;
        let timedOut=false;
        const timeout=new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>{timedOut=true;for(const signal of signals)signal.kill();child.kill();reject(new Error('Process cancellation timed out'));},5000);
        });
        // Signal only this host's randomly named event. It terminates the Job
        // and confirms zero active processes before its exit becomes observable.
        const stop=async()=>{
          for(let attempt=0;attempt<10 && !timedOut && child.exitCode===null && child.signalCode===null;attempt++) {
            const currentSignal=spawn(this.hostFile,['--cancel',jobId],{env,shell:false,windowsHide:true,stdio:'ignore'});
            signals.add(currentSignal);
            const code=await new Promise<number|null>(resolve=>{currentSignal.once('error',()=>resolve(-1));currentSignal.once('close',resolve);});
            signals.delete(currentSignal);
            if(code===0) break;
            if(!timedOut) await new Promise(resolve=>setTimeout(resolve,20));
            if(attempt===9) child.kill();
          }
          await exited;
        };
        const stopWork=stop();
        try {await Promise.race([stopWork,timeout]);}
        finally {
          if(timer) clearTimeout(timer);
          if(timedOut) {
            for(const signal of signals) signal.kill();
            child.kill();
            await Promise.all([...signals].map(currentSignal=>new Promise<void>(resolve=>{
              if(currentSignal.exitCode!==null||currentSignal.signalCode!==null){resolve();return;}
              currentSignal.once('error',()=>resolve());currentSignal.once('close',()=>resolve());
            })));
            await exited;
            await stopWork.catch(()=>{});
          }
        }
      })(),
    };
  }
}

export async function captureProcess(runner: ProcessRunner, spec: ProcessSpec, timeoutMs = 15_000) {
  const child = runner.start(spec);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void child.cancel().catch(()=>{}); }, timeoutMs);
  let overflow = false;
  async function read(stream: AsyncIterable<Uint8Array>) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > 64 * 1024) { overflow = true; void child.cancel().catch(()=>{}); break; }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (timedOut || overflow) throw new Error('CLI status was not available within limits');
    return {stdout, stderr, ...exit};
  } finally { clearTimeout(timer); await child.cancel().catch(()=>{}); }
}
