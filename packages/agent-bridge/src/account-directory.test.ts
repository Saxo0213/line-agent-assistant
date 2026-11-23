import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdir,readFile,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ACCOUNT_MARKER,accountCredentialFile,accountDirectory,createAccountDirectory,removeAccountDirectory} from './account-directory.js';
import {accountEnvironment} from './child-environment.js';
import {cleanup,temporaryDirectory} from './test-support.js';

let root:string;
beforeEach(async()=>{root=await temporaryDirectory();});
afterEach(async()=>{await cleanup(root);});
const exists=(path:string)=>stat(path).then(()=>true,()=>false);

describe('managed account directory',()=>{
  it('creates the directory with a marker that holds the id, and keeps an existing marker',async()=>{
    const directory=await createAccountDirectory(root,'acct-0123456789');
    expect(directory).toBe(join(root,'acct-0123456789'));
    expect(await readFile(join(directory,ACCOUNT_MARKER),'utf8')).toBe('acct-0123456789');
    await writeFile(join(directory,ACCOUNT_MARKER),'kept');
    await createAccountDirectory(root,'acct-0123456789');
    expect(await readFile(join(directory,ACCOUNT_MARKER),'utf8')).toBe('kept');
  });
  it('deletes the directory only when the marker text equals the id',async()=>{
    const directory=await createAccountDirectory(root,'acct-0123456789');
    await writeFile(join(directory,'.credentials.json'),'{}');
    await writeFile(join(directory,ACCOUNT_MARKER),'acct-0123456789\n');
    expect(await removeAccountDirectory(root,'acct-0123456789')).toBe('removed');
    expect(await exists(directory)).toBe(false);
    expect(await removeAccountDirectory(root,'acct-0123456789')).toBe('missing');
  });
  it('refuses a marker that does not match, and a missing marker',async()=>{
    const directory=await createAccountDirectory(root,'acct-0123456789');
    await writeFile(join(directory,ACCOUNT_MARKER),'acct-other');
    expect(await removeAccountDirectory(root,'acct-0123456789')).toBe('marker_mismatch');
    expect(await exists(directory)).toBe(true);
    const bare=join(root,'acct-bare');
    await mkdir(bare);
    expect(await removeAccountDirectory(root,'acct-bare')).toBe('marker_mismatch');
    expect(await exists(bare)).toBe(true);
  });
  it('refuses an id that leaves the root or names a system source',()=>{
    for(const id of ['..','../x','a/b','a\\b','','claude','codex','x'.repeat(65)]) expect(()=>accountDirectory(root,id)).toThrow('Invalid account id');
  });
  it('does not follow a link that points outside the root',async()=>{
    const outside=await temporaryDirectory();
    try {
      await writeFile(join(outside,ACCOUNT_MARKER),'acct-link');
      await symlink(outside,join(root,'acct-link'),'junction');
      expect(await removeAccountDirectory(root,'acct-link')).toBe('marker_mismatch');
      expect(await exists(join(outside,ACCOUNT_MARKER))).toBe(true);
    } finally {await cleanup(outside);}
  });
  it('names the login file of each provider',()=>{
    expect(accountCredentialFile('claude')).toBe('.credentials.json');
    expect(accountCredentialFile('codex')).toBe('auth.json');
  });
});

describe('accountEnvironment',()=>{
  it('gives no variable for the system Claude source',()=>{
    expect(accountEnvironment('claude',undefined,undefined,{CLAUDE_CONFIG_DIR:'C:\\host'})).toEqual({});
    expect(accountEnvironment('claude',{id:'claude',kind:'system'},root,{})).toEqual({});
  });
  it('gives the parent CODEX_HOME, or <home>/.codex when it is empty, for the system Codex source',()=>{
    expect(accountEnvironment('codex',undefined,undefined,{CODEX_HOME:'C:\\parent'})).toEqual({CODEX_HOME:'C:\\parent'});
    expect(accountEnvironment('codex',{id:'codex',kind:'system'},undefined,{CODEX_HOME:'',USERPROFILE:'C:\\Users\\fake'})).toEqual({CODEX_HOME:'C:\\Users\\fake\\.codex'});
  });
  it('gives the account directory for a managed source and needs the accounts directory',()=>{
    const account={id:'acct-0123456789',kind:'managed' as const};
    expect(accountEnvironment('claude',account,root,{})).toEqual({CLAUDE_CONFIG_DIR:join(root,'acct-0123456789')});
    expect(accountEnvironment('codex',account,root,{CODEX_HOME:'C:\\parent'})).toEqual({CODEX_HOME:join(root,'acct-0123456789')});
    expect(()=>accountEnvironment('claude',account,undefined,{})).toThrow();
    expect(()=>accountEnvironment('claude',{id:'..',kind:'managed'},root,{})).toThrow();
  });
});
