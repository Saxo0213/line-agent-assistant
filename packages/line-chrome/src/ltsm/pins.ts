// Hard pins of the LINE Chrome extension's secure-module assets (design ruling 11).
// The md5 values and sizes are the ones the 3.7.2 extension ships; only files that match both are ever used.
// Supporting a later extension version is one new entry in LTSM_PINS.

import { CHROME_EXTENSION_VERSION } from '../constants.js';

export type LtsmAssetName = 'ltsm.wasm' | 'ltsmSandbox.js';

export interface LtsmAssetPin {
  /** Name the verified file gets inside our own store. The file inside the extension may live under any path. */
  readonly fileName: LtsmAssetName;
  /** Lowercase hex md5. */
  readonly md5: string;
  readonly size: number;
}

export interface LtsmVersionPin {
  readonly version: string;
  readonly assets: readonly LtsmAssetPin[];
}

export const LTSM_PINS: readonly LtsmVersionPin[] = [
  {
    version: '3.7.2',
    assets: [
      { fileName: 'ltsm.wasm', md5: 'a7948ea39df1f3ae4cc9cf3ab2811da5', size: 2_254_973 },
      { fileName: 'ltsmSandbox.js', md5: '4769d3fd80c6dcc637bcd8153ba6c087', size: 2_420_558 },
    ],
  },
];

export function pinForVersion(version: string): LtsmVersionPin | undefined {
  return LTSM_PINS.find((pin) => pin.version === version);
}

/** The pin the transport requires: the version the rest of the package speaks. */
export function requiredLtsmPin(): LtsmVersionPin {
  const pin = pinForVersion(CHROME_EXTENSION_VERSION);
  if (!pin) throw new Error(`No ltsm asset pin for extension version ${CHROME_EXTENSION_VERSION}`);
  return pin;
}
