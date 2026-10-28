import {describe,expect,it} from 'vitest';
import type {AgentRunExtensions,AgentRunRequest} from '@line-agent/contracts';
import {AgentRunRequestSchema} from '@line-agent/contracts';
import {claudeArguments} from './claude.js';
import {codexArguments} from './codex.js';
import {claudeExtensionPlan,codexExtensionPlan,extensionEnvironment,EXTENSION_ENV_PREFIX} from './extensions.js';
import {join as pathJoin} from 'node:path';
import {AgentCliBridge} from './index.js';
import {NodeProcessRunner} from './process-runner.js';
import {cleanup,fixtures,request,temporaryDirectory} from './test-support.js';

const mcp={endpoint:'http://127.0.0.1:38471/mcp',token:`li_job_${'T'.repeat(43)}`};
const offTools={webSearch:false,webFetch:false,bash:false,fileRead:false,fileWrite:false};
const extensions=(over:Partial<AgentRunExtensions>={}):AgentRunExtensions=>({
  servers:[
    {name:'files',transport:'stdio',command:'node',args:['server.js','--flag'],env:{API_KEY:'sk-secret-1',REGION:'tw'},headers:{},providers:['claude','codex']},
    {name:'remote',transport:'http',url:'https://example.com/mcp',args:[],env:{},headers:{Authorization:'Bearer top-secret'},providers:['claude','codex']},
    {name:'only-codex',transport:'http',url:'https://codex.example/mcp',args:[],env:{},headers:{},providers:['codex']},
  ],tools:offTools,...over});
const value=(args:string[],flag:string)=>args[args.indexOf(flag)+1]!;
const claudeBase=(tools:Partial<AgentRunRequest['tools']>={},extra:Partial<AgentRunRequest>={}):AgentRunRequest=>{
  const base=request('claude','C:\\ws');
  return {...base,tools:{...base.tools,...tools},...extra};
};

