import { describe, expect, it, vi } from 'vitest';
import type { BootstrapConfiguration } from '../bootstrap-settings.js';
import { DatabaseSetupRequestSchema, isValidEmbeddedPassword } from '../../../setup-protocol.js';
import { createSetupAdapter } from '../../setup-ipc.js';
import { EmbeddedPgError } from './errors.js';
import { changeEmbeddedPassword, connectWithPasswordRecovery, resetAdminPasswordViaLocalSocket, scramSha256Verifier } from './password.js';

const OLD_URL = 'postgresql://line_agent_admin:old-pass-word@127.0.0.1:55432/line_agent?sslmode=disable';
const embeddedConfig = (): BootstrapConfiguration => ({ databaseUrl: OLD_URL, attachmentRoot: 'D:\\data', embedded: { version: '18.6', port: 55432 } });

function makeDeps(overrides: { save?: () => Promise<void>; setRolePassword?: (url: string, verifier: string) => Promise<void>; config?: BootstrapConfiguration | null } = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  const calls: Array<{ url: string; verifier: string }> = [];
  const config = overrides.config === undefined ? embeddedConfig() : overrides.config;
  const deps = {
    load: async () => config,
    save: vi.fn(async () => { order.push('save'); await overrides.save?.(); }),
    setRolePassword: vi.fn(async (url: string, verifier: string) => { order.push('alter'); calls.push({ url, verifier }); await overrides.setRolePassword?.(url, verifier); }),
    log: (message: string) => { logs.push(message); },
  };
  return { deps, order, logs, calls };
}

describe('scram verifier and validation', () => {
  it('produces the PostgreSQL SCRAM-SHA-256 format with a fixed iteration count and a random salt', () => {
    const verifier = scramSha256Verifier('long-enough-1');
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(scramSha256Verifier('long-enough-1')).not.toBe(verifier);
    expect(verifier).not.toContain('long-enough-1');
    const salt = Buffer.alloc(16, 7);
    expect(scramSha256Verifier('long-enough-1', salt)).toBe(scramSha256Verifier('long-enough-1', salt));
    expect(scramSha256Verifier('long-enough-2', salt)).not.toBe(scramSha256Verifier('long-enough-1', salt));
  });

  it('validates 8-128 printable ASCII characters', () => {
    expect(isValidEmbeddedPassword('1234567')).toBe(false);
    expect(isValidEmbeddedPassword('12345678')).toBe(true);
    expect(isValidEmbeddedPassword('x'.repeat(128))).toBe(true);
    expect(isValidEmbeddedPassword('x'.repeat(129))).toBe(false);
    expect(isValidEmbeddedPassword('N3w:p@ss/w%rd 1~')).toBe(true);
    expect(isValidEmbeddedPassword('abcdefg\n')).toBe(false);
    expect(isValidEmbeddedPassword('abcdefg\u0000h')).toBe(false);
    expect(isValidEmbeddedPassword('abcdefg\u007fh')).toBe(false);
    expect(isValidEmbeddedPassword('abcdefgéh')).toBe(false);
    expect(isValidEmbeddedPassword('密碼密碼密碼密碼')).toBe(false);
  });

  it('main refuses a non-ASCII password before touching the database', async () => {
    const { deps, order } = makeDeps();
    await expect(changeEmbeddedPassword(deps, 'abcdefgéh')).rejects.toMatchObject({ code: 'pg_password_invalid' });
    await expect(changeEmbeddedPassword(deps, 'abcdefg\u0007h')).rejects.toMatchObject({ code: 'pg_password_invalid' });
    expect(order).toEqual([]);
  });

  it('hashes the password as given (no Unicode normalization)', () => {
    const salt = Buffer.alloc(16, 3);
    expect(scramSha256Verifier('ﬁxed-pass', salt)).not.toBe(scramSha256Verifier('fixed-pass', salt));
  });

  it('accepts only the strict request shape', () => {
    const requestId = '9e2af331-4376-4a43-bc81-ce421cc3cb19';
    expect(DatabaseSetupRequestSchema.safeParse({ type: 'changeEmbeddedPassword', requestId, password: 'long-enough-1' }).success).toBe(true);
    expect(DatabaseSetupRequestSchema.safeParse({ type: 'changeEmbeddedPassword', requestId, password: 'long-enough-1', extra: 1 }).success).toBe(false);
    expect(DatabaseSetupRequestSchema.safeParse({ type: 'changeEmbeddedPassword', requestId }).success).toBe(false);
  });
});

