import type { AgentProvider } from '@line-agent/contracts';
import type { ExecutableResolver, ResolvedExecutable } from './executable-resolver.js';
import { buildChildEnvironment } from './child-environment.js';
import { captureProcess, type ProcessRunner } from './process-runner.js';

export interface AuthStatus {
  provider: AgentProvider;
  installed: boolean;
  status: 'not_installed' | 'logged_out' | 'authenticated' | 'error';
  isolatedOverrideNames: string[];
  detail?: string;
}
export interface AuthOptions {
  resolver: ExecutableResolver;
  runner: ProcessRunner;
  environment?: NodeJS.ProcessEnv;
}
export class AuthController {
  constructor(private readonly options: AuthOptions) {}

  openLogin(provider: AgentProvider) { return this.authAction(provider, true); }
  logout(provider: AgentProvider) { return this.authAction(provider, false); }

  private async authAction(provider: AgentProvider, login: boolean): Promise<{ok: boolean; detail?: string}> {
    try {
      const executable = await this.options.resolver.resolve(provider);
      if (!executable) return {ok:false, detail:'Install the official CLI first.'};
      const {env,isolatedOverrideNames}=buildChildEnvironment(this.options.environment ?? process.env);
      if (login) {
        const status=await this.inspectStatus(provider,executable,env,isolatedOverrideNames);
        if(status.status==='authenticated') return {ok:true};
        if(status.status!=='logged_out') return {ok:false,detail:'The official CLI could not confirm its login state.'};
      }
      const args = provider === 'codex' ? [login ? 'login' : 'logout'] : ['auth', login ? 'login' : 'logout'];
      const result = await captureProcess(this.options.runner, {
        file:executable.file, args:[...executable.prefixArgs, ...args],
        env, interactive:login,
      }, login ? 10 * 60_000 : 15_000);
      return result.code === 0 ? {ok:true} : {ok:false, detail:'The official CLI did not complete authentication.'};
    } catch { return {ok:false, detail:'Unable to start the official authentication command.'}; }
  }

  async getAuthStatus(provider: AgentProvider): Promise<AuthStatus> {
    const {env, isolatedOverrideNames} = buildChildEnvironment(this.options.environment ?? process.env);
    let installed = false;
    try {
      const executable = await this.options.resolver.resolve(provider);
      if (!executable) return {provider, installed, status:'not_installed', isolatedOverrideNames};
      installed = true;
      return await this.inspectStatus(provider,executable,env,isolatedOverrideNames);
    } catch {
      // Status diagnostics intentionally omit untrusted stderr, account identity and paths.
      return {provider, installed, isolatedOverrideNames, status:'error', detail:'Unable to inspect the official CLI login status.'};
    }
  }

  private async inspectStatus(provider:AgentProvider,executable:ResolvedExecutable,env:NodeJS.ProcessEnv,isolatedOverrideNames:string[]):Promise<AuthStatus> {
    const base={provider,installed:true,isolatedOverrideNames};
    try {
      const result=await captureProcess(this.options.runner,{
        file:executable.file,args:[...executable.prefixArgs,...(provider==='codex'?['login','status']:['auth','status'])],env,
      });
      if(provider==='codex') {
        const text=`${result.stdout}\n${result.stderr}`.trim();
        if(result.code===0 && /^Logged in using .+$/m.test(text)) return {...base,status:'authenticated'};
        if(/^Not logged in/im.test(text)) return {...base,status:'logged_out'};
      } else {
        const data:unknown=JSON.parse(result.stdout);
        if(typeof data==='object' && data!==null && 'loggedIn' in data && typeof data.loggedIn==='boolean') {
          return {...base,status:result.code===0 && data.loggedIn?'authenticated':'logged_out'};
        }
      }
      return {...base,status:'error',detail:'The official CLI could not confirm its login state.'};
    } catch {
      return {...base,status:'error',detail:'Unable to inspect the official CLI login status.'};
    }
  }
}
