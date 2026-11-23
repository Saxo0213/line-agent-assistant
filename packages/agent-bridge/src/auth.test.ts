import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, temporaryDirectory } from './test-support.js';
import { AuthController } from './auth.js';
import { NodeProcessRunner } from './process-runner.js';
import type { ProcessSpec } from './process-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/auth-cli.cjs', import.meta.url));
const runner = new NodeProcessRunner();
function controller(mode: string, environment: NodeJS.ProcessEnv = process.env) {
  return new AuthController({
    runner, environment,
    resolver: { resolve: async () => ({ file: process.execPath, prefixArgs: [fixture, mode], version: mode === 'codex' ? '0.144.5' : '2.1.295', kind: 'native' as const }) },
  });
}

describe('CLI auth status using real harmless processes', () => {
  it('accepts authenticated Claude JSON and returns only allowlisted metadata', async () => {
    const status = await controller('claude').getAuthStatus('claude');
    expect(status).toMatchObject({installed:true,status:'authenticated'});
    expect(JSON.stringify(status)).not.toMatch(/private@|orgId|accessToken|should-not/);
  });
  it('accepts verified CLI authentication without restricting credential source', async () => {
    expect(await controller('api').getAuthStatus('claude')).toMatchObject({status:'authenticated'});
    expect(await controller('console').getAuthStatus('claude')).toMatchObject({status:'authenticated'});
  });
  it('reports logged out without treating the CLI nonzero status as a crash', async () => {
    expect(await controller('logged-out').getAuthStatus('claude')).toMatchObject({installed:true,status:'logged_out'});
  });
  it('isolates all app secrets and runtime injection while returning override names only', async () => {
    const status = await controller('env', {
      ...process.env, OPENAI_API_KEY:'secret-openai', ANTHROPIC_API_KEY:'secret-anthropic', CODEX_ACCESS_TOKEN:'secret-token',
      ANTHROPIC_BASE_URL:'https://private.invalid', LINE_TOKEN:'line-secret', DATABASE_URL:'database-secret', APP_SECRET:'app-secret',
      NODE_OPTIONS:'--require missing-attacker-module', NODE_PATH:'C:\\private-module',
    }).getAuthStatus('claude');
    expect(status.status).toBe('authenticated');
    expect(status.isolatedOverrideNames).toEqual(expect.arrayContaining(['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_ACCESS_TOKEN','ANTHROPIC_BASE_URL']));
    expect(JSON.stringify(status)).not.toMatch(/secret-|private-module|private\.invalid/);
  });
  it('contains resolver errors without leaking credential values or paths', async () => {
    const auth = new AuthController({runner,resolver:{resolve:async () => { throw new Error('C:\\Users\\Private\\auth.json sk-secret'); }}});
    expect(await auth.getAuthStatus('codex')).toMatchObject({status:'error'});
    expect(JSON.stringify(await controller('error').getAuthStatus('claude'))).not.toMatch(/Private|credentials|sk-super|OPENAI_API_KEY=/);
  });
  it('reports an absent executable without affecting callers', async () => {
    const auth = new AuthController({runner,resolver:{resolve:async () => null}});
    expect(await auth.getAuthStatus('codex')).toMatchObject({installed:false,status:'not_installed'});
  });
  it.each(['codex','claude'] as const)('uses the visible official login and logout for %s', async provider => {
    const home = await temporaryDirectory();
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start({...spec,interactive:false}); }},
      environment:{...process.env,CODEX_HOME:home},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'logged-out'],version:'0.144.5',kind:'native'})},
    });
    try {
      expect(await auth.openLogin(provider)).toMatchObject({ok:true});
      // The console always opens: no status check before login (CliTalkAgent).
      const status = 0;
      expect(specifications).toHaveLength(status + 1);
      expect(specifications[status]?.interactive).toBe(true);
      expect(specifications[status]?.args.slice(2)).toEqual(provider === 'codex' ? ['login'] : ['auth','login']);
      expect(await auth.logout(provider)).toMatchObject({ok:true});
      expect(specifications[status + 1]?.args.slice(2)).toEqual(provider === 'codex' ? ['logout'] : ['auth','logout']);
    } finally { await cleanup(home); }
  });
  it('opens the login console even when the official CLI is already authenticated', async () => {
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start({...spec,interactive:false}); }},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'claude'],version:'0.144.5',kind:'native'})},
    });
    expect(await auth.openLogin('claude')).toMatchObject({ok:true});
    expect(specifications).toHaveLength(1);
    expect(specifications[0]?.interactive).toBe(true);
    expect(specifications[0]?.args.slice(2)).toEqual(['auth','login']);
  });
});

