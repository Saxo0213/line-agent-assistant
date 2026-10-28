import type {AgentMcpServerDefinition,AgentRunExtensions,AgentRunRequest} from '@line-agent/contracts';
import {isReservedEnvironmentName} from './child-environment.js';
import {LINEJS_MCP_SERVER} from './mcp.js';

/** Child-environment prefix of the generated variables that carry extension secrets; they are referenced by name only. */
export const EXTENSION_ENV_PREFIX='LINEJS_EXT_';
const reference=(name:string)=>`\${${name}}`;

const forProvider=(extensions:AgentRunExtensions|undefined,provider:'claude'|'codex'):AgentMcpServerDefinition[]=>
  (extensions?.servers ?? []).filter(server=>server.name!==LINEJS_MCP_SERVER&&server.providers.includes(provider));

export interface ClaudeExtensionPlan {
  /** Entries for the `mcpServers` object of `--mcp-config`. Secrets appear only as `${VAR}` references. */
  servers:Record<string,Record<string,unknown>>;
  /** `mcp__<server>` allows every tool of that server. */
  allowedTools:string[];
  /** Generated variables to add to the child environment. */
  env:Record<string,string>;
}
export function claudeExtensionPlan(extensions:AgentRunExtensions|undefined):ClaudeExtensionPlan {
  const plan:ClaudeExtensionPlan={servers:{},allowedTools:[],env:{}};
  forProvider(extensions,'claude').forEach((server,index)=>{
    const secret=(kind:'E'|'H',position:number,value:string)=>{const name=`${EXTENSION_ENV_PREFIX}${index}_${kind}${position}`;plan.env[name]=value;return reference(name);};
    if(server.transport==='stdio') {
      plan.servers[server.name]={type:'stdio',command:server.command,args:server.args,
        ...(Object.keys(server.env).length?{env:Object.fromEntries(Object.entries(server.env).map(([key,value],position)=>[key,secret('E',position,value)]))}:{})};
    } else {
      plan.servers[server.name]={type:'http',url:server.url,
        ...(Object.keys(server.headers).length?{headers:Object.fromEntries(Object.entries(server.headers).map(([key,value],position)=>[key,secret('H',position,value)]))}:{})};
    }
    plan.allowedTools.push(`mcp__${server.name}`);
  });
  return plan;
}

export interface CodexExtensionPlan {
  /** `-c` overrides, without the leading flag pairs flattened: ['-c','k=v',...]. */
  overrides:string[];
  /** Variables for the child environment. stdio env keeps its own names because Codex `env_vars` forwards by name. */
  env:Record<string,string>;
  /** Servers left out because their environment names would clash with the runner's or another server's. */
  skipped:string[];
}
export function codexExtensionPlan(extensions:AgentRunExtensions|undefined):CodexExtensionPlan {
  const plan:CodexExtensionPlan={overrides:[],env:{},skipped:[]};
  const set=(server:string,key:string,value:string)=>plan.overrides.push('-c',`mcp_servers.${server}.${key}=${value}`);
  forProvider(extensions,'codex').forEach((server,index)=>{
    if(server.transport==='stdio') {
      const names=Object.keys(server.env);
      const clash=names.some(name=>isReservedEnvironmentName(name)||name.startsWith(EXTENSION_ENV_PREFIX)||(plan.env[name]!==undefined&&plan.env[name]!==server.env[name]));
      if(clash) {plan.skipped.push(server.name);return;}
      Object.assign(plan.env,server.env);
      set(server.name,'command',JSON.stringify(server.command));
      set(server.name,'args',JSON.stringify(server.args));
      if(names.length) set(server.name,'env_vars',JSON.stringify(names));
    } else {
      set(server.name,'url',JSON.stringify(server.url));
      const headers=Object.entries(server.headers).map(([key,value],position)=>{const name=`${EXTENSION_ENV_PREFIX}${index}_H${position}`;plan.env[name]=value;return `${JSON.stringify(key)}=${JSON.stringify(name)}`;});
      if(headers.length) set(server.name,'env_http_headers',`{${headers.join(',')}}`);
    }
    // Server-level approval: non-interactive `exec` cannot answer a prompt, and the user chose these servers for eligible jobs.
    set(server.name,'default_tools_approval_mode','"approve"');
  });
  return plan;
}

/** Codex live web search, from the built-in toggle. */
export const codexWebSearchOverrides=(extensions:AgentRunExtensions|undefined,webTools=false):string[]=>webTools||extensions?.tools.webSearch?['-c','web_search="live"']:[];

/** Extra child-environment variables for a run (secrets of extension servers). Empty when the request carries no extensions. */
export function extensionEnvironment(request:AgentRunRequest):Record<string,string> {
  return request.provider==='codex'?codexExtensionPlan(request.extensions).env:claudeExtensionPlan(request.extensions).env;
}
