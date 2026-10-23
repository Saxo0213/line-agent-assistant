/** Release handle of one admission slot. */
export interface ExternalSourceProbeRelease {
  (): void;
  /** True only while this handle still holds the slot (false after release or handoff). */
  isCurrentOwner(): boolean;
}

/** Shared Main-owned admission passed by reference to isolated controller bundles. */
export interface ExternalSourceProbeAdmission {
  acquire(signal?: AbortSignal): Promise<ExternalSourceProbeRelease>;
  isBusy(): boolean;
}

export const EXTERNAL_PROBE_MAX_WAITERS = 4;

interface Waiter {
  grant(): void;
}

/** FIFO single-slot queue: waiters are bounded, abortable, and need no timers. */
export class ExternalSourceProbeAdmissionGate implements ExternalSourceProbeAdmission {
  #owner: symbol | undefined;
  readonly #waiters: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<ExternalSourceProbeRelease> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.#owner) return Promise.resolve(this.#grant());
    if (this.#waiters.length >= EXTERNAL_PROBE_MAX_WAITERS) return Promise.reject(new Error('external_probe_queue_full'));
    return new Promise<ExternalSourceProbeRelease>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.#grant());
        },
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  isBusy(): boolean { return this.#owner !== undefined; }

  #grant(): ExternalSourceProbeRelease {
    const owner = Symbol('external-source-probe');
    this.#owner = owner;
    let released = false;
    const release = (() => {
      if (released) return;
      released = true;
      if (this.#owner !== owner) return;
      this.#owner = undefined;
      this.#waiters.shift()?.grant();
    }) as ExternalSourceProbeRelease;
    release.isCurrentOwner = () => !released && this.#owner === owner;
    return release;
  }
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error('reader_cancelled');
}

// This instance lives in the Main bundle. The separately bundled JS controller
// cannot import its own fallback; callers must inject this exact authority.
export const mainExternalSourceProbeAdmission = new ExternalSourceProbeAdmissionGate();
