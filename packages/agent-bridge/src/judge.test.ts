import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {join} from 'node:path';
import {AgentCliBridge,claudeJudgeArguments,codexJudgeArguments,NodeProcessRunner,type JudgeRequest} from './index.js';
import {cleanup,fixtures,temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
const judgeRequest=(provider:'claude'|'codex',extra:Partial<JudgeRequest>={}):JudgeRequest=>({provider,prompt:'new messages',systemPrompt:'You are a judge.',workspacePath:root,...extra});
const bridge=(provider:'claude'|'codex',scenario='echo')=>new AgentCliBridge({enabled:true,workspaceRoots:[],runner:new NodeProcessRunner(),
  resolver:{resolve:async()=>({file:process.execPath,prefixArgs:[join(fixtures,'bridge-cli.cjs'),provider,scenario],version:provider==='codex'?'0.144.5':'2.1.295',kind:'native'})}});

describe('free-mode judge arguments',()=>{
  it('runs Claude on Haiku with no tools, no MCP and no skills',()=>{
    const args=claudeJudgeArguments(judgeRequest('claude'));
    expect(args[args.indexOf('--model')+1]).toBe('haiku');
    expect(args[args.indexOf('--tools')+1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config')+1]).toBe('{"mcpServers":{}}');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--resume');
    expect(claudeJudgeArguments(judgeRequest('claude',{resumeSessionId:'abc'}))).toEqual(expect.arrayContaining(['--resume','abc']));
  });
  it('runs Codex read-only with low reasoning effort',()=>{
    const args=codexJudgeArguments(judgeRequest('codex'),root);
    expect(args[args.indexOf('-c')+1]).toBe('model_reasoning_effort="low"');
    expect(args[args.indexOf('--sandbox')+1]).toBe('read-only');
    expect(args).toContain('--ignore-user-config');
    expect(args.at(-1)).toBe('-');
    expect(codexJudgeArguments(judgeRequest('codex',{resumeSessionId:'abc'}),root).slice(-3)).toEqual(['resume','abc','-']);
  });
});

describe('AgentCliBridge.judge',()=>{
  it.each(['claude','codex'] as const)('returns the answer and session id for %s',async provider=>{
    const result=await bridge(provider).judge(judgeRequest(provider));
    const payload=JSON.parse(result.text);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.cwd.toLowerCase()).toBe(root.toLowerCase());
    expect(payload.input).toContain('new messages');
  });
  it('rejects on malformed output, non-zero exit and an invalid resume id',async()=>{
    await expect(bridge('claude','malformed').judge(judgeRequest('claude'))).rejects.toThrow();
    await expect(bridge('claude','nonzero').judge(judgeRequest('claude'))).rejects.toThrow();
    await expect(bridge('claude').judge(judgeRequest('claude',{resumeSessionId:'bad id;'}))).rejects.toThrow();
  });
});
