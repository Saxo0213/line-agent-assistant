import {describe,expect,it} from 'vitest';
import {claudeArguments,CLAUDE_AUTO_COMPACT_TOKENS} from './claude.js';
import {codexArguments} from './codex.js';
import {request} from './test-support.js';

describe('provider auto-compaction',()=>{
  it('leaves Codex on its default compaction for new and resumed runs',()=>{
    for(const resumeSessionId of [undefined,'sess-1']) {
      const args=codexArguments({...request('codex','C:\ws'),...(resumeSessionId?{resumeSessionId}:{})},'C:\ws');
      expect(args.join(' ')).not.toContain('model_auto_compact_token_limit');
    }
  });
  it('passes --autocompact 400000 to Claude and keeps --resume last',()=>{
    const args=claudeArguments({...request('claude','C:\ws'),resumeSessionId:'sess-1'});
    expect(CLAUDE_AUTO_COMPACT_TOKENS).toBe(400000);
    expect(args[args.indexOf('--autocompact')+1]).toBe('400000');
    expect(args.slice(-2)).toEqual(['--resume','sess-1']);
  });
});
