import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
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
  it('recognizes Codex authentication written only to stderr', async () => {
    expect(await controller('codex').getAuthStatus('codex')).toMatchObject({installed:true,status:'authenticated'});
    expect(await controller('codex-api').getAuthStatus('codex')).toMatchObject({installed:true,status:'authenticated'});
  });
  it('uses the configured Codex home when checking the official login', async () => {
    const specifications: ProcessSpec[] = [];
    const configuredHome = 'C:\\Users\\test\\.codex-custom';
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start(spec); }},
      environment:{...process.env,CODEX_HOME:configuredHome},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'codex-home'],version:'0.144.5',kind:'native'})},
    });

    expect(await auth.getAuthStatus('codex')).toMatchObject({status:'authenticated'});

    expect(specifications[0]?.env?.CODEX_HOME).toBe(configuredHome);
  });
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
    expect(await controller('logged-out').getAuthStatus('codex')).toMatchObject({installed:true,status:'logged_out'});
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
    expect(JSON.stringify(await controller('error').getAuthStatus('codex'))).not.toMatch(/Private|credentials|sk-super|OPENAI_API_KEY=/);
  });
  it('reports an absent executable without affecting callers', async () => {
    const auth = new AuthController({runner,resolver:{resolve:async () => null}});
    expect(await auth.getAuthStatus('codex')).toMatchObject({installed:false,status:'not_installed'});
  });
  it.each(['codex','claude'] as const)('uses the visible official login and logout for %s', async provider => {
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start({...spec,interactive:false}); }},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'logged-out'],version:'0.144.5',kind:'native'})},
    });
    expect(await auth.openLogin(provider)).toMatchObject({ok:true});
    expect(specifications[0]?.args.slice(2)).toEqual(provider === 'codex' ? ['login','status'] : ['auth','status']);
    expect(specifications[1]?.interactive).toBe(true);
    expect(specifications[1]?.args.slice(2)).toEqual(provider === 'codex' ? ['login'] : ['auth','login']);
    expect(specifications[0]?.file).toBe(specifications[1]?.file);
    expect(specifications[0]?.env).toEqual(specifications[1]?.env);
    expect(await auth.logout(provider)).toMatchObject({ok:true});
    expect(specifications[2]?.args.slice(2)).toEqual(provider === 'codex' ? ['logout'] : ['auth','logout']);
  });
  it.each(['codex','claude'] as const)('does not start %s login when the official CLI is already authenticated', async provider => {
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) { specifications.push(spec); return runner.start(spec); }},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,provider],version:'0.144.5',kind:'native'})},
    });

    expect(await auth.openLogin(provider)).toMatchObject({ok:true});

    expect(specifications).toHaveLength(1);
    expect(specifications[0]?.args.slice(2)).toEqual(provider==='codex'?['login','status']:['auth','status']);
  });
  it.each([
    ['codex','error',2],['claude','error',2],['codex','unknown',0],['claude','unknown',0],
  ] as const)('does not start %s login when status is %s', async (provider, state, exitCode) => {
    const specifications: ProcessSpec[] = [];
    const auth = new AuthController({
      runner:{start(spec) {
        specifications.push(spec);
        return {
          stdout:(async function*(){ yield Buffer.from(state === 'unknown' ? 'unexpected status' : ''); })(),
          stderr:(async function*(){ yield Buffer.from('C:\\Users\\Private\\auth.json OPENAI_API_KEY=sk-secret'); })(),
          exited:Promise.resolve({code:exitCode,signal:null}),
          cancel:async()=>{},
        };
      }},
      resolver:{resolve:async () => ({file:process.execPath,prefixArgs:[fixture,'status-error'],version:'0.144.5',kind:'native'})},
    });

    const result = await auth.openLogin(provider);

    expect(result).toEqual({ok:false,detail:'The official CLI could not confirm its login state.'});
    expect(specifications).toHaveLength(1);
    expect(specifications[0]?.args.slice(2)).toEqual(provider==='codex'?['login','status']:['auth','status']);
    expect(JSON.stringify(result)).not.toMatch(/Private|OPENAI_API_KEY|sk-secret/);
  });
});
