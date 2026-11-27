// Starts headless Chrome with the copied extension and opens the extension page.

import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';
import { CdpPipe } from './cdp-pipe.js';
import { BridgeError } from './errors.js';

export interface BridgeChromeOptions {
  readonly chromePath: string;
  /** Verified extension copy for the developer load (fallback). Absent: the extension is the store install of the profile. */
  readonly extensionPath?: string;
  readonly profileDir: string;
  /** Test seams of the wait for a store install. */
  readonly storeWaitMs?: number;
  readonly storePollMs?: number;
  /** Only the offline smoke script uses this. */
  readonly extraArgs?: readonly string[];
}

export interface BridgeChrome {
  readonly cdp: CdpPipe;
  readonly extensionId: string;
  readonly targetId: string;
  readonly sessionId: string;
}

export function bridgeChromeArgs(profileDir: string, extraArgs: readonly string[] = []): string[] {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=800,580',
    '--mute-audio',
    // These flags stop Chrome components that the extension page does not use.
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=SpareRendererForSitePerProcess,AudioServiceOutOfProcess,MediaRouter,OptimizationHints',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    // Keeps the session cookie `lct` after a clean close. Chrome then restores the old pages.
    '--restore-last-session',
    ...extraArgs,
  ];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

const EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}/`;
const EXTENSION_PAGE_URL = `${EXTENSION_ORIGIN}index.html`;
const STORE_WAIT_MS = 10_000;
const STORE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargetUrls(cdp: CdpPipe): Promise<Array<{ targetId: string; url: string }>> {
  const listed = await cdp.send('Target.getTargets', {});
  const infos = Array.isArray(listed['targetInfos']) ? (listed['targetInfos'] as Array<Record<string, unknown>>) : [];
  return infos.flatMap((info) => (typeof info['targetId'] === 'string' && typeof info['url'] === 'string' ? [{ targetId: info['targetId'], url: info['url'] }] : []));
}

/**
 * Waits until Chrome has loaded the store-installed extension. Chrome loads it by itself at start.
 * Ready means: a target of the extension exists, or a probe page of the extension stays on the extension URL.
 * Returns the target ID of a probe page that is ready (the caller uses it as the extension page), or undefined.
 * Throws EXTENSION_PAGE_FAILED after `waitMs`.
 */
async function waitForStoreExtension(cdp: CdpPipe, waitMs: number, pollMs: number): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await listTargetUrls(cdp)).some((target) => target.url.startsWith(EXTENSION_ORIGIN))) return undefined;
    const probeId = stringField(await cdp.send('Target.createTarget', { url: EXTENSION_PAGE_URL }), 'targetId');
    if (probeId) {
      await sleep(pollMs);
      const probe = (await listTargetUrls(cdp)).find((target) => target.targetId === probeId);
      if (probe?.url.startsWith(EXTENSION_ORIGIN)) return probeId;
      await cdp.send('Target.closeTarget', { targetId: probeId }).catch(() => undefined);
    }
    if (Date.now() >= deadline) {
      throw new BridgeError('EXTENSION_PAGE_FAILED', `the store extension did not load within ${Math.round(waitMs / 1000)} s`);
    }
    await sleep(pollMs);
  }
}

/**
 * Starts Chrome and opens the extension page.
 * Without `extensionPath` the extension is the store install of the profile: Chrome loads it, and this function never calls `Extensions.loadUnpacked`.
 * With `extensionPath` the extension is a developer load (fallback). A failed load gives EXTENSION_STORE_INSTALL_REQUIRED.
 * `start` is a test seam.
 */
export async function startBridgeChrome(
  options: BridgeChromeOptions,
  start: (chromePath: string, args: readonly string[]) => Promise<CdpPipe> = (chromePath, args) => CdpPipe.start(chromePath, args),
): Promise<BridgeChrome> {
  const cdp = await start(options.chromePath, bridgeChromeArgs(options.profileDir, options.extraArgs));
  try {
    let extensionId: string = CHROME_EXTENSION_ID;
    let readyTargetId: string | undefined;
    if (options.extensionPath !== undefined) {
      let loadedId: string | undefined;
      try {
        loadedId = stringField(await cdp.send('Extensions.loadUnpacked', { path: options.extensionPath }), 'id');
      } catch (error) {
        throw new BridgeError('EXTENSION_STORE_INSTALL_REQUIRED', error instanceof Error ? error.message : 'load failed',
          { cause: error, paths: [options.extensionPath, options.profileDir] });
      }
      if (loadedId !== CHROME_EXTENSION_ID) {
        throw new BridgeError('EXTENSION_ID_MISMATCH', `loaded extension id is ${loadedId ?? 'missing'}`);
      }
      extensionId = loadedId;
    } else {
      readyTargetId = await waitForStoreExtension(cdp, options.storeWaitMs ?? STORE_WAIT_MS, options.storePollMs ?? STORE_POLL_MS);
    }
    const targetId = readyTargetId ?? stringField(await cdp.send('Target.createTarget', { url: EXTENSION_PAGE_URL }), 'targetId');
    if (!targetId) throw new BridgeError('EXTENSION_PAGE_FAILED', 'Target.createTarget returned no target');
    // --restore-last-session reopens the old pages. Close them so that only one extension page runs.
    try {
      const listed = await cdp.send('Target.getTargets', {});
      const infos = Array.isArray(listed['targetInfos']) ? (listed['targetInfos'] as Array<Record<string, unknown>>) : [];
      for (const info of infos) {
        const otherId = info['targetId'];
        if (info['type'] !== 'page' || typeof otherId !== 'string' || otherId === targetId) continue;
        await cdp.send('Target.closeTarget', { targetId: otherId }).catch(() => undefined);
      }
    } catch {
      // A failed cleanup must not stop the start.
    }
    const sessionId = stringField(await cdp.send('Target.attachToTarget', { targetId, flatten: true }), 'sessionId');
    if (!sessionId) throw new BridgeError('EXTENSION_PAGE_FAILED', 'Target.attachToTarget returned no session');
    await cdp.send('Runtime.enable', {}, sessionId);
    return { cdp, extensionId, targetId, sessionId };
  } catch (error) {
    await cdp.close().catch(() => undefined);
    throw error;
  }
}
