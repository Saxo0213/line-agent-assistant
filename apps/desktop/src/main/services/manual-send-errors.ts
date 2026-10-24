/** A worker gateway rejected the request before it entered the native send queue. */
export class ManualSendNotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualSendNotStartedError';
  }
}
