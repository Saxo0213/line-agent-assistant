import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {join} from 'node:path';
import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {PROVIDER_TOOLS_UNSUPPORTED,PROVIDER_TOOLS_UNSUPPORTED_MESSAGE} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {claudeArguments,claudeBuiltInTools} from './claude.js';
import {claudeMcpConfig,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
import {codexArguments} from './codex.js';
import {NodeProcessRunner} from './process-runner.js';
import {cleanup,fixtures,request,temporaryDirectory} from './test-support.js';

const mcp={endpoint:'http://127.0.0.1:38471/mcp',token:`li_job_${'T'.repeat(43)}`};
const none={localTools:false,fileRead:false,fileWrite:false,linkedReadDirs:[],workspaceRootDir:null,level:'read_only' as const,interactiveApproval:false};
let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
async function collect(events:AsyncIterable<AgentEvent>) {const out:AgentEvent[]=[];for await(const event of events) out.push(event);return out;}
const value=(args:string[],flag:string)=>args[args.indexOf(flag)+1];
function previousClaudeArguments(req:AgentRunRequest) {
  const level=req.tools.level??(req.tools.localTools?'workspace_write':'read_only');
  const fullAccess=level==='full'&&req.tools.localTools;
  const allowed=[...(req.mcp?claudeMcpToolNames():[]),...(req.tools.fileWrite&&['workspace_write','trust','full'].includes(level)?['Write','Edit']:[])];
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages',...(fullAccess?[]:['--restricted']),'--permission-mode','dontAsk','--strict-mcp-config',...[...(req.tools.workspaceRootDir?[req.tools.workspaceRootDir]:[]),...req.tools.linkedReadDirs].flatMap(directory=>['--add-dir',directory]),...(fullAccess?[]:['--tools',claudeBuiltInTools(req.tools).join(',')]),'--disallowedTools','Bash',...(req.mcp?['--mcp-config',claudeMcpConfig(req.mcp)]:[]),...(allowed.length?['--allowedTools',allowed.join(',')]:[]),...(req.resumeSessionId?['--resume',req.resumeSessionId]:[])];
}
function bridge(provider:'codex'|'claude') {
  return new AgentCliBridge({enabled:true,workspaceRoots:[root],runner:new NodeProcessRunner(),environment:process.env,
    resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,'echo'],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})}});
}

