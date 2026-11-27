import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';
import { describe, expect, it } from 'vitest';
import { startBridgeChrome } from './bridge-chrome.js';
import type { CdpPipe } from './cdp-pipe.js';

const PAGE_URL = `chrome-extension://${CHROME_EXTENSION_ID}/index.html`;

/** Fake CDP. `extensionLoadsAfter` = number of createTarget calls before a page keeps the extension URL. */
function fakeCdp(options: { loadFails?: boolean; extensionLoadsAfter?: number } = {}) {
  const calls: string[] = [];
  const targets = new Map<string, string>();
  let created = 0;
  const cdp = {
    isClosed: false,
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === 'Extensions.loadUnpacked') {
        if (options.loadFails) throw new Error('Extensions.loadUnpacked: Failed to load');
        return { id: CHROME_EXTENSION_ID };
      }
      if (method === 'Target.createTarget') {
        created += 1;
        const id = `T${created}`;
        targets.set(id, created > (options.extensionLoadsAfter ?? 0) ? String(params['url']) : 'chrome-error://chromewebdata/');
        return { targetId: id };
      }
      if (method === 'Target.getTargets') return { targetInfos: [...targets].map(([targetId, url]) => ({ targetId, url, type: 'page' })) };
      if (method === 'Target.closeTarget') { targets.delete(String(params['targetId'])); return { success: true }; }
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      return {};
    },
    close: async () => { calls.push('close'); },
  };
  return { cdp: cdp as unknown as CdpPipe, calls };
}

describe('startBridgeChrome start order', () => {
  it('a: a store install is waited for and Extensions.loadUnpacked is never called', async () => {
    const { cdp, calls } = fakeCdp({ extensionLoadsAfter: 1 });
    const chrome = await startBridgeChrome({ chromePath: 'chrome.exe', profileDir: 'P', storePollMs: 5 }, async () => cdp);
    expect(calls).not.toContain('Extensions.loadUnpacked');
    expect(calls.filter((call) => call === 'Target.createTarget')).toHaveLength(2);
    expect(chrome).toMatchObject({ extensionId: CHROME_EXTENSION_ID, targetId: 'T2', sessionId: 'S1' });
  });

  it('a: gives EXTENSION_PAGE_FAILED when the store extension never loads', async () => {
    const { cdp, calls } = fakeCdp({ extensionLoadsAfter: 999 });
    await expect(startBridgeChrome({ chromePath: 'chrome.exe', profileDir: 'P', storeWaitMs: 30, storePollMs: 5 }, async () => cdp))
      .rejects.toMatchObject({ code: 'EXTENSION_PAGE_FAILED' });
    expect(calls).toContain('close');
  });

  it('c: without a store install the developer load runs', async () => {
    const { cdp, calls } = fakeCdp();
    const chrome = await startBridgeChrome({ chromePath: 'chrome.exe', profileDir: 'P', extensionPath: 'COPY' }, async () => cdp);
    expect(calls.slice(0, 2)).toEqual(['Extensions.loadUnpacked', 'Target.createTarget']);
    expect(chrome.targetId).toBe('T1');
    expect(PAGE_URL).toContain(CHROME_EXTENSION_ID);
  });

  it('c: a failed developer load asks for a store install and keeps the safe reason', async () => {
    const { cdp } = fakeCdp({ loadFails: true });
    await expect(startBridgeChrome({ chromePath: 'chrome.exe', profileDir: 'Q:\\profile-dir', extensionPath: 'Q:\\extension-copy' }, async () => cdp))
      .rejects.toMatchObject({ code: 'EXTENSION_STORE_INSTALL_REQUIRED', reason: 'Extensions.loadUnpacked: Failed to load' });
  });
});
