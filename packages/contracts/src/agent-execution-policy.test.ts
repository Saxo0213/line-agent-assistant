import { describe, expect, it } from 'vitest';
import { decideToolUse } from './agent-execution-policy.js';

describe('decideToolUse', () => {
  it.each(['read_only', 'workspace_write', 'trust', 'full'] as const)('Bash exact command rules at %s', level => {
    const command=' git status  ';
    const entries=[{kind:'bash_command' as const,value:command}];
    const expected=level==='read_only'?'deny':level==='full'?'allow':'allow';
    expect(decideToolUse(level,entries,'operator','Bash',{command},null)).toBe(expected);
    for (const other of ['git status',' git status   ',' GIT status  ']) {
      expect(decideToolUse(level,entries,'operator','Bash',{command:other},null)).toBe(level==='read_only'?'deny':level==='full'?'allow':'ask');
    }
    expect(decideToolUse(level,entries,'operator','bash',{command},null)).toBe(expected);
    expect(decideToolUse(level,entries,'operator','Bash',{},null)).toBe(level==='workspace_write'||level==='trust'?'deny':expected);
    expect(decideToolUse(level,entries,'operator','Bash',{command:1},null)).toBe(level==='workspace_write'||level==='trust'?'deny':expected);
  });
  it.each(['operator','admin','user','unresolved'] as const)('%s principal cannot receive ask for any level', principal => {
    for (const level of ['read_only','workspace_write','trust','full'] as const) {
      const decision=decideToolUse(level,[],principal,'CustomTool',{},null);
      if (principal==='operator'&&(level==='read_only'||level==='workspace_write')) expect(decision).toBe('ask'); else if(principal!=='operator') expect(decision).not.toBe('ask');
    }
  });
  it.each(['admin','user','unresolved'] as const)('%s principal cannot use an allowlisted Bash command at any level', principal => {
    const command = 'git status';
    const entries = [{ kind: 'bash_command' as const, value: command }];
    for (const level of ['read_only','workspace_write','trust','full'] as const) {
      expect(decideToolUse(level, entries, principal, 'Bash', { command }, null)).toBe('deny');
    }
  });

  it.each([
    ['read_only','Read',{file_path:'C:\\work\\a'},'allow'], ['read_only','Write',{file_path:'C:\\work\\a'},'deny'],
    ['read_only','WebFetch',{},'ask'], ['read_only','mcp__linejs__list_targets',{},'allow'],
    ['workspace_write','Write',{file_path:'C:\\work\\a'},'ask'], ['trust','WebFetch',{},'allow'],
    ['full','Write',{file_path:'D:\\outside\\a'},'allow'], ['full','Other',{},'allow'],
  ] as const)('level matrix %s / %s -> %s', (level,tool,input,want) => {
    expect(decideToolUse(level, [], 'operator', tool, input, null)).toBe(want);
  });
  it('keeps write evidence and principal boundaries', () => {
    expect(decideToolUse('workspace_write', [], 'operator', 'Write', {file_path:'C:\\work\\x'}, {resolvedTarget:'C:\\work\\x',resolvedWorkspaceRoot:'C:\\work'})).toBe('allow');
    expect(decideToolUse('full', [{kind:'tool',value:'WebSearch'}], 'unresolved', 'WebSearch', {}, null)).toBe('deny');
  });
});
