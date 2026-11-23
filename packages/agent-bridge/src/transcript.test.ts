import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeProjectSlug,claudeTranscriptPath,pickClaudeTranscript,sameProjectDir,slimReason,transcriptBytes} from './transcript.js';

let home:string;
let projects:string;
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'transcript-test-'));
  projects=join(home,'.claude','projects');
  mkdirSync(projects,{recursive:true});
});
afterEach(()=>{rmSync(home,{recursive:true,force:true});});
function transcript(directory:string,id:string,content:string,mtimeSeconds?:number) {
  mkdirSync(join(projects,directory),{recursive:true});
  const path=join(projects,directory,`${id}.jsonl`);
  writeFileSync(path,content);
  if(mtimeSeconds!==undefined) utimesSync(path,mtimeSeconds,mtimeSeconds);
  return path;
}

describe('Claude transcript folder of an account',()=>{
  it('uses <CLAUDE_CONFIG_DIR>/projects when a config directory is set, and the home folder otherwise',()=>{
    const configDir=join(home,'accounts','acct-aaaaaaaaaa');
    const accountProjects=join(configDir,'projects');
    mkdirSync(join(accountProjects,'D--work'),{recursive:true});
    const own=join(accountProjects,'D--work','s1.jsonl');
    writeFileSync(own,'account');
    const shared=transcript('D--work','s1','home-file-longer');
    expect(claudeTranscriptPath('s1','D:\work',home,undefined,configDir)).toBe(own);
    expect(claudeTranscriptPath('s1','D:\work',home)).toBe(shared);
    expect(transcriptBytes('s1','D:\work',home,undefined,configDir)).toBe(7);
  });
});

describe('Claude project slug',()=>{
  it('replaces each character that is not an ASCII letter or digit',()=>{
    expect(claudeProjectSlug('D:\\CliTalkAgent\\.clitalk-rust\\agents\\butler\\default')).toBe('D--CliTalkAgent--clitalk-rust-agents-butler-default');
    expect(claudeProjectSlug('C:\\a b')).toBe('C--a-b');
  });
  it('compares folder names without case and without trailing dashes',()=>{
    expect(sameProjectDir('d--Work--','D--work')).toBe(true);
    expect(sameProjectDir('D--Work-x','D--work')).toBe(false);
  });
});

describe('transcript lookup',()=>{
  it('returns nothing for no file and the one file for one match',()=>{
    expect(pickClaudeTranscript(projects,'abc',undefined)).toBeUndefined();
    const path=transcript('p1','abc','x');
    expect(pickClaudeTranscript(projects,'abc',undefined)).toBe(path);
  });
  it('prefers the folder of the working directory, then the newest file, then the greatest path',()=>{
    const old=transcript('D--other','abc','old',2_000);
    const match=transcript('d--work-dir','abc','match',1_000);
    expect(pickClaudeTranscript(projects,'abc','D:\\work\\dir')).toBe(match);
    expect(pickClaudeTranscript(projects,'abc','E:\\none')).toBe(old);
    expect(pickClaudeTranscript(projects,'abc',undefined)).toBe(old);
    const tie=transcript('z-last','abc','tie',2_000);
    expect(pickClaudeTranscript(projects,'abc',undefined)).toBe(tie);
  });
  it('rejects a session id that could leave the projects folder',()=>{
    transcript('p1','abc','x');
    expect(pickClaudeTranscript(projects,'..\\abc',undefined)).toBeUndefined();
    expect(pickClaudeTranscript(projects,'',undefined)).toBeUndefined();
  });
  it('reads the size of the chosen file and gives 0 when it is not known',()=>{
    transcript('p1','abc','12345');
    expect(claudeTranscriptPath('abc',undefined,home)).toBeDefined();
    expect(transcriptBytes('abc',undefined,home)).toBe(5);
    expect(transcriptBytes('missing',undefined,home)).toBe(0);
    expect(transcriptBytes(undefined,undefined,home)).toBe(0);
    expect(transcriptBytes('abc',undefined,undefined)).toBe(0);
  });
});

describe('Auto-Slim reason',()=>{
  const on={enabled:true};
  it('gives nothing when it is off or below both limits',()=>{
    expect(slimReason(1000,99_000_000,{enabled:false})).toBeUndefined();
    expect(slimReason(119,7_999_999,on)).toBeUndefined();
  });
  it('checks the bytes first',()=>{
    expect(slimReason(500,8_000_000,on)).toBe('bytes');
    expect(slimReason(120,0,on)).toBe('turns');
    expect(slimReason(3,50,{enabled:true,maxTurns:3,maxBytes:100})).toBe('turns');
    expect(slimReason(3,100,{enabled:true,maxTurns:3,maxBytes:100})).toBe('bytes');
  });
});
