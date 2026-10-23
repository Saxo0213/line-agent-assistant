import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';

/** Extra application-side time beyond the server statement timeout, so a server cancel can still be rolled back. */
export const BOUNDED_TRANSACTION_MARGIN_MS = 1000;
export const DEFAULT_BOUNDED_TRANSACTION_TIMEOUT_MS = 2000;

/** The query surface handed to a bounded transaction body. Every call is limited by the remaining deadline. */
export interface BoundedTransactionClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** Minimal node-postgres client surface used by the helper (a real PoolClient satisfies it). */
export interface BoundedPoolClient {
  query(config: QueryConfig): Promise<QueryResult>;
  release(err?: Error | boolean): void;
}

export interface BoundedTransactionPool {
  connect(): Promise<BoundedPoolClient>;
}

export interface BoundedTransactionOptions {
  /** Server-side `statement_timeout`; the application deadline is this plus BOUNDED_TRANSACTION_MARGIN_MS. */
  timeoutMs?: number;
}

export class BoundedTransactionTimeoutError extends Error {
  readonly code = 'BOUNDED_TRANSACTION_TIMEOUT';
  constructor(readonly deadlineMs: number) {
    super(`Database transaction exceeded its ${deadlineMs} ms deadline.`);
    this.name = 'BoundedTransactionTimeoutError';
  }
}

const swallow = () => undefined;
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/**
 * Runs `fn` inside BEGIN / SET LOCAL statement_timeout / COMMIT with one application deadline covering connection
 * acquisition through cleanup. Each statement carries node-postgres' per-query `query_timeout` equal to the remaining
 * time and is also raced against the deadline. On any failure the transaction is rolled back (bounded, only while
 * time remains), the connection is destroyed with `release(error)`, and the error is rethrown. A connection that
 * arrives after the deadline is destroyed on arrival.
 *
 * A COMMIT that times out is reported as a failure even though the server may have committed; callers fail closed
 * and their writes are protected by versions or uniqueness.
 */
export async function withBoundedTransaction<T>(pool: BoundedTransactionPool, fn: (client: BoundedTransactionClient) => Promise<T>,
  options: BoundedTransactionOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOUNDED_TRANSACTION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer.');
  const budgetMs = timeoutMs + BOUNDED_TRANSACTION_MARGIN_MS;
  const deadlineAt = Date.now() + budgetMs;
  const deadlineError = new BoundedTransactionTimeoutError(budgetMs);
  let expired = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  deadline.catch(swallow);
  const timer = setTimeout(() => { expired = true; rejectDeadline(deadlineError); }, budgetMs);
  const bounded = <R>(work: Promise<R>): Promise<R> => {
    work.catch(swallow);
    return Promise.race([work, deadline]);
  };
  try {
    const acquisition = pool.connect();
    let client: BoundedPoolClient;
    try {
      client = await bounded(acquisition);
    } catch (error) {
      if (expired) void acquisition.then((late) => late.release(deadlineError), swallow);
      throw error;
    }
    let active = true;
    const run = <R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
      if (!active) return Promise.reject(new Error('The bounded transaction is no longer active.'));
      const remaining = deadlineAt - Date.now();
      if (expired || remaining <= 0) return Promise.reject(deadlineError);
      const config = { text, ...(values === undefined ? {} : { values }), query_timeout: Math.ceil(remaining) };
      return bounded(client.query(config) as Promise<QueryResult<R>>);
    };
    try {
      await run('BEGIN');
      await run(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      const result = await bounded(fn({ query: run }));
      await run('COMMIT');
      active = false;
      client.release();
      return result;
    } catch (error) {
      if (!expired && deadlineAt - Date.now() > 0) await run('ROLLBACK').catch(swallow);
      active = false;
      client.release(asError(error));
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}
