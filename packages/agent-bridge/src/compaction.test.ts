import {describe,expect,it} from 'vitest';
import {claudeArguments,claudeIsTaskNotification,claudeIsTurnActivity,claudeResidentArguments,claudeResultOf,claudeToolArguments,claudeUserTurnLine} from './claude.js';
import {codexArguments} from './codex.js';
import {gitBashPath} from './child-environment.js';
import {request} from './test-support.js';

describe('provider auto-compaction',()=>{
  it('leaves Codex on its default compaction for new and resumed runs',()=>{
    for(const resumeSessionId of [undefined,'sess-1']) {
      const args=codexArguments({...request('codex','C:\ws'),...(resumeSessionId?{resumeSessionId}:{})},'C:\ws');
      expect(args.join(' ')).not.toContain('model_auto_compact_token_limit');
    }
  });
  it('does not pass --autocompact to Claude and keeps --resume last',()=>{
    const args=claudeArguments({...request('claude','C:ws'),resumeSessionId:'sess-1'});
    expect(args).not.toContain('--autocompact');
    expect(args.slice(-2)).toEqual(['--resume','sess-1']);
  });
  it('builds resident arguments in CliTalkAgent order, then the LINE tool arguments',()=>{
    const req={...request('claude','C:ws'),resumeSessionId:'sess-1'};
    const args=claudeResidentArguments(req,{systemPrompt:'  persona  ',model:undefined,mcpEndpoint:undefined});
    const tools=claudeToolArguments(req,undefined);
    expect(args.slice(0,args.length-tools.length)).toEqual(['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--setting-sources','project,local','--append-system-prompt','persona','--resume','sess-1','--model','opus']);
    expect(args.slice(-tools.length)).toEqual(tools);
    expect(tools).not.toContain('--resume');
    expect(args.filter(arg=>arg==='--resume')).toHaveLength(1);
    expect(claudeResidentArguments({...req,resumeSessionId:undefined as never},{model:'sonnet'})).not.toContain('--resume');
    expect(claudeResidentArguments(req,{model:'sonnet'})).toContain('sonnet');
    expect(claudeToolArguments(req,'http://127.0.0.1:1/mcp').join(' ')).toContain('--mcp-config');
  });
  it('writes one user turn line and classifies resident lines',()=>{
    expect(claudeUserTurnLine('hi')).toBe(JSON.stringify({type:'user',message:{role:'user',content:'hi'}})+'\n');
    expect(claudeIsTurnActivity({type:'assistant'})).toBe(true);
    expect(claudeIsTurnActivity({type:'stream_event'})).toBe(true);
    expect(claudeIsTurnActivity({type:'result'})).toBe(false);
    expect(claudeIsTaskNotification({type:'user',origin:{kind:'task-notification'}})).toBe(true);
    expect(claudeIsTaskNotification({type:'user',message:{origin:{kind:'task-notification'}}})).toBe(true);
    expect(claudeIsTaskNotification({type:'user',message:{content:[{type:'text',text:'<task-notification>x'}]}})).toBe(true);
    expect(claudeIsTaskNotification({type:'user',message:{content:'plain'}})).toBe(false);
    expect(claudeIsTaskNotification({type:'assistant',origin:{kind:'task-notification'}})).toBe(false);
    expect(claudeResultOf({type:'result',result:'ok'})).toEqual({text:'ok',isError:false});
    expect(claudeResultOf({type:'result',is_error:true,result:'bad'})).toEqual({text:'bad',isError:true});
    expect(claudeResultOf({type:'assistant'})).toBeUndefined();
  });
  it('finds Git Bash in the fixed candidates and ignores a bad parent value',()=>{
    const seen:string[]=[];
    expect(gitBashPath({},path=>{seen.push(path);return false;})).toBeUndefined();
    expect(seen).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe','C:\\Program Files (x86)\\Git\\bin\\bash.exe']);
    expect(gitBashPath({},path=>path==='C:\\Program Files (x86)\\Git\\bin\\bash.exe')).toBe('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    for(const bad of ['bash.exe','C:\\tools\\sh.exe','relative\\bash.exe']) {
      expect(gitBashPath({CLAUDE_CODE_GIT_BASH_PATH:bad},path=>path===bad||path==='C:\\Program Files\\Git\\bin\\bash.exe')).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    }
    expect(gitBashPath({CLAUDE_CODE_GIT_BASH_PATH:'D:\\Git\\bin\\bash.exe'},()=>true)).toBe('D:\\Git\\bin\\bash.exe');
  });
});
