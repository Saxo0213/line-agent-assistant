import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {claudeArguments,claudeChatRulesDenyRules,claudePermissionPath} from './claude.js';
import {projectInstructionDigest} from './project-instructions.js';
import {residentArgsHash} from './index.js';
import {cleanup,request,temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
const settings=(args:string[])=>JSON.parse(args[args.indexOf('--settings')+1]!) as {permissions:{deny?:string[]}};

describe('per-chat rule files of a protected job',()=>{
  it('puts Edit deny rules for AGENTS.md, CLAUDE.md and rules/** into the Claude settings',()=>{
    const base=request('claude',root,{tools:{...request('claude',root).tools,chatRulesProtected:true}});
    const deny=settings(claudeArguments(base)).permissions.deny!;
    const path=claudePermissionPath(root);
    expect(deny).toEqual(expect.arrayContaining([`Edit(${path}/AGENTS.md)`,`Edit(${path}/CLAUDE.md)`,`Edit(${path}/rules/**)`]));
    expect(claudeChatRulesDenyRules(root)).toHaveLength(3);
  });
  it('adds no rule for a job that may change the files',()=>{
    expect(claudeArguments(request('claude',root))).not.toContain('--settings');
  });
});

describe('resident process replacement',()=>{
  const hash=()=>residentArgsHash(['--x'],undefined,root,'',{});
  it('changes the hash when AGENTS.md or CLAUDE.md appears, changes or disappears',async()=>{
    const none=hash();
    expect(hash()).toBe(none);
    await writeFile(join(root,'AGENTS.md'),'rule one');
    const one=hash();
    expect(one).not.toBe(none);
    await writeFile(join(root,'AGENTS.md'),'rule two');
    expect(hash()).not.toBe(one);
    const two=hash();
    await writeFile(join(root,'CLAUDE.md'),'@AGENTS.md\n');
    expect(hash()).not.toBe(two);
    expect(projectInstructionDigest(root)).toHaveLength(64);
  });
});
