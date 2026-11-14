// Entry of the official download bridge (phase 1: start Chrome, load the pinned extension, get its handles).

import { startBridgeChrome } from './bridge-chrome.js';
import type { CdpPipe } from './cdp-pipe.js';
import { locateChrome } from './chrome-locator.js';
import { getExtensionHandles, type ExtensionHandles } from './extension-handles.js';
import { writeBridgePreferences } from './chrome-preferences.js';
import { prepareExtensionCopy } from './extension-pin.js';

export { BridgeError, type BridgeErrorCode } from './errors.js';
export { readLoginState, type ExtensionHandles } from './extension-handles.js';
export type { CdpPipe } from './cdp-pipe.js';
export { readLoginReading, requestQrRefresh, type LoginReading, type QrLoginReading } from './login-state.js';

export interface OfficialDownloadBridgeOptions {
  /** App folder for the verified extension copy: `<root>/ext/3.7.2`. */
  readonly root: string;
  /** Dedicated Chrome profile folder. */
  readonly profileDir: string;
  /** Only the offline smoke script uses this. */
  readonly extraArgs?: readonly string[];
  /** Called with a non-fatal error of the Preferences write. */
  readonly onError?: (error: unknown) => void;
}

export interface OfficialDownloadBridge {
  readonly handles: ExtensionHandles;
  readonly cdp: CdpPipe;
  readonly close: () => Promise<void>;
}

export async function startOfficialDownloadBridge(options: OfficialDownloadBridgeOptions): Promise<OfficialDownloadBridge> {
  const extension = await prepareExtensionCopy({ root: options.root });
  const chromePath = await locateChrome();
  await writeBridgePreferences(options.profileDir, options.onError);
  const chrome = await startBridgeChrome({
    chromePath,
    extensionPath: extension.path,
    profileDir: options.profileDir,
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
  });
  try {
    const handles = await getExtensionHandles(chrome.cdp, chrome.sessionId);
    return { handles, cdp: chrome.cdp, close: () => chrome.cdp.close() };
  } catch (error) {
    await chrome.cdp.close().catch(() => undefined);
    throw error;
  }
}
export {
  BridgeDownloadError, OfficialDownloadBridgeDownloader,
  type BridgeDownloadCode, type BridgeDownloadRequest, type BridgeVerifyRequest, type BridgeDownloadStage, type BridgeDownloadedFile, type BridgeDownloaderOptions, type LiveBridge,
} from './bridge-download.js';
export { buildMessageFromNativeRow, nativeRowFromEnvelope, type BridgeMessage, type NativeRowInput } from './native-message.js';
export type { BridgeAttempt, BridgeAttemptStage } from './bridge-download.js';
export {
  BRIDGE_VERIFY_POLL_MS, BRIDGE_VERIFY_WAIT_MS, BRIDGE_GATE_IMAGE_MATCH_THRESHOLD, BRIDGE_GATE_FILE_MATCH_THRESHOLD, BRIDGE_VERIFY_RESULT_CODES,
  bridgeGateThreshold, isBridgeGateOpen, isSupportedImageHead, classifyBridgeComparison,
  type BridgeKind, type BridgeVerification, type BridgeVerifyResult,
} from './bridge-verification.js';
