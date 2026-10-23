import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LocalePreferenceSchema, LocaleSnapshotSchema, resolveSystemLocale, type Locale, type LocalePreference, type LocaleSnapshot } from '../locale.js';

type Options = { filePath: string; preferredLanguages: readonly string[]; writeFile?: typeof writeFile; renameFile?: typeof rename };
let effectiveLocaleReader: (() => Locale) | undefined;
export function setEffectiveLocaleReader(reader: () => Locale): void { effectiveLocaleReader = reader; }
/** Main-process locale snapshot for subsequent application-generated LINE prompts. */
export function getEffectiveLocale(): Locale { return effectiveLocaleReader?.() ?? 'en'; }

export function createLocaleSettings(options: Options) {
  const preferredLocale = resolveSystemLocale(options.preferredLanguages);
  const write = options.writeFile ?? writeFile;
  const move = options.renameFile ?? rename;
  let preference: LocalePreference = 'automatic';
  let effectiveLocale: Locale = preferredLocale;
  let writes = Promise.resolve();
  const snapshot = (): LocaleSnapshot => LocaleSnapshotSchema.parse({ preference, effectiveLocale });
  return {
    snapshot,
    async load(): Promise<LocaleSnapshot> {
      try {
        const parsed: unknown = JSON.parse(await readFile(options.filePath, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && 'localePreference' in parsed) {
          const validated = LocalePreferenceSchema.safeParse(parsed.localePreference);
          if (validated.success) preference = validated.data;
          else console.warn('[locale] Invalid saved language preference; using automatic language.');
        } else console.warn('[locale] Invalid saved settings document; using automatic language.');
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
          console.warn('[locale] Unable to read saved language preference; using automatic language.');
        }
      }
      effectiveLocale = preference === 'automatic' ? preferredLocale : preference;
      return snapshot();
    },
    async update(next: LocalePreference): Promise<LocaleSnapshot> {
      const validated = LocalePreferenceSchema.parse(next);
      const operation = writes.then(async () => {
        const temp = `${options.filePath}.${randomUUID()}.tmp`;
        await mkdir(path.dirname(options.filePath), { recursive: true });
        try {
          await write(temp, JSON.stringify({ localePreference: validated }), { encoding: 'utf8', flag: 'wx' });
          await move(temp, options.filePath);
        } catch (error) {
          const { unlink } = await import('node:fs/promises');
          await unlink(temp).catch(() => undefined);
          throw error;
        }
        preference = validated;
        return snapshot();
      });
      writes = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
