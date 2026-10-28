import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {join} from 'node:path';
import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {PROVIDER_TOOLS_UNSUPPORTED,PROVIDER_TOOLS_UNSUPPORTED_MESSAGE} from '@line-agent/contracts';
import {AgentCliBridge} from './index.js';
import {claudeArguments,claudeBuiltInTools,claudePermissionPath,claudeProjectDenyRules} from './claude.js';
import {claudeMcpConfig,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
import {codexArguments} from './codex.js';
import {NodeProcessRunner} from './process-runner.js';
import {cleanup,fixtures,request,temporaryDirectory} from './test-support.js';

const mcp={endpoint:'http://127.0.0.1:38471/mcp',token:`li_job_${'T'.repeat(43)}`};
const none={localTools:false,fileRead:false,fileWrite:false,linkedReadDirs:[],projectDirs:[],workspaceRootDir:null,level:'read_only' as const,webTools:false,interactiveApproval:false};
let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
async function collect(events:AsyncIterable<AgentEvent>) {const out:AgentEvent[]=[];for await(const event of events) out.push(event);return out;}
const value=(args:string[],flag:string)=>args[args.indexOf(flag)+1];
function previousClaudeArguments(req:AgentRunRequest) {
  const level=req.tools.level??(req.tools.localTools?'workspace_write':'read_only');
  const fullAccess=level==='full'&&req.tools.localTools;
  const allowed=[...(req.mcp?claudeMcpToolNames():[]),...(req.tools.fileWrite&&['workspace_write','trust','full'].includes(level)?['Write','Edit']:[])];
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--autocompact','400000',...(fullAccess?[]:['--restricted']),'--permission-mode','dontAsk','--strict-mcp-config',...[...(req.tools.workspaceRootDir?[req.tools.workspaceRootDir]:[]),...req.tools.linkedReadDirs].flatMap(directory=>['--add-dir',directory]),...(fullAccess?[]:['--tools',claudeBuiltInTools(req.tools).join(',')]),'--disallowedTools','Bash',...(req.mcp?['--mcp-config',claudeMcpConfig(req.mcp)]:[]),...(allowed.length?['--allowedTools',allowed.join(',')]:[]),...(req.resumeSessionId?['--resume',req.resumeSessionId]:[])];
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
    expect(value(args,'--allowedTools')).toBe('mcp__linejs__list_targets,mcp__linejs__query_target_messages,mcp__linejs__query_target_messages_by_time,mcp__linejs__query_agent_room_history,mcp__linejs__list_send_targets,mcp__linejs__send_to_target,mcp__linejs__list_schedules,mcp__linejs__create_schedule,mcp__linejs__update_schedule,mcp__linejs__delete_schedule');
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

describe('project folders (/folder) reach the providers',()=>{
  const ro={path:'D:\\Company\\Docs Read',writable:false};
  const rw={path:'D:\\Company\\Docs Write',writable:true};
  const projectTools=(extra={})=>({localTools:true,fileRead:true,fileWrite:true,linkedReadDirs:[],projectDirs:[ro,rw],workspaceRootDir:null,level:'workspace_write' as const,interactiveApproval:false,...extra});
  const dirsOf=(args:string[])=>args.flatMap((arg,index)=>args[index-1]==='--add-dir'?[arg]:[]);
  it('writes permission-rule paths in the POSIX form Claude matches, with // for an absolute path',()=>{
    expect(claudePermissionPath('D:\\Company\\Docs')).toBe('//d/Company/Docs');
    expect(claudePermissionPath('c:\\Users\\boss\\專案 一\\')).toBe('//c/Users/boss/專案 一');
    expect(claudePermissionPath('\\\\server\\share\\Docs')).toBe('///server/share/Docs');
  });
  it('mounts every project folder with --add-dir after the linked folders',()=>{
    const args=claudeArguments(request('claude',root,{tools:projectTools({linkedReadDirs:['C:\\ws\\groups\\a'],workspaceRootDir:'C:\\ws'})}));
    expect(dirsOf(args)).toEqual(['C:\\ws','C:\\ws\\groups\\a',ro.path,rw.path]);
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('--tools'));
  });
  it('denies Edit (which covers Write and NotebookEdit) under read-only folders only, through --settings',()=>{
    const args=claudeArguments(request('claude',root,{tools:projectTools()}));
    expect(JSON.parse(value(args,'--settings'))).toEqual({permissions:{deny:['Edit(//d/Company/Docs Read/**)']}});
    expect(value(args,'--tools')).toBe('Read,Glob,Grep,Write,Edit');
    expect(value(args,'--allowedTools')).toContain('Write,Edit');
    expect(claudeProjectDenyRules([rw])).toEqual([]);
    expect(claudeProjectDenyRules(undefined)).toEqual([]);
  });
  it('writes UNC rules with the root-relative double slash kept',()=>{
    expect(claudeProjectDenyRules([{path:'\\\\server\\share\\Docs',writable:false}])[0]).toBe('Edit(///server/share/Docs/**)');
  });
  it('merges the deny rules with the interactive Bash ask rule into one --settings value',()=>{
    const args=claudeArguments({...request('claude',root,{tools:projectTools({interactiveApproval:true})}),mcp});
    expect(args.filter(arg=>arg==='--settings')).toHaveLength(1);
    const settings=JSON.parse(value(args,'--settings'));
    expect(settings.permissions.ask).toEqual(['Bash']);
    expect(settings.permissions.deny).toHaveLength(1);
  });
  it('adds nothing when there are no project folders or all of them are writable',()=>{
    expect(claudeArguments(request('claude',root))).toEqual(previousClaudeArguments(request('claude',root)));
    const writableOnly=claudeArguments(request('claude',root,{tools:projectTools({projectDirs:[rw]})}));
    expect(dirsOf(writableOnly)).toEqual([rw.path]);
    expect(writableOnly).not.toContain('--settings');
  });
  it('keeps the deny rules in full-access mode too (a deny rule beats the pre-approved Write/Edit)',()=>{
    const args=claudeArguments(request('claude',root,{tools:projectTools({level:'full'})}));
    expect(args).not.toContain('--tools');
    expect(JSON.parse(value(args,'--settings')).permissions.deny).toHaveLength(1);
    expect(value(args,'--allowedTools')).toContain('Write,Edit');
  });

  it('Codex adds each writable project folder with --add-dir in the workspace-write sandbox, before resume',()=>{
    const fresh=codexArguments(request('codex',root,{tools:projectTools()}),root);
    expect(value(fresh,'--sandbox')).toBe('workspace-write');
    expect(dirsOf(fresh)).toEqual([rw.path]);
    const resumed=codexArguments({...request('codex',root,{tools:projectTools()}),resumeSessionId:'thread-1'},root);
    expect(dirsOf(resumed)).toEqual([rw.path]);
    expect(resumed.indexOf('--add-dir')).toBeLessThan(resumed.indexOf('resume'));
  });
  it('Codex adds no writable directory in a read-only sandbox, and never widens to full access around a read-only folder',()=>{
    const readOnly=codexArguments(request('codex',root,{tools:projectTools({fileWrite:false})}),root);
    expect(value(readOnly,'--sandbox')).toBe('read-only');
    expect(readOnly).not.toContain('--add-dir');
    const levelReadOnly=codexArguments(request('codex',root,{tools:projectTools({level:'read_only'})}),root);
    expect(levelReadOnly).not.toContain('--add-dir');
    const full=codexArguments(request('codex',root,{tools:projectTools({level:'full'})}),root);
    expect(value(full,'--sandbox')).toBe('workspace-write');
    expect(dirsOf(full)).toEqual([rw.path]);
    const fullAllWritable=codexArguments(request('codex',root,{tools:projectTools({level:'full',projectDirs:[rw]})}),root);
    expect(value(fullAllWritable,'--sandbox')).toBe('danger-full-access');
    expect(codexArguments(request('codex',root),root)).not.toContain('--add-dir');
  });
});

describe('project folder writes never widen elsewhere',()=>{
  const rw={path:'D:\\Company\\Docs Write',writable:true};
  const tools=(extra={})=>({localTools:true,fileRead:true,fileWrite:true,linkedReadDirs:[],projectDirs:[rw],workspaceRootDir:null,level:'workspace_write' as const,interactiveApproval:false,...extra});
  const own='C:\\ws\\groups\\own';
  it('Claude denies writes in the own chat folder when fileWrite exists only for a writable project folder',()=>{
    const args=claudeArguments({...request('claude',own,{tools:tools({ownFolderReadOnly:true})})});
    const deny=JSON.parse(value(args,'--settings')).permissions.deny as string[];
    expect(deny).toEqual(['Edit(//c/ws/groups/own/**)']);
    expect(JSON.stringify(deny)).not.toContain('Docs Write');
  });
  it('Claude leaves the own folder writable when the principal can write it, and for admin',()=>{
    expect(claudeArguments(request('claude',own,{tools:tools()}))).not.toContain('--settings');
  });
  it('Claude always denies writes in linked read-only folders while file writes are on',()=>{
    const args=claudeArguments(request('claude',own,{tools:tools({projectDirs:[],linkedReadDirs:['C:\\ws\\groups\\a','C:\\ws\\groups\\b']})}));
    const deny=JSON.parse(value(args,'--settings')).permissions.deny as string[];
    expect(deny).toEqual(['Edit(//c/ws/groups/a/**)','Edit(//c/ws/groups/b/**)']);
    expect(deny.some(rule=>!rule.startsWith('Edit('))).toBe(false);
    const noWrite=claudeArguments(request('claude',own,{tools:tools({projectDirs:[],fileWrite:false,linkedReadDirs:['C:\\ws\\groups\\a']})}));
    expect(noWrite).not.toContain('--settings');
  });
  it('Codex stays read-only when the own folder is not writable, even with a writable project folder',()=>{
    const args=codexArguments(request('codex',own,{tools:tools({ownFolderReadOnly:true})}),own);
    expect(value(args,'--sandbox')).toBe('read-only');
    expect(args).not.toContain('--add-dir');
  });
});

describe('web tools for resolved principals',()=>{
  const web=(extra={})=>({...none,webTools:true,...extra});
  const lists=(args:string[])=>[value(args,'--tools')!.split(','),(value(args,'--allowedTools')??'').split(',')];
  it.each([
    ['user without local tools',web({fileRead:true,level:'workspace_write' as const})],
    ['free-mode member',web()],
    ['admin workspace_write',web({localTools:true,fileRead:true,fileWrite:true,level:'workspace_write' as const})],
    ['read_only',web({localTools:true,fileRead:true,level:'read_only' as const})],
    ['trust',web({localTools:true,fileRead:true,fileWrite:true,level:'trust' as const})],
  ])('adds WebSearch and WebFetch once to --tools and --allowedTools: %s',(_,tools)=>{
    const [toolList,allowed]=lists(claudeArguments({...request('claude',root,{tools}),mcp}));
    for(const name of ['WebSearch','WebFetch']) {
      expect(toolList.filter(item=>item===name)).toHaveLength(1);
      expect(allowed.filter(item=>item===name)).toHaveLength(1);
    }
    expect(toolList).not.toContain('Bash');
  });
  it('gives an unresolved principal no web tools and leaves full access unrestricted',()=>{
    const args=claudeArguments(request('claude',root,{tools:none}));
    expect(value(args,'--tools')).toBe('');
    expect(args).not.toContain('--allowedTools');
    const full=claudeArguments(request('claude',root,{tools:web({localTools:true,fileRead:true,fileWrite:true,level:'full'})}));
    expect(full).not.toContain('--tools');
    expect(value(full,'--allowedTools')??'').not.toContain('Web');
  });
  it('does not duplicate the extension toggles',()=>{
    const toggles={webSearch:true,webFetch:true,bash:false,fileRead:false,fileWrite:false};
    const [toolList,allowed]=lists(claudeArguments(request('claude',root,{tools:web(),extensions:{servers:[],tools:toggles}})));
    expect(toolList.filter(item=>item==='WebSearch')).toHaveLength(1);
    expect(allowed.filter(item=>item==='WebFetch')).toHaveLength(1);
  });
  it('enables Codex live web search once',()=>{
    const flag=(args:string[])=>args.filter((arg,index)=>args[index-1]==='-c'&&arg==='web_search="live"').length;
    expect(flag(codexArguments(request('codex',root),'C:\ws'))).toBe(0);
    expect(flag(codexArguments(request('codex',root,{tools:{...request('codex',root).tools,webTools:true}}),'C:\ws'))).toBe(1);
    const both=request('codex',root,{tools:{...request('codex',root).tools,webTools:true},extensions:{servers:[],tools:{webSearch:true,webFetch:false,bash:false,fileRead:false,fileWrite:false}}});
    expect(flag(codexArguments(both,'C:\ws'))).toBe(1);
  });
});