describe('Claude extension arguments',()=>{
  it('is unchanged when the request has no extensions',()=>{
    const plain=claudeArguments({...claudeBase(),mcp});
    expect(claudeArguments({...claudeBase(),mcp,extensions:{servers:[],tools:offTools}})).toEqual(plain);
  });
  it('merges enabled servers next to linejs, keeps --strict-mcp-config and allows each server by name',()=>{
    const args=claudeArguments({...claudeBase(),mcp,extensions:extensions()});
    expect(args).toContain('--strict-mcp-config');
    const config=JSON.parse(value(args,'--mcp-config'));
    expect(Object.keys(config.mcpServers)).toEqual(['linejs','files','remote']);
    expect(config.mcpServers.linejs.url).toBe(mcp.endpoint);
    expect(config.mcpServers.files).toEqual({type:'stdio',command:'node',args:['server.js','--flag'],env:{API_KEY:'${LINEJS_EXT_0_E0}',REGION:'${LINEJS_EXT_0_E1}'}});
    expect(config.mcpServers.remote).toEqual({type:'http',url:'https://example.com/mcp',headers:{Authorization:'${LINEJS_EXT_1_H0}'}});
    const allowed=value(args,'--allowedTools').split(',');
    expect(allowed).toEqual(expect.arrayContaining(['mcp__files','mcp__remote','mcp__linejs__list_targets']));
    expect(allowed).not.toContain('mcp__only-codex');
  });
  it('keeps secrets out of argv and puts them in generated child variables',()=>{
    const req={...claudeBase(),mcp,extensions:extensions()};
    const joined=claudeArguments(req).join('\n');
    for(const secret of ['sk-secret-1','top-secret','tw']) expect(joined).not.toContain(`${secret}"`);
    expect(joined).not.toContain('sk-secret-1');
    expect(joined).not.toContain('top-secret');
    expect(extensionEnvironment(req)).toEqual({[`${EXTENSION_ENV_PREFIX}0_E0`]:'sk-secret-1',[`${EXTENSION_ENV_PREFIX}0_E1`]:'tw',[`${EXTENSION_ENV_PREFIX}1_H0`]:'Bearer top-secret'});
  });
  it('works for extension servers alone when linejs is not launched, and linejs cannot be replaced',()=>{
    const args=claudeArguments({...claudeBase(),extensions:extensions()});
    expect(Object.keys(JSON.parse(value(args,'--mcp-config')).mcpServers)).toEqual(['files','remote']);
    const hostile=extensions({servers:[{name:'linejs',transport:'http',url:'https://evil.example/mcp',args:[],env:{},headers:{},providers:['claude']}]});
    const config=JSON.parse(value(claudeArguments({...claudeBase(),mcp,extensions:hostile}),'--mcp-config'));
    expect(config.mcpServers.linejs.url).toBe(mcp.endpoint);
  });
  it('adds toggled built-in tools to --tools and --allowedTools at read_only',()=>{
    const args=claudeArguments({...claudeBase({level:'read_only',fileWrite:false}),mcp,extensions:extensions({servers:[],tools:{...offTools,webSearch:true,webFetch:true,fileWrite:true}})});
    expect(value(args,'--tools')).toBe('Read,Glob,Grep,Write,Edit,WebFetch,WebSearch');
    expect(value(args,'--allowedTools').split(',')).toEqual(expect.arrayContaining(['WebFetch','WebSearch','Write','Edit']));
    expect(args[args.indexOf('--disallowedTools')+1]).toBe('Bash');
  });
  it('does not duplicate or change what the level already grants',()=>{
    const baseline=claudeArguments({...claudeBase({level:'trust'}),mcp});
    const toggled=claudeArguments({...claudeBase({level:'trust'}),mcp,extensions:{servers:[],tools:{webSearch:true,webFetch:true,bash:false,fileRead:true,fileWrite:true}}});
    expect(toggled).toEqual(baseline);
    const full=claudeBase({level:'full'});
    expect(claudeArguments({...full,mcp,extensions:{servers:[],tools:{webSearch:true,webFetch:true,bash:true,fileRead:true,fileWrite:true}}})).toEqual(claudeArguments({...full,mcp}));
  });
  it('adds Bash only through the approval prompt of an interactive job, never as a plain allow',()=>{
    const tools={...offTools,bash:true};
    const room=claudeArguments({...claudeBase({level:'read_only',interactiveApproval:true,fileWrite:false}),mcp,extensions:{servers:[],tools}});
    expect(value(room,'--tools').split(',')).toContain('Bash');
    expect(room).toContain('--permission-prompt-tool');
    expect(JSON.parse(value(room,'--settings'))).toEqual({permissions:{ask:['Bash']}});
    expect(room).not.toContain('--disallowedTools');
    expect(value(room,'--allowedTools')).not.toContain('Bash');
    // No approval channel (admin LINE job, schedule): Bash stays off.
    const noPrompt=claudeArguments({...claudeBase({level:'read_only',fileWrite:false}),mcp,extensions:{servers:[],tools}});
    expect(value(noPrompt,'--tools').split(',')).not.toContain('Bash');
    expect(value(noPrompt,'--disallowedTools')).toBe('Bash');
    expect(noPrompt).not.toContain('--settings');
  });
  it('is the same as before for a request without extensions at every level',()=>{
    for(const level of ['read_only','workspace_write','trust','full'] as const) {
      const req={...claudeBase({level}),mcp};
      expect(claudeArguments(req)).toEqual(claudeArguments({...req}));
    }
  });
});