describe('Codex login state from auth.json',() => {
  const setup = async (content: string | null) => {
    const home = await temporaryDirectory();
    if (content !== null) await writeFile(join(home, 'auth.json'), content);
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start(spec); }},
      environment:{...process.env, CODEX_HOME:home},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'codex'],version:'0.144.5',kind:'native' as const})},
    });
    return {auth, specifications, home};
  };
  const status = async (content: string | null) => {
    const {auth, specifications, home} = await setup(content);
    try {
      const result = await auth.getAuthStatus('codex');
      expect(specifications).toHaveLength(0);
      return result;
    } finally { await cleanup(home); }
  };
  it('reports logged out when the file is missing', async () => { expect(await status(null)).toMatchObject({installed:true,status:'logged_out'}); });
  it('reports authenticated with a refresh token and returns no token', async () => {
    const result = await status(JSON.stringify({tokens:{refresh_token:'fake-refresh',id_token:'fake-id'}}));
    expect(result).toMatchObject({status:'authenticated'});
    expect(JSON.stringify(result)).not.toContain('fake-');
  });
  it('reports authenticated with an API key', async () => { expect(await status(JSON.stringify({OPENAI_API_KEY:'fake-key'}))).toMatchObject({status:'authenticated'}); });
  it('reports logged out for empty tokens', async () => {
    expect(await status(JSON.stringify({tokens:{refresh_token:''},OPENAI_API_KEY:''}))).toMatchObject({status:'logged_out'});
    expect(await status('{}')).toMatchObject({status:'logged_out'});
  });
  it('reports an error for bad JSON without echoing the content', async () => {
    const result = await status('{fake-secret');
    expect(result).toMatchObject({status:'error'});
    expect(JSON.stringify(result)).not.toContain('fake-secret');
  });
  it('opens the login console even when the login file is authenticated', async () => {
    const ok = await setup(JSON.stringify({OPENAI_API_KEY:'fake-key'}));
    try {
      expect(await ok.auth.openLogin('codex')).toEqual({ok:true});
      expect(ok.specifications).toHaveLength(1);
      expect(ok.specifications[0]?.args.slice(2)).toEqual(['login']);
      expect(ok.specifications[0]?.accountEnv).toEqual({CODEX_HOME:ok.home});
    } finally { await cleanup(ok.home); }
  });
});

describe('managed account sources', () => {
  const resolver = {resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'claude'],version:'0.144.5',kind:'native' as const})};
  const setup = async () => {
    const accounts = await temporaryDirectory();
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start({...spec,interactive:false}); }},
      environment:{...process.env,CODEX_HOME:'C:\\parent\\codex'}, resolver, accountsDirectory:accounts,
    });
    return {accounts, specifications, auth};
  };
  it('reports managed Claude without its login file as logged out and starts no process', async () => {
    const {accounts, specifications, auth} = await setup();
    try {
      const status = await auth.getAuthStatus('claude',{id:'acct-aaaaaaaaaa',kind:'managed'});
      expect(status).toMatchObject({installed:true,status:'logged_out',sourceId:'acct-aaaaaaaaaa'});
      expect(specifications).toHaveLength(0);
    } finally { await cleanup(accounts); }
  });
  it('checks managed Claude with its login file through auth status with CLAUDE_CONFIG_DIR set', async () => {
    const {accounts, specifications, auth} = await setup();
    try {
      await mkdir(join(accounts,'acct-aaaaaaaaaa'),{recursive:true});
      await writeFile(join(accounts,'acct-aaaaaaaaaa','.credentials.json'),'{"fake":true}');
      const status = await auth.getAuthStatus('claude',{id:'acct-aaaaaaaaaa',kind:'managed'});
      expect(status).toMatchObject({status:'authenticated',sourceId:'acct-aaaaaaaaaa'});
      expect(specifications).toHaveLength(1);
      expect(specifications[0]?.args.slice(2)).toEqual(['auth','status']);
      expect(specifications[0]?.accountEnv).toEqual({CLAUDE_CONFIG_DIR:join(accounts,'acct-aaaaaaaaaa')});
    } finally { await cleanup(accounts); }
  });
  it('reads the auth.json of the managed Codex directory, not the parent CODEX_HOME', async () => {
    const {accounts, specifications, auth} = await setup();
    try {
      await mkdir(join(accounts,'acct-bbbbbbbbbb'),{recursive:true});
      await writeFile(join(accounts,'acct-bbbbbbbbbb','auth.json'),JSON.stringify({OPENAI_API_KEY:'fake-key'}));
      expect(await auth.getAuthStatus('codex',{id:'acct-bbbbbbbbbb',kind:'managed'})).toMatchObject({status:'authenticated',sourceId:'acct-bbbbbbbbbb'});
      expect(await auth.getAuthStatus('codex',{id:'acct-cccccccccc',kind:'managed'})).toMatchObject({status:'logged_out'});
      expect(specifications).toHaveLength(0);
    } finally { await cleanup(accounts); }
  });
  it('creates the account directory with its marker and sends the account env on login', async () => {
    const {accounts, specifications, auth} = await setup();
    try {
      expect(await auth.openLogin('claude',{id:'acct-aaaaaaaaaa',kind:'managed'})).toEqual({ok:true});
      expect(await readFile(join(accounts,'acct-aaaaaaaaaa','.linejs-managed-account'),'utf8')).toBe('acct-aaaaaaaaaa');
      expect(specifications).toHaveLength(1);
      expect(specifications[0]?.interactive).toBe(true);
      expect(specifications[0]?.accountEnv).toEqual({CLAUDE_CONFIG_DIR:join(accounts,'acct-aaaaaaaaaa')});
    } finally { await cleanup(accounts); }
  });
  it('refuses a managed account without an accounts directory', async () => {
    const auth = new AuthController({runner,resolver});
    expect(await auth.openLogin('claude',{id:'acct-aaaaaaaaaa',kind:'managed'})).toMatchObject({ok:false});
    expect(await auth.getAuthStatus('claude',{id:'acct-aaaaaaaaaa',kind:'managed'})).toMatchObject({status:'error'});
  });
});
