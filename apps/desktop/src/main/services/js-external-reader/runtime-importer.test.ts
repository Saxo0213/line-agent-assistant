import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPrivateDirectoryAclResult, createJsOfficialSnapshotImporter, createPrivateDirectoryAclEnvironment, isExecFileTimeout, mapOfficialIdentityRead } from './runtime-importer.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

describe('JS official import Main adapter', () => {
  it('recognizes this host Node execFile timeout shape and excludes command failures', () => {
    expect(isExecFileTimeout({ code: null, killed: true, signal: 'SIGTERM' })).toBe(true);
    expect(isExecFileTimeout({ code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' })).toBe(true);
    expect(isExecFileTimeout({ code: 1, killed: false, signal: null })).toBe(false);
    expect(isExecFileTimeout({ code: null, killed: false, signal: null })).toBe(false);
    expect(isExecFileTimeout({ code: null, killed: true, signal: 'SIGKILL' })).toBe(false);
    expect(isExecFileTimeout(new Error('unexpected output'))).toBe(false);
    expect(classifyPrivateDirectoryAclResult(undefined, { code: null, killed: true, signal: 'SIGTERM' }))
      .toBe('private_directory_acl_command_timeout');
    expect(classifyPrivateDirectoryAclResult(undefined, { code: 1, killed: false, signal: null }))
      .toBe('private_directory_acl_command_failed');
    expect(classifyPrivateDirectoryAclResult({ stdout: 'unexpected' }))
      .toBe('private_directory_acl_unexpected_output');
    expect(classifyPrivateDirectoryAclResult({ stdout: 'restricted\r\n' })).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')('replaces only the ACL child module path with Windows system modules', () => {
    const inherited: NodeJS.ProcessEnv = { ...process.env, PSModulePath: 'C:\\conflicting\\modules;C:\\conflicting\\modules' };
    const originalModulePath = inherited.PSModulePath;
    const originalProcessModulePath = process.env.PSModulePath;
    const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR;
    const childEnvironment = createPrivateDirectoryAclEnvironment(inherited, windowsDirectory);
    const expectedModulePath = path.join(windowsDirectory!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');

    expect(childEnvironment.PSModulePath).toBe(expectedModulePath);
    expect(inherited.PSModulePath).toBe(originalModulePath);
    expect(childEnvironment.PATH).toBe(inherited.PATH);
    expect(process.env.PSModulePath).toBe(originalProcessModulePath);
  });

  it('preserves controller picturePath and keeps absent distinct from null', () => {
    expect(mapOfficialIdentityRead({ mid: 'u123', displayName: 'Admin', picturePath: '/path' }, 1))
      .toEqual({ status: 'supported', mid: 'u123', displayName: 'Admin', picturePath: '/path', candidateCount: 1 });
    expect(mapOfficialIdentityRead({ mid: 'u123', displayName: 'Admin' }, 1))
      .not.toHaveProperty('picturePath');
    expect(mapOfficialIdentityRead({ mid: 'u123', displayName: 'Admin', picturePath: null }, 1))
      .toHaveProperty('picturePath', null);
  });

  it.skipIf(process.platform !== 'win32')('verifies packaged reader resources and honors cancellation before source access', async () => {
    const admission = new ExternalSourceProbeAdmissionGate();
    const importer = await createJsOfficialSnapshotImporter({ packaged: false, appPath: desktopRoot,
      resourcesPath: '', localAppData: process.env.LOCALAPPDATA, admission });
    const abort = new AbortController();
    abort.abort();
    await expect(importer.readOfficialSnapshot({ expectedMid: 'synthetic-mid', signal: abort.signal,
      onProgress() {}, onReady() { return null; }, onCatalogPage() {}, onPage() {} })).rejects.toThrow('reader_cancelled');
    expect(admission.isBusy()).toBe(false);
  });
});