describe('changeEmbeddedPassword', () => {
  it('runs ALTER ROLE with the old credentials, then saves the new URL, in that order', async () => {
    const { deps, order, calls } = makeDeps();
    await changeEmbeddedPassword(deps, 'new:pass/word%1');
    expect(order).toEqual(['alter', 'save']);
    expect(calls[0]!.url).toBe(OLD_URL);
    expect(calls[0]!.verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(JSON.stringify(calls)).not.toContain('new:pass/word%1');
    const saved = (deps.save.mock.calls as unknown as Array<[BootstrapConfiguration]>)[0]![0];
    expect(saved.databaseUrl).toBe('postgresql://line_agent_admin:new%3Apass%2Fword%251@127.0.0.1:55432/line_agent?sslmode=disable');
    expect(decodeURIComponent(new URL(saved.databaseUrl).password)).toBe('new:pass/word%1');
    expect(saved.embedded).toEqual({ version: '18.6', port: 55432 });
    expect(saved.attachmentRoot).toBe('D:\\data');
  });

  it('refuses external mode and invalid passwords before touching the database', async () => {
    const external = makeDeps({ config: { databaseUrl: OLD_URL, attachmentRoot: 'D:\\data' } });
    await expect(changeEmbeddedPassword(external.deps, 'long-enough-1')).rejects.toMatchObject({ code: 'pg_not_embedded' });
    const invalid = makeDeps();
    await expect(changeEmbeddedPassword(invalid.deps, 'short')).rejects.toMatchObject({ code: 'pg_password_invalid' });
    expect(external.order).toEqual([]);
    expect(invalid.order).toEqual([]);
  });

  it('fails with pg_password_change_failed and saves nothing when ALTER fails', async () => {
    const { deps, order, logs } = makeDeps({ setRolePassword: async () => { throw new Error('password authentication failed for long-enough-1'); } });
    const error = await changeEmbeddedPassword(deps, 'long-enough-1').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmbeddedPgError);
    expect((error as EmbeddedPgError).code).toBe('pg_password_change_failed');
    expect(order).toEqual(['alter']);
    expect(logs.join('\n')).not.toContain('long-enough-1');
  });

  it('rolls back to the old password with the new credentials when the save fails', async () => {
    const { deps, order, calls, logs } = makeDeps({ save: async () => { throw new Error('disk full'); } });
    await expect(changeEmbeddedPassword(deps, 'long-enough-1')).rejects.toMatchObject({ code: 'pg_password_save_failed' });
    expect(order).toEqual(['alter', 'save', 'alter']);
    expect(calls[1]!.url).toBe('postgresql://line_agent_admin:long-enough-1@127.0.0.1:55432/line_agent?sslmode=disable');
    expect(calls[1]!.verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(logs.join('\n')).not.toContain('long-enough-1');
  });

  it('keeps the password out of the IPC result and the error message', async () => {
    const { deps } = makeDeps({ setRolePassword: async () => { throw new Error('boom long-enough-1'); } });
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: {} as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn(),
      embedded: { start: vi.fn(), cancel: vi.fn(), connectionInfo: vi.fn(), changePassword: (password) => changeEmbeddedPassword(deps, password) } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const requestId = '9e2af331-4376-4a43-bc81-ce421cc3cb19';
    const failed = await adapter(sender, { type: 'changeEmbeddedPassword', requestId, password: 'long-enough-1' });
    expect(failed).toMatchObject({ ok: false, errorCode: 'pg_password_change_failed' });
    expect(JSON.stringify(failed)).not.toContain('long-enough-1');
    const invalid = await adapter(sender, { type: 'changeEmbeddedPassword', requestId, password: 'short' });
    expect(invalid).toMatchObject({ ok: false, errorCode: 'pg_password_invalid' });
    const rejected = await adapter({ senderId: 9, url: sender.url }, { type: 'changeEmbeddedPassword', requestId, password: 'long-enough-1' });
    expect(rejected).toMatchObject({ ok: false });
    const ok = makeDeps();
    const okAdapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: {} as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn(),
      embedded: { start: vi.fn(), cancel: vi.fn(), connectionInfo: vi.fn(), changePassword: (password) => changeEmbeddedPassword(ok.deps, password) } });
    const success = await okAdapter(sender, { type: 'changeEmbeddedPassword', requestId, password: 'long-enough-1' });
    expect(success).toEqual({ type: 'changeEmbeddedPassword', requestId, ok: true });
  });
});