describe('Claude built-in tools come from the Main-resolved policy',()=>{
  it('maps the default workspace-write level and never puts Bash in --allowedTools',()=>{
    const args=claudeArguments({...request('claude',root),mcp});
    expect(value(args,'--tools')).toBe('Read,Glob,Grep,Write,Edit');
    expect(args).not.toContain('--add-dir');
    expect(args).toContain('--restricted');
    expect(value(args,'--permission-mode')).toBe('dontAsk');
    expect(value(args,'--allowedTools')).toContain('Write,Edit');
    expect(value(args,'--allowedTools')).not.toContain('Bash');
  });
  it('disables every built-in tool when neither folder permission is granted',()=>{
    const args=claudeArguments({...request('claude',root,{tools:none}),mcp});
    expect(value(args,'--tools')).toBe('');
    expect(args).not.toContain('--add-dir');
    expect(value(args,'--allowedTools')).toBe('mcp__linejs__list_targets,mcp__linejs__query_target_messages,mcp__linejs__query_target_messages_by_time,mcp__linejs__query_agent_room_history,mcp__linejs__list_send_targets,mcp__linejs__send_to_target');
  });
  it('grants read tools for chat_folder.read and adds Write/Edit (explicitly allowed) for chat_folder.write',()=>{
    const read=claudeArguments(request('claude',root,{tools:{...none,fileRead:true,level:'workspace_write'}}));
    expect(value(read,'--tools')).toBe('Read,Glob,Grep');
    expect(read).not.toContain('--allowedTools');
    const write=claudeArguments({...request('claude',root,{tools:{...none,fileRead:true,fileWrite:true,level:'workspace_write'}}),mcp});
    expect(value(write,'--tools')).toBe('Read,Glob,Grep,Write,Edit');
    expect(value(write,'--allowedTools')).toContain('Write,Edit');
    expect(value(claudeArguments(request('claude',root,{tools:{...none,fileWrite:true,level:'workspace_write'}})),'--tools')).toBe('Write,Edit');
  });
  it('mounts each linked folder with one --add-dir',()=>{
    const args=claudeArguments(request('claude',root,{tools:{...none,fileRead:true,linkedReadDirs:['C:\\ws\\groups\\a','C:\\ws\\groups\\b']}}));
    const dirs=args.flatMap((arg,index)=>args[index-1]==='--add-dir'?[arg]:[]);
    expect(dirs).toEqual(['C:\\ws\\groups\\a','C:\\ws\\groups\\b']);
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('--tools'));
  });
  it('mounts the workspace root for an admin job running below it, before the linked folders',()=>{
    const args=claudeArguments(request('claude',root,{tools:{localTools:true,fileRead:true,fileWrite:true,linkedReadDirs:[],workspaceRootDir:'C:\\ws',level:'workspace_write'}}));
    expect(args.flatMap((arg,index)=>args[index-1]==='--add-dir'?[arg]:[])).toEqual(['C:\\ws']);
    expect(claudeArguments(request('claude',root))).not.toContain('--add-dir');
    const both=claudeArguments(request('claude',root,{tools:{...none,fileRead:true,linkedReadDirs:['C:\\ws\\groups\\a'],workspaceRootDir:null}}));
    expect(both.flatMap((arg,index)=>both[index-1]==='--add-dir'?[arg]:[])).toEqual(['C:\\ws\\groups\\a']);
  });
  it.each([
    ['read_only','Read,Glob,Grep',false],
    ['workspace_write','Read,Glob,Grep,Write,Edit',true],
    ['trust','Read,Glob,Grep,Write,Edit,WebFetch,WebSearch',true],
  ] as const)('builds Claude tool flags for %s', (level,tools,hasWrite) => {
    const args=claudeArguments({...request('claude',root,{tools:{...request('claude',root).tools,level}}),mcp});
    expect(value(args,'--tools')).toBe(tools);
    expect(value(args,'--allowedTools')).not.toContain('Bash');
    expect(value(args,'--allowedTools')).toContain(hasWrite?'Write,Edit':'mcp__linejs__');
  });
  it.each(['read_only','workspace_write','trust','full'] as const)('denies Bash on fresh and resumed %s launches', level => {
    for (const resumeSessionId of [undefined,'session-1']) {
      const requestForLevel={...request('claude',root,{tools:{...request('claude',root).tools,level}}),mcp,...(resumeSessionId?{resumeSessionId}:{})};
      const args=claudeArguments(requestForLevel);
      expect(value(args,'--disallowedTools')).toContain('Bash');
      expect(args.indexOf('--disallowedTools')).toBeLessThan(args.indexOf('--resume')===-1?args.length:args.indexOf('--resume'));
      if(args.includes('--tools')) expect(value(args,'--tools')).not.toContain('Bash');
      if(args.includes('--allowedTools')) expect(value(args,'--allowedTools')).not.toContain('Bash');
      if(level==='full') { expect(args).not.toContain('--tools'); expect(value(args,'--disallowedTools')).toBe('Bash'); }
    }
  });
  it.each(['read_only','workspace_write','trust','full'] as const)('sets interactive MCP Bash behavior for %s', level => {
    for (const interactiveApproval of [false,true]) for (const hasMcp of [false,true]) {
      const req={...request('claude',root,{tools:{...request('claude',root).tools,level,interactiveApproval}}),...(hasMcp?{mcp}:{})};
      const args=claudeArguments(req);
      const active=interactiveApproval&&hasMcp;
      const expected=previousClaudeArguments(req);
      if(!active) expect(args).toEqual(expected);
      else {
        expected[expected.indexOf('--permission-mode')+1]='default';
        expected.splice(expected.indexOf('--permission-mode')+2,0,'--permission-prompt-tool',claudePermissionPromptToolName);
        if(level==='workspace_write'||level==='trust') {
          expected[expected.indexOf('--tools')+1]=`${expected[expected.indexOf('--tools')+1]},Bash`;
          expected.splice(expected.indexOf('--disallowedTools'),2);
          expected.splice(expected.indexOf('--mcp-config'),0,'--settings',JSON.stringify({permissions:{ask:['Bash']}}));
        } else if(level==='full') expected.splice(expected.indexOf('--disallowedTools'),2);
        expect(args).toEqual(expected);
      }
      expect(value(args,'--permission-mode')).toBe(active?'default':'dontAsk');
      expect(args.includes('--permission-prompt-tool')).toBe(active);
      if(active&&level==='workspace_write'||active&&level==='trust') {
        expect(value(args,'--tools')).toContain('Bash');
        expect(JSON.parse(value(args,'--settings')!)).toEqual({permissions:{ask:['Bash']}});
        expect(args).not.toContain('--disallowedTools');
      } else if(active&&level==='full') {
        expect(args).not.toContain('--tools'); expect(args).not.toContain('--disallowedTools'); expect(args).not.toContain('--settings');
      } else {
        expect(value(args,'--disallowedTools')).toBe('Bash');
        if(args.includes('--tools')) expect(value(args,'--tools')).not.toContain('Bash');
      }
      if(args.includes('--allowedTools')) expect(value(args,'--allowedTools')).not.toContain('Bash');
    }
  });
  it('omits --tools and --restricted for full local-tool policy',()=>{
    const args=claudeArguments(request('claude',root,{tools:{...request('claude',root).tools,level:'full'}}));
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--restricted');
  });
  it('requires the policy at the contract boundary and delivers an empty --tools value through the real process host',async()=>{
    const {tools:_tools,...withoutTools}=request('claude',root);
    const events=await collect(bridge('claude').run(withoutTools as AgentRunRequest));
    expect(events).toEqual([{type:'failed',code:'INVALID_REQUEST',message:'Invalid agent request.',retryable:false}]);
    const done=await collect(bridge('claude').run(request('claude',root,{tools:none})));
    const last=done.at(-1);
    expect(last?.type).toBe('completed');
    const args:string[]=JSON.parse(last&&'finalText' in last?last.finalText:'{}').args;
    expect(args[args.indexOf('--tools')+1]).toBe('');
  });
});

