import { reprojectContent, type ReprojectionOptions, type ReprojectionResult } from '@line-agent/database';
import type { Pool } from 'pg';

const SHUTDOWN_DRAIN_MS = 5000;

type Reproject = (pool: Pool, options: ReprojectionOptions) => Promise<ReprojectionResult>;

// Module-level guard: at most one re-projection run exists in the main process, whichever facade started it.
let activeRun: Promise<void> | null = null;

/**
 * Owner of the content-bridge re-projection job (docs/architecture/content-bridge-two-layer-2026-10-20.md).
 * Started once after migrations, runs batches of at most 500 rows one at a time (each its own transaction),
 * has no timers, and stops on shutdown: the batch in flight finishes, then the run ends within a bounded wait.
 */
export class ContentReprojectionService {
  private readonly controller = new AbortController();
  private task: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly pool: Pool, private readonly options: {
    run?: Reproject;
    drainMs?: number;
    onError?: (error: unknown) => void;
    onFinished?: (result: ReprojectionResult) => void;
  } = {}) {}

  /** Idempotent: a second call, or a call while another run exists, does nothing. */
  start(): void {
    if (this.stopping || this.task || activeRun) return;
    const run = this.options.run ?? reprojectContent;
    const task = run(this.pool, { signal: this.controller.signal })
      .then((result) => this.options.onFinished?.(result))
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => { if (activeRun === task) activeRun = null; });
    this.task = task;
    activeRun = task;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    const task = this.task;
    if (!task) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.drainMs ?? SHUTDOWN_DRAIN_MS); })]);
    } finally {
      if (timer) clearTimeout(timer);
      // A run that outlives its bounded shutdown no longer holds the process-wide guard.
      if (activeRun === task) activeRun = null;
    }
  }
}