describe('startup recovery', () => {
  const badPassword = Object.assign(new Error('password authentication failed'), { code: '28P01' });

  it('recovers once on 28P01 and connects again', async () => {
    const order: string[] = [];
    let attempts = 0;
    const result = await connectWithPasswordRecovery({
      connect: async () => { order.push('connect'); if (++attempts === 1) throw badPassword; return 'pool'; },
      recover: async () => { order.push('recover'); },
    });
    expect(result).toBe('pool');
    expect(order).toEqual(['connect', 'recover', 'connect']);
  });

  it('does not loop: a second 28P01 is returned to the caller', async () => {
    const connect = vi.fn(async () => { throw badPassword; });
    const recover = vi.fn(async () => undefined);
    await expect(connectWithPasswordRecovery({ connect, recover })).rejects.toBe(badPassword);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('does not recover for other errors', async () => {
    const failure = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const recover = vi.fn(async () => undefined);
    await expect(connectWithPasswordRecovery({ connect: async () => { throw failure; }, recover })).rejects.toBe(failure);
    expect(recover).not.toHaveBeenCalled();
  });

});

describe('resetAdminPasswordViaLocalSocket', () => {
  const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  type Call = { exe: string; args: string[]; input?: string | undefined; env: Record<string, string> };
  function harness(behaviour: { psql?: { code: number; stderr?: string }; start?: { code: number }; stop?: { code: number } } = {}) {
    const calls: Call[] = [];
    const written: Array<{ path: string; data: string }> = [];
    const removed: string[] = [];
    const mkdirs: string[] = [];
    const run = vi.fn(async (file: string, args: readonly string[], options: { input?: string; env?: Record<string, string> }) => {
      const exe = file.slice(file.lastIndexOf('\\') + 1).toLowerCase();
      calls.push({ exe, args: [...args], input: options.input, env: options.env ?? {} });
      const code = exe === 'psql.exe' ? behaviour.psql?.code ?? 0 : exe === 'pg_ctl.exe' && args.includes('start') ? behaviour.start?.code ?? 0
        : exe === 'pg_ctl.exe' && args.includes('stop') ? behaviour.stop?.code ?? 0 : 0;
      return { code, stdout: '', stderr: exe === 'psql.exe' ? behaviour.psql?.stderr ?? '' : '', timedOut: false };
    });
    const options = { run, binDirectory: 'C:\\pg\\bin', dataDirectory: 'C:\\pg\\data', logFile: 'C:\\pg\\logs\\postgresql.log', port: 55433,
      env: { SystemRoot: 'C:\\Windows' }, password: 'long-enough-1', scratchParent: 'C:\\ProgramData', sid: SID, randomBytes: (size: number) => Buffer.alloc(size, 0xab),
      fs: { mkdir: vi.fn(async (path: string) => { mkdirs.push(path); }), writeFile: vi.fn(async (path: string, data: string) => { written.push({ path, data }); }),
        rm: vi.fn(async (path: string) => { removed.push(path); }) } };
    return { options, calls, written, removed, mkdirs };
  }

  it('starts with options only, applies the verifier through psql stdin, then stops and removes the temp directory', async () => {
    const { options, calls, written, removed } = harness();
    await resetAdminPasswordViaLocalSocket(options);
    expect(calls.map((call) => call.exe)).toEqual(['icacls.exe', 'pg_ctl.exe', 'psql.exe', 'pg_ctl.exe']);
    const scratch = 'C:\\ProgramData\\lapw-abababababab';
    expect(calls[0]!.args).toEqual([scratch, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
    expect(written).toEqual([{ path: `${scratch}\\pg_hba.local.conf`, data: 'local all line_agent_admin trust\n' }]);
    expect(calls[1]!.args).toEqual(['-D', 'C:\\pg\\data', '-l', 'C:\\pg\\logs\\postgresql.log', '-w', '-t', '60', '-o',
      '-c listen_addresses= -c unix_socket_directories=C:/ProgramData/lapw-abababababab -c hba_file=C:/ProgramData/lapw-abababababab/pg_hba.local.conf -c port=55433', 'start']);
    expect(calls[2]!.args).toEqual(['-h', 'C:/ProgramData/lapw-abababababab', '-p', '55433', '-U', 'line_agent_admin', '-d', 'postgres', '-X', '-w',
      '-v', 'ON_ERROR_STOP=1', '-f', '-']);
    expect(calls[2]!.input).toMatch(/^ALTER ROLE line_agent_admin PASSWORD 'SCRAM-SHA-256\$4096:[^']+';\n$/);
    expect(calls[3]!.args).toEqual(['-D', 'C:\\pg\\data', 'stop', '-m', 'fast', '-w', '-t', '30']);
    expect(removed).toEqual([scratch]);
  });

  it('never puts the password or the verifier into argv, env or the HBA file', async () => {
    const { options, calls, written } = harness();
    await resetAdminPasswordViaLocalSocket(options);
    const verifier = /SCRAM-SHA-256\$[^']+/.exec(calls[2]!.input!)![0];
    const visible = JSON.stringify([calls.map((call) => [call.args, call.env]), written]);
    expect(visible).not.toContain('long-enough-1');
    expect(visible).not.toContain(verifier);
    expect(calls[2]!.input).not.toContain('long-enough-1');
  });

  it('stops the server and removes the temp directory when psql fails, without leaking the password', async () => {
    const { options, calls, removed } = harness({ psql: { code: 2, stderr: 'psql: bad' } });
    const error = await resetAdminPasswordViaLocalSocket(options).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmbeddedPgError);
    expect(error).toMatchObject({ code: 'pg_password_change_failed' });
    expect((error as Error).message).not.toContain('long-enough-1');
    expect(calls.map((call) => call.exe)).toEqual(['icacls.exe', 'pg_ctl.exe', 'psql.exe', 'pg_ctl.exe']);
    expect(calls[3]!.args).toContain('stop');
    expect(removed).toHaveLength(1);
  });

  it('still stops and cleans up when the start reports failure, and keeps the start error', async () => {
    const { options, calls, removed } = harness({ start: { code: 1 }, stop: { code: 1 } });
    await expect(resetAdminPasswordViaLocalSocket(options)).rejects.toMatchObject({ code: 'pg_start_failed' });
    expect(calls.map((call) => call.exe)).toEqual(['icacls.exe', 'pg_ctl.exe', 'pg_ctl.exe']);
    expect(removed).toHaveLength(1);
  });

  it('reports a failed stop after a successful reset, and still removes the temp directory', async () => {
    const { options, removed } = harness({ stop: { code: 1 } });
    await expect(resetAdminPasswordViaLocalSocket(options)).rejects.toMatchObject({ code: 'pg_stop_timeout' });
    expect(removed).toHaveLength(1);
  });

  it('does not start anything when the ACL step fails, but removes the directory', async () => {
    const { options, calls, removed } = harness();
    options.run.mockImplementationOnce(async () => ({ code: 5, stdout: '', stderr: 'denied', timedOut: false }));
    await expect(resetAdminPasswordViaLocalSocket(options)).rejects.toMatchObject({ code: 'pg_acl_failed' });
    expect(calls.map((call) => call.exe)).toEqual([]);
    expect(removed).toHaveLength(1);
  });

  it('refuses a scratch path that cannot travel inside one pg_ctl -o string', async () => {
    const { options, calls } = harness();
    await expect(resetAdminPasswordViaLocalSocket({ ...options, scratchParent: 'C:\\Program Data' })).rejects.toMatchObject({ code: 'pg_path_unsupported' });
    expect(calls).toEqual([]);
  });
});
