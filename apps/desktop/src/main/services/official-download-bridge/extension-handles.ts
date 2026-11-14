// Gets RemoteObject ids of the extension internals (IA, XC, eB, QO, zD) without a change to the extension.
// Method: read the React fiber tree from #root, take a function component, then read its [[Scopes]] with CDP.
// This module only reads. It never redefines or patches extension code. It never serializes the objects.

import type { CdpPipe } from './cdp-pipe.js';
import { BridgeError } from './errors.js';

export const HANDLE_NAMES = ['IA', 'XC', 'eB', 'QO', 'zD'] as const;
export type HandleName = (typeof HANDLE_NAMES)[number];

export interface ExtensionHandles {
  readonly sessionId: string;
  /** CDP RemoteObject ids. They are valid while the page lives. */
  readonly ids: Readonly<Record<HandleName, string>>;
  /** Description of the function that gave the scope chain, for diagnostics. */
  readonly startFunction: { readonly index: number; readonly name: string };
  readonly eBLength: number;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  objectId?: string;
  value?: unknown;
}
interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}
interface GetPropertiesResult {
  result?: PropertyDescriptor[];
  internalProperties?: PropertyDescriptor[];
}

const PAGE_READY_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES = 80;

// Read-only fiber walk. It returns the Redux store and function component types as RemoteObjects (not by value).
const FIBER_WALK = `(() => {
  const root = document.getElementById('root');
  if (!root) return null;
  const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
  if (!key) return null;
  let store = null;
  const fns = [];
  const seenFns = new Set();
  const seen = new Set();
  const stack = [root[key]];
  let visited = 0;
  while (stack.length > 0 && visited < 30000) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    visited += 1;
    const props = fiber.memoizedProps;
    if (!store && props && props.store && typeof props.store.getState === 'function' && typeof props.store.dispatch === 'function') store = props.store;
    if (typeof fiber.type === 'function' && !seenFns.has(fiber.type) && fns.length < ${MAX_CANDIDATES}) {
      seenFns.add(fiber.type);
      fns.push(fiber.type);
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return { store, fns };
})()`;

