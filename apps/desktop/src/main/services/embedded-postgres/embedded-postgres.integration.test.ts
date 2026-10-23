import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@line-agent/database';
import { describe, expect, it } from 'vitest';
import type { HttpGet } from './http.js';
import { EMBEDDED_PG_PIN, embeddedPaths } from './pin.js';
import { createNodeProvisionerDeps, createServerDeps } from './node-deps.js';
import { runProcess } from './process.js';
import type { BootstrapConfiguration } from '../bootstrap-settings.js';
import { changeEmbeddedPassword, connectWithPasswordRecovery, passwordFromDatabaseUrl, resetAdminPasswordViaLocalSocket, scramSha256Verifier, setRolePassword } from './password.js';
import { EmbeddedPostgresProvisioner } from './provisioner.js';
import { deriveEmbeddedRoot } from './root.js';
import { EmbeddedPostgresServer } from './server.js';

/**
 * Opt-in: set LINEJS_EMBEDDED_PG_ZIP to the verified EDB zip. Runs the real icacls, extract, initdb, start, SELECT 1, stop
 * and restart. "ProgramData" is injected as a temporary directory, so the real %ProgramData%\LineAgentAssistant and
 * %LOCALAPPDATA%\LineAgentAssistant are never touched. No network access.
 */
const zip = process.env.LINEJS_EMBEDDED_PG_ZIP;
const maybe = zip ? describe : describe.skip;

async function selectOne(url: string): Promise<void> {
  const pool = createPool(url);
  try { expect((await pool.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 }); } finally { await pool.end(); }
}

