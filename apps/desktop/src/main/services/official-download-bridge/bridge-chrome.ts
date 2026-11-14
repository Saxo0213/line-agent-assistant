// Starts headless Chrome with the copied extension and opens the extension page.

import { CHROME_EXTENSION_ID } from '@line-agent/line-chrome';
import { CdpPipe } from './cdp-pipe.js';
import { BridgeError } from './errors.js';

export interface BridgeChromeOptions {
  readonly chromePath: string;
  /** Verified extension copy. */
  readonly extensionPath: string;
  readonly profileDir: string;
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
    // Keeps the session cookie `lct` after a clean close. Chrome then restores the old pages.
    '--restore-last-session',
    ...extraArgs,
  ];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

export async function startBridgeChrome(options: BridgeChromeOptions): Promise<BridgeChrome> {
  const cdp = await CdpPipe.start(options.chromePath, bridgeChromeArgs(options.profileDir, options.extraArgs));
  try {
    let extensionId: string | undefined;
    try {
      extensionId = stringField(await cdp.send('Extensions.loadUnpacked', { path: options.extensionPath }), 'id');
    } catch (error) {
      throw new BridgeError('EXTENSION_LOAD_FAILED', error instanceof Error ? error.message : 'load failed', { cause: error });
    }
    if (extensionId !== CHROME_EXTENSION_ID) {
      throw new BridgeError('EXTENSION_ID_MISMATCH', `loaded extension id is ${extensionId ?? 'missing'}`);
    }
    const targetId = stringField(await cdp.send('Target.createTarget', { url: `chrome-extension://${CHROME_EXTENSION_ID}/index.html` }), 'targetId');
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
