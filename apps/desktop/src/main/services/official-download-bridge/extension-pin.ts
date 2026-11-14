// Finds the installed LINE Chrome extension 3.7.2, checks the pin and keeps a verified copy in the app folder.
// The copy has no `_metadata` folder. The copy is checked again each time this module runs.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { CHROME_EXTENSION_VERSION, discoverLtsmAssets } from '@line-agent/line-chrome';
import { BridgeError } from './errors.js';

export const PINNED_EXTENSION_VERSION = CHROME_EXTENSION_VERSION;
export const PINNED_MAIN_JS_SIZE = 3_762_026;
export const PINNED_MAIN_JS_MD5 = 'c1d8ee7ca0d858168d56d9fbf9984efc';
const MAIN_JS_RELATIVE = ['static', 'js', 'main.js'] as const;

export interface ExtensionCopy {
  /** Absolute path of the verified copy: `<root>/ext/3.7.2`. */
  readonly path: string;
  /** True when a valid copy already existed. */
  readonly reused: boolean;
}

export interface PrepareExtensionOptions {
  /** App folder that holds the copy. The copy goes to `<root>/ext/3.7.2`. */
  readonly root: string;
  readonly env?: { readonly LOCALAPPDATA?: string | undefined };
}

type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Checks `manifest.json` version, and `static/js/main.js` size and md5. */
export async function verifyExtensionFolder(dir: string): Promise<VerifyResult> {
  let version: unknown;
  try {
    version = (JSON.parse(await readFile(nodePath.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }).version;
  } catch {
    return { ok: false, reason: 'manifest.json is missing or not valid' };
  }
  if (version !== PINNED_EXTENSION_VERSION) {
    return { ok: false, reason: `manifest version is ${typeof version === 'string' ? version : 'unknown'}` };
  }
  const mainJs = nodePath.join(dir, ...MAIN_JS_RELATIVE);
  let size: number;
  try {
    size = (await stat(mainJs)).size;
  } catch {
    return { ok: false, reason: 'static/js/main.js is missing' };
  }
  if (size !== PINNED_MAIN_JS_SIZE) return { ok: false, reason: `main.js size is ${size}` };
  const md5 = createHash('md5').update(await readFile(mainJs)).digest('hex');
  if (md5 !== PINNED_MAIN_JS_MD5) return { ok: false, reason: 'main.js md5 does not match' };
  return { ok: true };
}

/** Returns a verified copy of the extension. Reuses a valid copy; otherwise copies from the installed extension. */
export async function prepareExtensionCopy(options: PrepareExtensionOptions): Promise<ExtensionCopy> {
  const extRoot = nodePath.join(options.root, 'ext');
  const target = nodePath.join(extRoot, PINNED_EXTENSION_VERSION);

  if ((await verifyExtensionFolder(target)).ok) return { path: target, reused: true };

  const discovery = await discoverLtsmAssets(options.env ? { env: options.env } : {});
  if (discovery.kind === 'not-found') {
    throw new BridgeError('EXTENSION_NOT_FOUND', `LINE Chrome extension ${PINNED_EXTENSION_VERSION} is not installed`);
  }
  if (discovery.kind === 'wrong-version') {
    throw new BridgeError('EXTENSION_VERSION_MISMATCH', `installed extension is not the pinned ${PINNED_EXTENSION_VERSION} build`);
  }
  const sourceDir = discovery.match.extensionDir;
  const sourceCheck = await verifyExtensionFolder(sourceDir);
  if (!sourceCheck.ok) {
    throw new BridgeError('EXTENSION_VERSION_MISMATCH', `installed extension fails the pin: ${sourceCheck.reason}`);
  }

  const temp = `${target}.tmp-${process.pid}`;
  try {
    await mkdir(extRoot, { recursive: true });
    await rm(temp, { recursive: true, force: true });
    await cp(sourceDir, temp, { recursive: true, filter: (source) => nodePath.basename(source) !== '_metadata' });
    const copyCheck = await verifyExtensionFolder(temp);
    if (!copyCheck.ok) throw new Error(`copy fails the pin: ${copyCheck.reason}`);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw new BridgeError('EXTENSION_COPY_FAILED', error instanceof Error ? error.message : 'copy failed', { cause: error });
  }
  return { path: target, reused: false };
}
