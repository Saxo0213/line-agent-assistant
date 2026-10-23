import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsOfficialSnapshotImporter, mapOfficialIdentityRead } from './runtime-importer.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

describe('JS official import Main adapter', () => {
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
