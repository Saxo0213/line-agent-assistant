import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {join} from 'node:path';
import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {AgentRunRequestSchema} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {claudeArguments} from './claude.js';
import {codexArguments} from './codex.js';
import {INTERNAL_MCP_TOKEN_ENV} from './mcp.js';
import {redactSensitive} from './redact.js';
import {NodeProcessRunner} from './process-runner.js';
import {cleanup,fixtures,request,temporaryDirectory} from './test-support.js';

const TOKEN=`li_job_${'T'.repeat(43)}`;
const mcp={endpoint:'http://127.0.0.1:38471/mcp',token:TOKEN};
let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
async function collect(events:AsyncIterable<AgentEvent>) {const out:AgentEvent[]=[];for await(const event of events) out.push(event);return out;}
function bridge(provider:'codex'|'claude',environment:NodeJS.ProcessEnv) {
  return new AgentCliBridge({enabled:true,workspaceRoots:[root],runner:new NodeProcessRunner(),environment,
    resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})}});
}
const payload=(events:AgentEvent[])=>{const last=events.at(-1);expect(last?.type).toBe('completed');return JSON.parse(last&&'finalText' in last?last.finalText:'{}');};

describe('launch-scoped MCP adapter configuration',()=>{
  it('keeps the existing arguments when no MCP launch is supplied',()=>{
    const base=request('claude',root);
    expect(claudeArguments(base)).not.toContain('--mcp-config');
    expect(codexArguments(request('codex',root),root).join(' ')).not.toContain('mcp_servers');
  });
  it('configures Claude with strict loopback HTTP config, a variable reference, and only the fixed read-only tools',()=>{
    const args=claudeArguments({...request('claude',root),mcp});
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--tools'),args.indexOf('--tools')+2)).toEqual(['--tools','Read,Glob,Grep,Write,Edit']);
    expect(args[args.indexOf('--disallowedTools')+1]).toContain('Bash');
    const config=JSON.parse(args[args.indexOf('--mcp-config')+1]!);
    expect(config).toEqual({mcpServers:{linejs:{type:'http',url:mcp.endpoint,headers:{Authorization:'Bearer ${LINEJS_INTERNAL_MCP_TOKEN}'}}}});
    expect(args[args.indexOf('--allowedTools')+1]).toBe('mcp__linejs__list_targets,mcp__linejs__query_target_messages,mcp__linejs__query_target_messages_by_time,mcp__linejs__query_agent_room_history,mcp__linejs__list_send_targets,mcp__linejs__send_to_target,mcp__linejs__list_schedules,mcp__linejs__create_schedule,mcp__linejs__update_schedule,mcp__linejs__delete_schedule,Write,Edit');
    expect(args[args.indexOf('--tools')+1]).not.toContain('Bash');
    expect(args[args.indexOf('--allowedTools')+1]).not.toContain('Bash');
    expect(args.join('\n')).not.toContain(TOKEN);
  });
  it('configures Codex with launch-only -c overrides and keeps --ignore-user-config',()=>{
    const args=codexArguments({...request('codex',root),mcp},root);
    expect(args).toContain('--ignore-user-config');
    const overrides=args.filter((_,index)=>args[index-1]==='-c');
    expect(overrides).toEqual([
      'mcp_servers.linejs.url="http://127.0.0.1:38471/mcp"',
      'mcp_servers.linejs.bearer_token_env_var="LINEJS_INTERNAL_MCP_TOKEN"',
      'mcp_servers.linejs.enabled_tools=["list_targets","query_target_messages","query_target_messages_by_time","query_agent_room_history","list_send_targets","send_to_target","list_schedules","create_schedule","update_schedule","delete_schedule"]',
      'mcp_servers.linejs.tool_timeout_sec=600',
      'mcp_servers.linejs.tools.list_targets.approval_mode="approve"',
      'mcp_servers.linejs.tools.query_target_messages.approval_mode="approve"',
      'mcp_servers.linejs.tools.query_target_messages_by_time.approval_mode="approve"',
      'mcp_servers.linejs.tools.query_agent_room_history.approval_mode="approve"',
      'mcp_servers.linejs.tools.list_send_targets.approval_mode="approve"',
      'mcp_servers.linejs.tools.send_to_target.approval_mode="approve"',
      'mcp_servers.linejs.tools.list_schedules.approval_mode="approve"',
      'mcp_servers.linejs.tools.create_schedule.approval_mode="approve"',
      'mcp_servers.linejs.tools.update_schedule.approval_mode="approve"',
      'mcp_servers.linejs.tools.delete_schedule.approval_mode="approve"',
    ]);
    expect(args.join('\n')).not.toContain(TOKEN);
    expect(args.at(-1)).toBe('-');
    const resumed=codexArguments({...request('codex',root),mcp,resumeSessionId:'sess-1'},root);
    expect(resumed.slice(-3)).toEqual(['resume','sess-1','-']);
  });
  it('rejects non-loopback endpoints and malformed capabilities at the contract boundary',()=>{
    const parse=(value:unknown)=>AgentRunRequestSchema.safeParse({...request('codex',root),mcp:value}).success;
    expect(parse(mcp)).toBe(true);
    expect(parse({...mcp,endpoint:'http://example.com/mcp'})).toBe(false);
    expect(parse({...mcp,endpoint:'http://127.0.0.1:1/other'})).toBe(false);
    expect(parse({...mcp,token:'la_mcp_'+'A'.repeat(43)})).toBe(false);
  });
  it('redacts capability bytes from diagnostics',()=>{
    expect(redactSensitive(`failed ${TOKEN} here`)).not.toContain(TOKEN);
  });
});

describe('child environment for the capability',()=>{
  it.each(['codex','claude'] as const)('passes the app-issued %s capability only through the environment, args stay token-free',async provider=>{
    const run:AgentRunRequest={...request(provider,root),mcp};
    const result=payload(await collect(bridge(provider,{...process.env,[INTERNAL_MCP_TOKEN_ENV]:'li_job_'+'S'.repeat(43)}).run(run)));
    expect(result.env[INTERNAL_MCP_TOKEN_ENV]).toBe(TOKEN);
    expect(result.env.MCP_TOOL_TIMEOUT).toBe('600000');
    expect(JSON.stringify(result.args)).not.toContain(TOKEN);
    expect(result.input).toBe('Hello');
  });
  it.each(['codex','claude'] as const)('strips an inherited %s capability when no launch is supplied',async provider=>{
    const result=payload(await collect(bridge(provider,{...process.env,[INTERNAL_MCP_TOKEN_ENV]:'li_job_'+'S'.repeat(43)}).run(request(provider,root))));
    expect(result.env[INTERNAL_MCP_TOKEN_ENV]).toBeUndefined();
    expect(result.env.MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('S'.repeat(43));
  });
});
