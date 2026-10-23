import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapSettings, bootstrapFromEnvironment } from './bootstrap-settings.js';

describe('BootstrapSettings', () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  it('stores database connection and managed attachment root under LOCALAPPDATA', async () => {
    const local = await mkdtemp(join(tmpdir(), 'line-bootstrap-')); folders.push(local);
    const fake = { async protect(value: Uint8Array) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
      async unprotect(value: Uint8Array) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); } };
    const settings = new BootstrapSettings({ LOCALAPPDATA: local }, fake);
    const attachmentRoot = join(local, 'LineAgentAssistant', 'attachments');
    await settings.save({ databaseUrl: 'postgresql://localhost/test', attachmentRoot });
    expect(await new BootstrapSettings({ LOCALAPPDATA: local }, fake).load()).toEqual({ databaseUrl: 'postgresql://localhost/test', attachmentRoot });
    expect(await readFile(join(local, 'LineAgentAssistant', 'bootstrap.json'), 'utf8')).not.toContain('postgresql://localhost/test');
  });

  it('round-trips the embedded block and still loads files written without it', async () => {
    const local = await mkdtemp(join(tmpdir(), 'line-bootstrap-')); folders.push(local);
    const fake = { async protect(value: Uint8Array) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); },
      async unprotect(value: Uint8Array) { return Buffer.from(value.map((byte) => byte ^ 0x5a)); } };
    const settings = new BootstrapSettings({ LOCALAPPDATA: local }, fake);
    const attachmentRoot = join(local, 'LineAgentAssistant', 'attachments');
    await settings.save({ databaseUrl: 'postgresql://localhost/test', attachmentRoot, embedded: { version: '18.6', port: 55432 } });
    expect(await settings.load()).toEqual({ databaseUrl: 'postgresql://localhost/test', attachmentRoot, embedded: { version: '18.6', port: 55432 } });
    const file = join(local, 'LineAgentAssistant', 'bootstrap.json');
    expect(JSON.parse(await readFile(file, 'utf8')).embedded).toEqual({ version: '18.6', port: 55432 });
    await settings.save({ databaseUrl: 'postgresql://localhost/test', attachmentRoot });
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('embedded');
    expect(await settings.load()).toEqual({ databaseUrl: 'postgresql://localhost/test', attachmentRoot });
    await expect(settings.save({ databaseUrl: 'postgresql://localhost/test', attachmentRoot, embedded: { version: 'x', port: 1 } })).rejects.toThrow();
  });

  it('accepts the documented production environment only as a complete validated pair', () => {
    const attachmentRoot = join('C:', 'LineAgentData', 'attachments');
    expect(bootstrapFromEnvironment({ DATABASE_URL: 'postgresql://localhost/live', LINE_AGENT_ATTACHMENT_ROOT: attachmentRoot }))
      .toEqual({ databaseUrl: 'postgresql://localhost/live', attachmentRoot });
    expect(() => bootstrapFromEnvironment({ DATABASE_URL: 'postgresql://localhost/live' })).toThrow(/both/i);
    expect(bootstrapFromEnvironment({})).toBeNull();
  });
});
