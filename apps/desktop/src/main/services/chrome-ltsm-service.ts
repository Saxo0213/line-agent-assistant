import nodePath from 'node:path';
import type { ChromeLtsmInstallResult, ChromeLtsmStatus } from '@line-agent/contracts';
import {
  discoverLtsmAssets, LtsmStore, verifyManualFolder,
  type LtsmDiscoveryResult, type LtsmPath, type LtsmStoreStatus, type LtsmVersionPin, type LtsmWritableFs,
} from '@line-agent/line-chrome';

/** The functions that Main needs from the ltsm asset service. The facade uses this interface, not the class. */
export interface ChromeLtsmControl {
  /** Absolute path of the store root. Main gives it to a CHROMEOS worker as `chromeLtsmDir`. */
  readonly rootDir: string;
  status(): Promise<ChromeLtsmStatus>;
  detectAndInstall(): Promise<ChromeLtsmInstallResult>;
  installFromFolder(folder: string): Promise<ChromeLtsmInstallResult>;
}

export interface ChromeLtsmServiceOptions {
  /** Electron userData directory. The assets are in `<userData>/line-chrome/ltsm/<version>/`. */
  userDataDir: string;
  env?: { LOCALAPPDATA?: string | undefined };
  fs?: LtsmWritableFs;
  path?: LtsmPath;
  /** For tests. The pin to require instead of the 3.7.2 pin. */
  pin?: LtsmVersionPin;
}

/** Store status for the renderer. It has no file path. */
export function publicLtsmStatus(status: LtsmStoreStatus): ChromeLtsmStatus {
  switch (status.kind) {
    case 'available': return { kind: 'available', version: status.version };
    case 'missing': return { kind: 'missing', required: status.required };
    case 'wrong-version': return { kind: 'wrong-version', required: status.required, detected: status.detected.slice(0, 32) };
    case 'corrupt': return { kind: 'corrupt', required: status.required, problems: status.problems.slice(0, 8).map((item) => item.slice(0, 300)) };
  }
}

/**
 * Find, verify and store the ltsm assets of the LINE Chrome extension (design rulings 11 and 12).
 * @line-agent/line-chrome does the work: discovery matches by md5. The store checks size and md5 again at each load.
 */
export class ChromeLtsmService implements ChromeLtsmControl {
  readonly rootDir: string;
  private readonly store: LtsmStore;
  private readonly env: { LOCALAPPDATA?: string | undefined };
  private readonly fs: LtsmWritableFs | undefined;
  private readonly path: LtsmPath | undefined;
  private readonly pin: LtsmVersionPin | undefined;
  private lane: Promise<unknown> = Promise.resolve();

  constructor(options: ChromeLtsmServiceOptions) {
    const path = options.path ?? nodePath;
    this.rootDir = path.join(options.userDataDir, 'line-chrome', 'ltsm');
    this.env = options.env ?? process.env;
    this.fs = options.fs;
    this.path = options.path;
    this.pin = options.pin;
    this.store = new LtsmStore({ rootDir: this.rootDir, ...(options.fs ? { fs: options.fs } : {}), ...(options.path ? { path: options.path } : {}),
      ...(options.pin ? { pin: options.pin } : {}) });
  }

  async status(): Promise<ChromeLtsmStatus> {
    return publicLtsmStatus(await this.store.status());
  }

  /** Search all Chrome and Edge profiles. Copy the files to the store when the md5 matches. */
  detectAndInstall(): Promise<ChromeLtsmInstallResult> {
    return this.serialized(async () => this.finish(await discoverLtsmAssets(this.discoveryOptions())));
  }

  /** Do the same md5 check for a folder that the user chose. */
  installFromFolder(folder: string): Promise<ChromeLtsmInstallResult> {
    return this.serialized(async () => this.finish(await verifyManualFolder(folder, this.discoveryOptions())));
  }

  private discoveryOptions() {
    return { env: this.env, ...(this.fs ? { fs: this.fs } : {}), ...(this.path ? { path: this.path } : {}), ...(this.pin ? { pin: this.pin } : {}) };
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lane.then(task, task);
    this.lane = run.catch(() => undefined);
    return run;
  }

  private async finish(found: LtsmDiscoveryResult): Promise<ChromeLtsmInstallResult> {
    if (found.kind === 'not-found') return { kind: 'not-found', required: found.required };
    if (found.kind === 'wrong-version') {
      const seen = new Set<string>();
      const detected = found.detected.flatMap((item) => {
        const key = `${item.browser}\0${item.profile}\0${item.extensionVersion}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ browser: item.browser, profile: item.profile.slice(0, 128), version: item.extensionVersion.slice(0, 64) }];
      }).slice(0, 32);
      return { kind: 'wrong-version', required: found.required, detected };
    }
    const installed = publicLtsmStatus(await this.store.install(found.match));
    if (installed.kind === 'available') {
      return { kind: 'installed', status: installed, source: { browser: found.match.browser, profile: found.match.profile.slice(0, 128) } };
    }
    if (installed.kind === 'corrupt') return { kind: 'corrupt', required: installed.required, problems: installed.problems };
    if (installed.kind === 'wrong-version') {
      return { kind: 'wrong-version', required: installed.required,
        detected: installed.detected.map((version) => ({ browser: found.match.browser, profile: found.match.profile.slice(0, 128), version })) };
    }
    return { kind: 'not-found', required: installed.required };
  }
}
