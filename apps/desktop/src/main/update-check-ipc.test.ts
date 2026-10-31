import { describe, expect, it, vi } from 'vitest';
import { createUpdateCheckIpcAdapter } from './update-check-ipc.js';

const state = { enabled: true, checking: false, lastCheckedAt: null, lastCheckFailed: false, latestVersion: null, releaseUrl: null, available: false, installedNotice: null, ignoredVersion: null, download: { status: 'idle' as const, percent: 0 }, canAutoInstall: true };
function setup() {
  const service = { state: vi.fn(() => state), setEnabled: vi.fn(async (enabled: boolean) => ({ ...state, enabled })), checkNow: vi.fn(async () => state), openReleasePage: vi.fn(async () => true), openInstalledDetails: vi.fn(async () => state), ignore: vi.fn(async () => state), install: vi.fn(async () => state) };
  const adapter = createUpdateCheckIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', service });
  return { service, call: (payload: unknown, sender = { senderId: 7, url: 'file:///app/index.html' }) => adapter(sender, payload) };
}

describe('update check IPC adapter', () => {
  it('routes the four requests to the service', async () => {
    const { service, call } = setup();
    await call({ type: 'getState' });
    expect(await call({ type: 'setEnabled', enabled: false })).toMatchObject({ enabled: false });
    await call({ type: 'checkNow' });
    await call({ type: 'openReleasePage' });
    await call({ type: 'openInstalledDetails' });
    await call({ type: 'ignore', version: '1.0.280' });
    await call({ type: 'install' });
    expect(service.ignore).toHaveBeenCalledWith('1.0.280');
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(service.setEnabled).toHaveBeenCalledWith(false);
    expect(service.checkNow).toHaveBeenCalledTimes(1);
    expect(service.openReleasePage).toHaveBeenCalledWith();
    expect(service.openInstalledDetails).toHaveBeenCalledWith();
  });

  it('rejects foreign senders and payloads that carry a URL', async () => {
    const { service, call } = setup();
    await expect(call({ type: 'checkNow' }, { senderId: 8, url: 'file:///app/index.html' })).rejects.toThrow('identity');
    await expect(call({ type: 'openReleasePage', url: 'https://evil.example' })).rejects.toThrow();
    await expect(call({ type: 'other' })).rejects.toThrow();
    expect(service.openReleasePage).not.toHaveBeenCalled();
  });
});
