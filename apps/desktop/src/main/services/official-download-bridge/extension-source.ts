// Chooses where the extension comes from. The store install of the download profile always comes first.
// The developer load (a verified copy and `Extensions.loadUnpacked`) is only a fallback when there is no store install.

import { BridgeError } from './errors.js';
import { prepareExtensionCopy } from './extension-pin.js';
import { detectStoreExtension, type StoreExtensionDetection } from './store-extension.js';

export type ExtensionSource =
  | { readonly kind: 'store'; readonly version: string }
  | { readonly kind: 'unpacked'; readonly path: string };

export interface ExtensionSourceDeps {
  readonly detect?: (profileDir: string) => Promise<StoreExtensionDetection>;
  readonly prepare?: (options: { root: string }) => Promise<{ path: string }>;
}

/**
 * a. Store install with every feature signature found: source `store` (any version).
 * b. Store install with a missing signature: EXTENSION_FEATURES_CHANGED. No developer load (the same extension ID would conflict).
 * c. No store install: source `unpacked` (copy of the pinned 3.7.2 build; it keeps the version and md5 pin).
 */
export async function resolveExtensionSource(options: { root: string; profileDir: string }, deps: ExtensionSourceDeps = {}): Promise<ExtensionSource> {
  const store = await (deps.detect ?? detectStoreExtension)(options.profileDir);
  if (store.kind === 'ready') return { kind: 'store', version: store.version };
  if (store.kind === 'changed') {
    throw new BridgeError('EXTENSION_FEATURES_CHANGED', `signatures ${store.failed.join(' ')}`);
  }
  const copy = await (deps.prepare ?? prepareExtensionCopy)({ root: options.root });
  return { kind: 'unpacked', path: copy.path };
}