maybe('embedded PostgreSQL (real binaries)', () => {
  it('applies the private ACL, provisions, restarts, takes over an orphan and stops', async () => {
    const programData = await fs.mkdtemp(join(tmpdir(), 'pg-int-'));
    const log = (message: string) => console.error(`[integration] ${message}`);
    let server: EmbeddedPostgresServer | undefined;
    try {
      const httpGet: HttpGet = async (url) => {
        if (url !== EMBEDDED_PG_PIN.url) throw new Error(`unexpected request ${url}`);
        return { status: 200, headers: {}, body: createReadStream(zip!), destroy: () => undefined };
      };
      const saved: Array<{ databaseUrl: string; embedded: { version: string; port: number } }> = [];
      const base = createNodeProvisionerDeps({ log,
        ensureDatabase: async (adminUrl, name) => {
          const pool = createPool(adminUrl);
          try { await pool.query(`CREATE DATABASE "${name}"`); } finally { await pool.end(); }
        },
        saveBootstrap: async (configuration) => { saved.push(configuration); },
        registerServer: (started) => { server = started; } });
      const sid = await base.getSid();
      const deps = { ...base, programData, httpGet, manifestUrl: '' };
      const root = deriveEmbeddedRoot(programData, sid);
      const embedded = await new EmbeddedPostgresProvisioner(deps).provision({ signal: new AbortController().signal, onProgress: () => undefined });
      expect(embedded.version).toBe('18.6');
      expect(embedded.port).toBeGreaterThanOrEqual(55432);
      expect(embedded.port).toBeLessThanOrEqual(55531);

      // Real ACL: only the current SID and SYSTEM, nothing inherited.
      const acl = await runProcess(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [root], { timeoutMs: 30_000, env: {} });
      expect(acl.code).toBe(0);
      const entries = acl.stdout.split(/\r?\n/).filter((line) => /\(.*\)/.test(line));
      expect(entries.some((line) => line.includes('NT AUTHORITY\\SYSTEM') || line.includes('S-1-5-18'))).toBe(true);
      expect(entries.every((line) => !line.includes('(I)'))).toBe(true);
      expect(entries).toHaveLength(2);
      expect(acl.stdout).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users/);

      const url = saved[0]!.databaseUrl;
      await selectOne(url);
      expect(await fs.readdir(join(root, 'downloads'))).toEqual([]);

      await server!.stop();
      const paths = embeddedPaths(root, embedded.version);
      const makeServer = () => new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port: embedded.port },
        createServerDeps(process.env, log));
      const restarted = makeServer(); server = restarted;
      await restarted.start();
      await selectOne(url);
      // Orphan handling: a second owner finds our running postmaster, stops it and starts again.
      const second = makeServer();
      await second.start();
      server = second;
      await selectOne(url);
      await second.stop();
      server = undefined;
    } finally {
      await server?.stop().catch(() => undefined);
      await fs.rm(programData, { recursive: true, force: true });
    }
  }, 900_000);

  it('changes the password through a SCRAM verifier and recovers a bootstrap/database password mismatch', async () => {
    const programData = await fs.mkdtemp(join(tmpdir(), 'pg-pw-'));
    const log = (message: string) => console.error(`[integration] ${message}`);
    let server: EmbeddedPostgresServer | undefined;
    const makePool = (url: string) => createPool(url);
    try {
      const httpGet: HttpGet = async (url) => {
        if (url !== EMBEDDED_PG_PIN.url) throw new Error(`unexpected request ${url}`);
        return { status: 200, headers: {}, body: createReadStream(zip!), destroy: () => undefined };
      };
      let bootstrap = null as BootstrapConfiguration | null;
      const base = createNodeProvisionerDeps({ log,
        ensureDatabase: async (adminUrl, name) => {
          const pool = createPool(adminUrl);
          try {
            const found = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
            if (found.rows.length === 0) await pool.query(`CREATE DATABASE "${name}"`);
          } finally { await pool.end(); }
        },
        saveBootstrap: async (configuration) => { bootstrap = { ...configuration, attachmentRoot: join(programData, 'attachments') }; },
        registerServer: (started) => { server = started; } });
      const sid = await base.getSid();
      const root = deriveEmbeddedRoot(programData, sid);
      const embedded = await new EmbeddedPostgresProvisioner({ ...base, programData, httpGet, manifestUrl: '' })
        .provision({ signal: new AbortController().signal, onProgress: () => undefined });
      const oldUrl = bootstrap!.databaseUrl;
      await selectOne(oldUrl);

      // Change: a new connection with the new password works (real SCRAM login), the old password is refused.
      const newPassword = 'N3w:p@ss/w%rd 1~"\'';
      await changeEmbeddedPassword({ load: async () => bootstrap, save: async (configuration) => { bootstrap = configuration; },
        setRolePassword: (url, verifier) => setRolePassword(makePool, url, verifier), log }, newPassword);
      expect(decodeURIComponent(new URL(bootstrap!.databaseUrl).password)).toBe(newPassword);
      await selectOne(bootstrap!.databaseUrl);
      const oldLogin = await selectOne(oldUrl).then(() => null, (error: unknown) => error);
      expect((oldLogin as { code?: string } | null)?.code).toBe('28P01');

      // Crash between ALTER ROLE and the bootstrap save: the database holds another password than bootstrap.json.
      await setRolePassword(makePool, bootstrap!.databaseUrl, scramSha256Verifier('some-other-password-9'));
      const mismatch = await selectOne(bootstrap!.databaseUrl).then(() => null, (error: unknown) => error);
      expect((mismatch as { code?: string } | null)?.code).toBe('28P01');

      const paths = embeddedPaths(root, embedded.version);
      let recoveries = 0;
      await connectWithPasswordRecovery({
        connect: async () => { await selectOne(bootstrap!.databaseUrl); },
        recover: async () => {
          recoveries += 1;
          await server!.stop(); server = undefined;
          await resetAdminPasswordViaLocalSocket({ run: runProcess, fs, binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log,
            port: embedded.port, env: process.env, password: passwordFromDatabaseUrl(bootstrap!.databaseUrl), scratchParent: programData,
            sid, randomBytes });
          server = new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port: embedded.port },
            createServerDeps(process.env, log));
          await server.start();
        },
      });
      expect(recoveries).toBe(1);
      await selectOne(bootstrap!.databaseUrl);
      expect((await fs.readdir(programData)).filter((name) => name.startsWith('lapw-'))).toEqual([]);

      // The provisioner's existing-data-directory path resets the unknown password through the same helper.
      await server!.stop(); server = undefined;
      const reprovisioned = await new EmbeddedPostgresProvisioner({ ...base, programData, httpGet, manifestUrl: '' })
        .provision({ signal: new AbortController().signal, onProgress: () => undefined });
      expect(reprovisioned.version).toBe(embedded.version);
      expect(passwordFromDatabaseUrl(bootstrap!.databaseUrl)).not.toBe(newPassword);
      await selectOne(bootstrap!.databaseUrl);
      expect((await fs.readdir(programData)).filter((name) => name.startsWith('lapw-'))).toEqual([]);
    } finally {
      await server?.stop().catch(() => undefined);
      await fs.rm(programData, { recursive: true, force: true });
    }
  }, 900_000);
});
