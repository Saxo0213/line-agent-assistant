export type ChromeLtsmUnavailableStatus = Readonly<{
  kind: 'missing' | 'wrong-version' | 'corrupt';
  required: string;
  detected?: readonly string[];
}>;

/** Typed, path-free error used by the worker protocol without loading the optional Chrome transport. */
export class ChromeLtsmUnavailableError extends Error {
  readonly code = 'CHROME_LTSM_UNAVAILABLE';
  readonly status: 'missing' | 'wrong-version' | 'corrupt';
  readonly required: string;
  readonly detected: readonly string[];

  constructor(status: ChromeLtsmUnavailableStatus) {
    const detected = status.kind === 'wrong-version' ? [...(status.detected ?? [])] : [];
    super(status.kind === 'wrong-version'
      ? `LINE Chrome assets are for extension version ${detected.join(', ') || 'unknown'}, but ${status.required} is required`
      : status.kind === 'corrupt'
        ? `LINE Chrome assets for extension version ${status.required} failed verification`
        : `LINE Chrome assets for extension version ${status.required} are not installed`);
    this.name = 'ChromeLtsmUnavailableError';
    this.status = status.kind;
    this.required = status.required;
    this.detected = detected;
  }
}

export function isChromeLtsmUnavailable(error: unknown): error is ChromeLtsmUnavailableError {
  return error instanceof ChromeLtsmUnavailableError;
}
