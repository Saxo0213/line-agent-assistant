export const PER_TYPE_LIMIT: number;
export const MAX_LINE_BYTES: number;
export const MAX_TOTAL_BYTES: number;
export const MAX_ROWS: number;
export const LIVE_ROWS_SQL: string;
export interface LiveRowsQueryClient { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; }
export function fetchLiveRows(client: LiveRowsQueryClient, options?: { perType?: number; maxLineBytes?: number; maxTotalBytes?: number; maxRows?: number }):
  Promise<{ lines: string[]; dropped: number; truncated: boolean }>;
