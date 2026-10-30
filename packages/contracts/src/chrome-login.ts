import { z } from 'zod';

/** Chrome Web Store page of the LINE extension. The openChromeExtensionStore IPC opens only this URL. */
export const CHROME_EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/ophjlpahpchlmihnnnihgmmeilfjmjjc';
/** IPC error code. Main returns it when a CHROMEOS login or switch needs ltsm assets that are not usable. */
export const CHROME_LTSM_UNAVAILABLE_CODE = 'CHROME_LTSM_UNAVAILABLE';

const Version = z.string().min(1).max(64);
const Problem = z.string().min(1).max(300);

/** The assets exist and pass verification. It has no file path. */
export const ChromeLtsmAvailableStatusSchema = z.strictObject({ kind: z.literal('available'), version: Version });
/** The reason why CHROMEOS login cannot start. `wrong-version` lists the extension versions found on this computer. */
export const ChromeLtsmUnavailableStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('missing'), required: Version }),
  z.strictObject({ kind: z.literal('wrong-version'), required: Version, detected: z.array(Version).max(32) }),
  z.strictObject({ kind: z.literal('corrupt'), required: Version, problems: z.array(Problem).max(8) }),
]);
export const ChromeLtsmStatusSchema = z.union([ChromeLtsmAvailableStatusSchema, ChromeLtsmUnavailableStatusSchema]);
export type ChromeLtsmStatus = z.infer<typeof ChromeLtsmStatusSchema>;
export type ChromeLtsmUnavailableStatus = z.infer<typeof ChromeLtsmUnavailableStatusSchema>;

const DetectedInstall = z.strictObject({ browser: z.enum(['chrome', 'edge', 'manual']), profile: z.string().max(128), version: Version });
/** Result of an automatic search (detectChromeLtsm) or of a folder that the user chose (chooseChromeLtsmFolder). */
export const ChromeLtsmInstallResultSchema = z.discriminatedUnion('kind', [
  /** Main found matching assets and copied them to the app store. */
  z.strictObject({ kind: z.literal('installed'), status: ChromeLtsmAvailableStatusSchema,
    source: z.strictObject({ browser: z.enum(['chrome', 'edge', 'manual']), profile: z.string().max(128) }) }),
  /** Main found the extension, but no copy has the required version and md5. */
  z.strictObject({ kind: z.literal('wrong-version'), required: Version, detected: z.array(DetectedInstall).max(32) }),
  z.strictObject({ kind: z.literal('not-found'), required: Version }),
  /** Main found a match, but the copy failed verification. */
  z.strictObject({ kind: z.literal('corrupt'), required: Version, problems: z.array(Problem).max(8) }),
]);
export type ChromeLtsmInstallResult = z.infer<typeof ChromeLtsmInstallResultSchema>;