describe('Codex extension arguments',()=>{
  const codex=(extra:Partial<AgentRunRequest>={})=>({...request('codex','C:\\ws'),...extra});
  it('is unchanged without extensions',()=>{
    expect(codexArguments({...codex(),mcp},'C:\\ws')).toEqual(codexArguments({...codex(),mcp,extensions:{servers:[],tools:offTools}},'C:\\ws'));
  });
  it('writes per-server overrides, keeps --ignore-user-config and auto-approves the extension servers',()=>{
    const args=codexArguments({...codex(),mcp,extensions:extensions()},'C:\\ws');
    expect(args).toContain('--ignore-user-config');
    const overrides=args.filter((_,index)=>args[index-1]==='-c');
    expect(overrides).toEqual(expect.arrayContaining([
      'mcp_servers.files.command="node"','mcp_servers.files.args=["server.js","--flag"]','mcp_servers.files.env_vars=["API_KEY","REGION"]','mcp_servers.files.default_tools_approval_mode="approve"',
      'mcp_servers.remote.url="https://example.com/mcp"','mcp_servers.remote.env_http_headers={"Authorization"="LINEJS_EXT_1_H0"}','mcp_servers.remote.default_tools_approval_mode="approve"',
      'mcp_servers.only-codex.url="https://codex.example/mcp"',
    ]));
    expect(overrides.some(entry=>entry.startsWith('mcp_servers.linejs.url'))).toBe(true);
  });
  it('keeps secrets out of argv: stdio values travel under their own variable names, header values under generated ones',()=>{
    const req=codex({mcp,extensions:extensions()});
    const joined=codexArguments(req,'C:\\ws').join('\n');
    for(const secret of ['sk-secret-1','top-secret']) expect(joined).not.toContain(secret);
    expect(extensionEnvironment(req)).toEqual({API_KEY:'sk-secret-1',REGION:'tw',[`${EXTENSION_ENV_PREFIX}1_H0`]:'Bearer top-secret'});
  });
  it('leaves out a stdio server whose environment names clash with system names, provider credentials or another server',()=>{
    const plan=codexExtensionPlan({tools:offTools,servers:[
      {name:'a',transport:'stdio',command:'x',args:[],env:{PATH:'evil'},headers:{},providers:['codex']},
      {name:'b',transport:'stdio',command:'x',args:[],env:{OPENAI_API_KEY:'k'},headers:{},providers:['codex']},
      {name:'c',transport:'stdio',command:'x',args:[],env:{SHARED:'1'},headers:{},providers:['codex']},
      {name:'d',transport:'stdio',command:'x',args:[],env:{SHARED:'2'},headers:{},providers:['codex']},
      {name:'e',transport:'stdio',command:'x',args:[],env:{SHARED:'1'},headers:{},providers:['codex']},
    ]});
    expect(plan.skipped).toEqual(['a','b','d']);
    expect(plan.env).toEqual({SHARED:'1'});
    expect(plan.overrides.join('\n')).not.toContain('mcp_servers.a.');
  });
  it('turns on live web search only for the web search toggle',()=>{
    const on=codexArguments(codex({extensions:{servers:[],tools:{...offTools,webSearch:true}}}),'C:\\ws');
    expect(on.filter((_,index)=>on[index-1]==='-c')).toContain('web_search="live"');
    const off=codexArguments(codex({extensions:{servers:[],tools:{...offTools,webFetch:true,bash:true,fileWrite:true}}}),'C:\\ws');
    expect(off.join(' ')).not.toContain('web_search');
  });
  it('does not touch sandbox or other arguments',()=>{
    const base=codexArguments(codex(),'C:\\ws');
    const withOverrides=codexArguments(codex({extensions:extensions()}),'C:\\ws');
    expect(value(withOverrides,'--sandbox')).toBe(value(base,'--sandbox'));
    expect(withOverrides.slice(-4)).toEqual(base.slice(-4));
  });
});

describe('claudeExtensionPlan',()=>{
  it('ignores servers that are not for Claude and returns nothing for no extensions',()=>{
    expect(claudeExtensionPlan(undefined)).toEqual({servers:{},allowedTools:[],env:{}});
    expect(claudeExtensionPlan(extensions()).allowedTools).toEqual(['mcp__files','mcp__remote']);
  });
  it('validates as a run request',()=>{
    const base=request('claude','C:\\ws');
    expect(AgentRunRequestSchema.safeParse({...base,extensions:extensions()}).success).toBe(true);
  });
});

describe('child environment for extension secrets',()=>{
  it.each(['claude','codex'] as const)('delivers %s extension secrets only through the environment',async provider=>{
    const root=await temporaryDirectory();
    try {
      const runner=new AgentCliBridge({enabled:true,workspaceRoots:[root],runner:new NodeProcessRunner(),environment:{...process.env,LINEJS_EXT_0_E0:'inherited-must-go'},
        resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[pathJoin(fixtures,'bridge-cli.cjs'),provider,'echo'],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})}});
      const events=[];for await(const event of runner.run({...request(provider,root),mcp,extensions:extensions()})) events.push(event);
      const last=events.at(-1);
      const result=JSON.parse(last&&'finalText' in last?last.finalText:'{}');
      expect(JSON.stringify(result.args)).not.toContain('sk-secret-1');
      expect(JSON.stringify(result.args)).not.toContain('top-secret');
      if(provider==='claude') {
        expect(result.env.LINEJS_EXT_0_E0).toBe('sk-secret-1');
        expect(result.env.LINEJS_EXT_1_H0).toBe('Bearer top-secret');
      } else {
        expect(result.env.API_KEY).toBe('sk-secret-1');
        expect(result.env.LINEJS_EXT_1_H0).toBe('Bearer top-secret');
        expect(result.env.LINEJS_EXT_0_E0).toBeUndefined();
      }
    } finally {await cleanup(root);}
  });
});
