import { z } from 'zod';

/** Limits of one download interval of the download bridge, in seconds. */
export const DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MIN = 0;
export const DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MAX = 600;

/** One random interval range. The next non-live download waits a random time from `minSeconds` to `maxSeconds`. */
export const DownloadBridgeIntervalRangeSchema = z.strictObject({
  minSeconds: z.number().int().min(DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MIN).max(DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MAX),
  maxSeconds: z.number().int().min(DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MIN).max(DOWNLOAD_BRIDGE_INTERVAL_SECONDS_MAX),
}).refine((range) => range.minSeconds <= range.maxSeconds, { message: 'minSeconds must not be above maxSeconds' });

/** Intervals for each kind of attachment. */
export const DownloadBridgeIntervalsSchema = z.strictObject({
  image: DownloadBridgeIntervalRangeSchema,
  file: DownloadBridgeIntervalRangeSchema,
});
export type DownloadBridgeIntervalRange = z.infer<typeof DownloadBridgeIntervalRangeSchema>;
export type DownloadBridgeIntervals = z.infer<typeof DownloadBridgeIntervalsSchema>;

export const DEFAULT_DOWNLOAD_BRIDGE_INTERVALS: DownloadBridgeIntervals = {
  image: { minSeconds: 3, maxSeconds: 10 },
  file: { minSeconds: 3, maxSeconds: 10 },
};
