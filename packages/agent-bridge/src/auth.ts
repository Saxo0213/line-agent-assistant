import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type { AgentProvider } from '@line-agent/contracts';
import type { ExecutableResolver, ResolvedExecutable } from './executable-resolver.js';
import {accountCredentialFile,createAccountDirectory} from './account-directory.js';
import {accountEnvironment,buildChildEnvironment,type AccountEnv,type AccountRef} from './child-environment.js';
import { captureProcess, type ProcessRunner } from './process-runner.js';

export interface AuthStatus {
  provider: AgentProvider;
  installed: boolean;
  status: 'not_installed' | 'logged_out' | 'authenticated' | 'error';
  isolatedOverrideNames: string[];
  /** Id of the account source that was checked. Absent for the default source. */
  sourceId?: string;
  detail?: string;
}
export interface AuthOptions {
  resolver: ExecutableResolver;
  runner: ProcessRunner;
  environment?: NodeJS.ProcessEnv;
  /** Root of the managed account directories. Required for a managed account. */
  accountsDirectory?: string;
}
export class AuthController {
  constructor(private readonly options: AuthOptions) {}

  openLogin(provider: AgentProvider, account?: AccountRef) { return this.authAction(provider, true, account); }
  logout(provider: AgentProvider, account?: AccountRef) { return this.authAction(provider, false, account); }

  private async authAction(provider: AgentProvider, login: boolean, account?: AccountRef): Promise<{ok: boolean; detail?: string}> {
    try {
      const executable = await this.options.resolver.resolve(provider);
      if (!executable) return {ok:false, detail:'Install the official CLI first.'};
      const parentEnv=this.options.environment ?? process.env;
      const {env}=buildChildEnvironment(parentEnv);
      const accountEnv=accountEnvironment(provider,account,this.options.accountsDirectory,parentEnv);
      // CliTalkAgent always opens the console. A managed source gets its directory and marker first.
      if (login && account?.kind==='managed') await createAccountDirectory(this.options.accountsDirectory as string,account.id);
      const args = provider === 'codex' ? [login ? 'login' : 'logout'] : ['auth', login ? 'login' : 'logout'];
      const result = await captureProcess(this.options.runner, {
        file:executable.file, args:[...executable.prefixArgs, ...args],
        env, interactive:login, ...(Object.keys(accountEnv).length?{accountEnv}:{}),
      }, login ? 10 * 60_000 : 15_000);
      return result.code === 0 ? {ok:true} : {ok:false, detail:'The official CLI did not complete authentication.'};
    } catch { return {ok:false, detail:'Unable to start the official authentication command.'}; }
  }

  async getAuthStatus(provider: AgentProvider, account?: AccountRef): Promise<AuthStatus> {
    const parentEnv=this.options.environment ?? process.env;
    const {env, isolatedOverrideNames} = buildChildEnvironment(parentEnv);
    const tag=(status:AuthStatus):AuthStatus=>account===undefined?status:{...status,sourceId:account.id};
    let installed = false;
    try {
      const executable = await this.options.resolver.resolve(provider);
      if (!executable) return tag({provider, installed, status:'not_installed', isolatedOverrideNames});
      installed = true;
      const accountEnv=accountEnvironment(provider,account,this.options.accountsDirectory,parentEnv);
      return tag(await this.inspectStatus(provider,executable,env,isolatedOverrideNames,accountEnv,account));
    } catch {
      // Status diagnostics intentionally omit untrusted stderr, account identity and paths.
      return tag({provider, installed, isolatedOverrideNames, status:'error', detail:'Unable to inspect the official CLI login status.'});
    }
  }

  private async inspectStatus(provider:AgentProvider,executable:ResolvedExecutable,env:NodeJS.ProcessEnv,isolatedOverrideNames:string[],accountEnv:AccountEnv,account?:AccountRef):Promise<AuthStatus> {
    const base={provider,installed:true,isolatedOverrideNames};
    // Codex: the login file is the source (as in CliTalkAgent), so no process starts.
    if(provider==='codex') return {...base,...await codexAuthFileStatus(accountEnv.CODEX_HOME as string)};
    // Managed Claude without its login file is logged out, and no process starts (CliTalkAgent check_source).
    if(account?.kind==='managed' && !await isFile(join(accountEnv.CLAUDE_CONFIG_DIR as string,accountCredentialFile('claude')))) return {...base,status:'logged_out'};
    try {
      const result=await captureProcess(this.options.runner,{file:executable.file,args:[...executable.prefixArgs,'auth','status'],env,...(Object.keys(accountEnv).length?{accountEnv}:{})});
      const data:unknown=JSON.parse(result.stdout);
      if(typeof data==='object' && data!==null && 'loggedIn' in data && typeof data.loggedIn==='boolean') {
        return {...base,status:result.code===0 && data.loggedIn?'authenticated':'logged_out'};
      }
      return {...base,status:'error',detail:'The official CLI could not confirm its login state.'};
    } catch {
      return {...base,status:'error',detail:'Unable to inspect the official CLI login status.'};
    }
  }
}

async function isFile(path:string):Promise<boolean> {
  try {return (await stat(path)).isFile();} catch {return false;}
}

/**
 * Codex login state from `<CODEX_HOME>/auth.json`. Port of CliTalkAgent `parse_codex_auth` (llm_sources.rs).
 * Logged in = a non-empty `tokens.refresh_token` or a non-empty `OPENAI_API_KEY`. No process starts.
 * The file content, account identity and tokens are never returned or logged.
 */
async function codexAuthFileStatus(codexHome:string):Promise<Pick<AuthStatus,'status'|'detail'>> {
  const file=join(codexHome,accountCredentialFile('codex'));
  let text:string;
  try {text=await readFile(file,'utf8');}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT') return {status:'logged_out'};
    return {status:'error',detail:'Unable to read the Codex login file.'};
  }
  try {
    const record=(value:unknown):Record<string,unknown>=>typeof value==='object' && value!==null?value as Record<string,unknown>:{};
    const filled=(value:unknown)=>typeof value==='string' && value!=='';
    const root=record(JSON.parse(text));
    return {status:filled(record(root.tokens).refresh_token) || filled(root.OPENAI_API_KEY)?'authenticated':'logged_out'};
  } catch {return {status:'error',detail:'The Codex login file is not valid JSON.'};}
}