// The React container exists before the first render. Wait until the Provider store is in the fiber tree.
const READY_CHECK = `(() => {
  const walked = ${FIBER_WALK};
  return !!walked && !!walked.store;
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getProperties(cdp: CdpPipe, sessionId: string, objectId: string): Promise<GetPropertiesResult> {
  return (await cdp.send('Runtime.getProperties', { objectId, ownProperties: true }, sessionId)) as GetPropertiesResult;
}

async function waitForReactRoot(cdp: CdpPipe, sessionId: string): Promise<void> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = (await cdp.send('Runtime.evaluate', { expression: READY_CHECK, returnByValue: true }, sessionId)) as { result?: RemoteObject };
      if (response.result?.value === true) return;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'CDP_CLOSED') throw error;
    }
    await sleep(250);
  }
  throw new BridgeError('EXTENSION_PAGE_FAILED', 'Redux Provider did not render within 30 s');
}

interface ScopeScan {
  readonly found: Partial<Record<HandleName, string>>;
  readonly names: readonly string[];
}

/** Reads the scope objects of one function. Returns the best scope: the one with the most wanted names. */
async function scanScopes(cdp: CdpPipe, sessionId: string, fnId: string): Promise<ScopeScan | undefined> {
  const fnProps = await getProperties(cdp, sessionId, fnId);
  const scopesId = fnProps.internalProperties?.find((p) => p.name === '[[Scopes]]')?.value?.objectId;
  if (!scopesId) return undefined;
  const scopeList = (await getProperties(cdp, sessionId, scopesId)).result ?? [];
  let best: ScopeScan | undefined;
  for (const entry of scopeList) {
    const scopeObject = entry.value;
    if (!scopeObject?.objectId || !/^\d+$/.test(entry.name)) continue;
    if (scopeObject.description === 'Global') continue;
    const vars = (await getProperties(cdp, sessionId, scopeObject.objectId)).result ?? [];
    const found: Partial<Record<HandleName, string>> = {};
    for (const variable of vars) {
      const id = variable.value?.objectId;
      if ((HANDLE_NAMES as readonly string[]).includes(variable.name) && id) found[variable.name as HandleName] = id;
    }
    const count = Object.keys(found).length;
    if (!best || count > Object.keys(best.found).length) best = { found, names: vars.map((v) => v.name) };
    if (count === HANDLE_NAMES.length) return best;
  }
  return best;
}

export async function getExtensionHandles(cdp: CdpPipe, sessionId: string): Promise<ExtensionHandles> {
  await waitForReactRoot(cdp, sessionId);

  const walk = (await cdp.send('Runtime.evaluate', { expression: FIBER_WALK, returnByValue: false }, sessionId)) as { result?: RemoteObject };
  const walkId = walk.result?.objectId;
  if (!walkId) throw new BridgeError('EXTENSION_HANDLES_NOT_FOUND', 'fiber walk returned nothing', { missing: [...HANDLE_NAMES] });
  const walkProps = (await getProperties(cdp, sessionId, walkId)).result ?? [];
  const storeId = walkProps.find((p) => p.name === 'store')?.value?.objectId;
  const fnsId = walkProps.find((p) => p.name === 'fns')?.value?.objectId;
  if (!storeId) throw new BridgeError('EXTENSION_HANDLES_NOT_FOUND', 'Redux Provider store not found in fibers', { missing: ['IA'] });
  const candidates = fnsId ? (await getProperties(cdp, sessionId, fnsId)).result?.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId) ?? [] : [];

  let found: Partial<Record<HandleName, string>> | undefined;
  let startFunction: { index: number; name: string } | undefined;
  let bestSeen: ScopeScan | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const scan = await scanScopes(cdp, sessionId, candidate.value?.objectId as string).catch(() => undefined);
    if (!scan) continue;
    if (!bestSeen || Object.keys(scan.found).length > Object.keys(bestSeen.found).length) bestSeen = scan;
    if (HANDLE_NAMES.every((name) => scan.found[name])) {
      found = scan.found;
      startFunction = { index, name: (candidate.value?.description ?? '').slice(0, 60).split('\n')[0] ?? '' };
      break;
    }
  }
  if (!found || !startFunction) {
    const have = bestSeen ? HANDLE_NAMES.filter((name) => bestSeen.found[name]) : [];
    const missing = HANDLE_NAMES.filter((name) => !have.includes(name));
    const seen = bestSeen ? `; best scope has ${bestSeen.names.length} names: ${bestSeen.names.slice(0, 30).join(',')}` : '; no scope chain was readable';
    throw new BridgeError('EXTENSION_HANDLES_NOT_FOUND', `missing ${missing.join(',')} after ${candidates.length} candidate functions${seen}`, { missing });
  }
  const ids = found as Record<HandleName, string>;

  // Self-check: the store in the scope is the store of the Provider, and eB is a function with two parameters.
  const same = (await cdp.send('Runtime.callFunctionOn', {
    objectId: ids.IA,
    functionDeclaration: 'function(other){return this===other}',
    arguments: [{ objectId: storeId }],
    returnByValue: true,
  }, sessionId)) as { result?: RemoteObject };
  if (same.result?.value !== true) throw new BridgeError('EXTENSION_HANDLES_NOT_FOUND', 'IA in scope is not the Provider store', { missing: ['IA'] });
  const eBInfo = (await cdp.send('Runtime.callFunctionOn', {
    objectId: ids.eB,
    functionDeclaration: "function(){return typeof this==='function'?String(this.length):'not-a-function'}",
    returnByValue: true,
  }, sessionId)) as { result?: RemoteObject };
  if (eBInfo.result?.value !== '2') {
    throw new BridgeError('EXTENSION_HANDLES_NOT_FOUND', `eB self-check failed (${String(eBInfo.result?.value)})`, { missing: ['eB'] });
  }
  return { sessionId, ids, startFunction, eBLength: 2 };
}

/** Reads `IA.getState().auth.loginState` as a string. Local read only. */
export async function readLoginState(cdp: CdpPipe, handles: ExtensionHandles): Promise<string> {
  const response = (await cdp.send('Runtime.callFunctionOn', {
    objectId: handles.ids.IA,
    functionDeclaration: "function(){try{const s=this.getState();return String(s&&s.auth&&s.auth.loginState)}catch(e){return 'error'}}",
    returnByValue: true,
  }, handles.sessionId)) as { result?: RemoteObject };
  return typeof response.result?.value === 'string' ? response.result.value : 'unknown';
}