describe('Codex fails closed without the local tools permission',()=>{
  it.each([
    ['read_only','read-only'], ['workspace_write','workspace-write'], ['trust','workspace-write'], ['full','danger-full-access'],
  ] as const)('maps %s to sandbox %s', (level,sandbox) => {
    expect(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,level}}),root)).toContain(sandbox);
    expect(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,fileWrite:false}}),root)).toContain('read-only');
  });
  it('refuses to build arguments and the bridge reports PROVIDER_TOOLS_UNSUPPORTED without starting a process',async()=>{
    expect(()=>codexArguments(request('codex',root,{tools:none}),root)).toThrow();
    expect(codexArguments(request('codex',root),root)).toContain('workspace-write');
    expect(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,level:'read_only'}}),root)).toContain('read-only');
    expect(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,level:'full'}}),root)).toContain('danger-full-access');
    expect(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,fileWrite:false}}),root)).toContain('read-only');
    const events=await collect(bridge('codex').run(request('codex',root,{tools:{...none,fileRead:true,fileWrite:true}})));
    expect(events).toEqual([{type:'failed',code:PROVIDER_TOOLS_UNSUPPORTED,message:PROVIDER_TOOLS_UNSUPPORTED_MESSAGE,retryable:false}]);
    expect(PROVIDER_TOOLS_UNSUPPORTED_MESSAGE).toBe('Codex 無法限制本機工具，群組／好友工作請改用 Claude 或由管理者開放本機工作區權限');
    const allowed=await collect(bridge('codex').run(request('codex',root)));
    expect(allowed.at(-1)?.type).toBe('completed');
  });
});
