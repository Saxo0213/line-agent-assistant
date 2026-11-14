// Typed error for the official download bridge. The code is the real failure stage. Do not map it to a generic code.

export type BridgeErrorCode =
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_VERSION_MISMATCH'
  | 'EXTENSION_COPY_FAILED'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_START_FAILED'
  | 'CDP_TIMEOUT'
  | 'CDP_CLOSED'
  | 'CDP_ERROR'
  | 'EXTENSION_LOAD_FAILED'
  | 'EXTENSION_ID_MISMATCH'
  | 'EXTENSION_PAGE_FAILED'
  | 'EXTENSION_HANDLES_NOT_FOUND';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  /** Names of variables that were missing (EXTENSION_HANDLES_NOT_FOUND only). */
  readonly missing: readonly string[];

  constructor(code: BridgeErrorCode, message: string, options: { cause?: unknown; missing?: readonly string[] } = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.missing = options.missing ?? [];
  }
}
