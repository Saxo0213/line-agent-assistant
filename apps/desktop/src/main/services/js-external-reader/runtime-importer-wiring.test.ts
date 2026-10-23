import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ snapshot: [] as Array<Record<string, unknown>>, monitor: [] as Array<Record<string, unknown>> }));

vi.mock('./controller.js', () => ({
  JsExternalReaderController: class {
    async readOfficialSnapshot(input: Record<string, unknown>) { calls.snapshot.push(input); return { pageCount: 0, rowCount: 0 }; }
    async readOfficialMonitor(input: Record<string, unknown>) { calls.monitor.push(input); }
  },
}));
vi.mock('./resources.js', () => ({
  verifyJsExternalReaderResources: async () => ({ bridgePath: 'C:\\synthetic\\ExternalReaderBridge.exe', bridgeSha256: 'a'.repeat(64) }),
}));

const { createJsOfficialSnapshotImporter } = await import('./runtime-importer.js');
const { ExternalSourceProbeAdmissionGate } = await import('../external-source-probe-admission.js');

// Regression: the Main adapter once dropped the facade's committers, so a fresh first import
// failed at catalog page 1 and the directory pass could never reach PostgreSQL.
describe('JS official import Main adapter callback wiring', () => {
  it.skipIf(process.platform !== 'win32')('passes the catalog and directory committers through to the controller for first import and monitoring', async () => {
    const importer = await createJsOfficialSnapshotImporter({ packaged: false, appPath: process.cwd(),
      resourcesPath: '', localAppData: process.env.LOCALAPPDATA, admission: new ExternalSourceProbeAdmissionGate() });
    const signal = new AbortController().signal;
    const onCatalogPage = vi.fn();
    const onDirectoryPage = vi.fn();
    await importer.readOfficialSnapshot({ expectedMid: 'synthetic-mid', signal, onProgress() {}, onReady: () => null,
      onCatalogPage, onDirectoryPage, onPage() {} });
    expect(calls.snapshot).toHaveLength(1);
    expect(calls.snapshot[0]!.onCatalogPage).toBe(onCatalogPage);
    expect(calls.snapshot[0]!.onDirectoryPage).toBe(onDirectoryPage);

    await importer.readOfficialMonitor!({ expectedMid: 'synthetic-mid', sourceIdentityDigest: 'b'.repeat(64), cursor: null, signal,
      onProgress() {}, onDirectoryPage, onPage: () => null });
    expect(calls.monitor).toHaveLength(1);
    expect(calls.monitor[0]!.onDirectoryPage).toBe(onDirectoryPage);
  });
});
