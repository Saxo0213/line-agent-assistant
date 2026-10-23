import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatNumber, formatTime, resolveSystemLocale, translate } from '../locale.js';
import { createLocaleSettings, getEffectiveLocale, setEffectiveLocaleReader } from './locale-settings.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('locale foundation', () => {
  it.each([
    [['zh-Hans-CN', 'fr-FR', 'ja-JP'], 'ja'], [['zh-Hans-SG'], 'en'], [['zh-CN'], 'en'], [['zh-SG'], 'en'],
    [['zh-Hant'], 'zh-TW'], [['zh-Hant-TW'], 'zh-TW'], [['zh-Hant-HK'], 'zh-TW'], [['zh-Hant-MO-u-nu-hanidec'], 'zh-TW'], [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'],
    [['fr-FR', 'ko-KR'], 'ko'], [[], 'en'],
  ] as const)('resolves %j to %s', (preferred, expected) => expect(resolveSystemLocale(preferred)).toBe(expected));

  it('loads the preference, saves without changing this process locale, and preserves the old snapshot on failure', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'locale-'));
    const settings = createLocaleSettings({ filePath: path.join(directory, 'app-settings.json'), preferredLanguages: ['ja-JP'] });
    await settings.load();
    setEffectiveLocaleReader(() => settings.snapshot().effectiveLocale);
    expect(settings.snapshot()).toEqual({ preference: 'automatic', effectiveLocale: 'ja' });
    expect(getEffectiveLocale()).toBe('ja');
    await settings.update('ko');
    expect(JSON.parse(await readFile(path.join(directory, 'app-settings.json'), 'utf8'))).toEqual({ localePreference: 'ko' });
    expect(settings.snapshot()).toEqual({ preference: 'ko', effectiveLocale: 'ja' });
    expect(getEffectiveLocale()).toBe('ja');
    const nextProcess = createLocaleSettings({ filePath: path.join(directory, 'app-settings.json'), preferredLanguages: ['en-US'] });
    await nextProcess.load();
    expect(nextProcess.snapshot()).toEqual({ preference: 'ko', effectiveLocale: 'ko' });
    const failing = createLocaleSettings({ filePath: path.join(directory, 'missing', 'settings.json'), preferredLanguages: ['en'], writeFile: vi.fn(async () => { throw new Error('disk full'); }) });
    await failing.load();
    await expect(failing.update('ja')).rejects.toThrow('disk full');
    expect(failing.snapshot()).toEqual({ preference: 'automatic', effectiveLocale: 'en' });
    const existingPath = path.join(directory, 'existing-settings.json');
    await writeFile(existingPath, JSON.stringify({ localePreference: 'ja' }));
    const writeFailure = createLocaleSettings({ filePath: existingPath, preferredLanguages: ['en'], writeFile: vi.fn(async () => { throw new Error('disk full'); }) });
    await writeFailure.load();
    await expect(writeFailure.update('ko')).rejects.toThrow('disk full');
    expect(await readFile(existingPath, 'utf8')).toBe(JSON.stringify({ localePreference: 'ja' }));
    expect(writeFailure.snapshot()).toEqual({ preference: 'ja', effectiveLocale: 'ja' });
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('provides shared translations and locale formatting for %s', (locale) => {
    expect(translate(locale, 'systemTitle')).toBeTruthy();
    expect(formatDate(locale, new Date('2026-01-02T00:00:00Z'), { timeZone: 'UTC' })).toBeTruthy();
    expect(formatTime(locale, new Date('2026-01-02T12:30:00Z'), { timeZone: 'UTC' })).toBeTruthy();
    expect(formatNumber(locale, 1234.5)).toBeTruthy();
  });

  it('diagnoses malformed settings documents and falls back to automatic', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'locale-invalid-'));
    const filePath = path.join(directory, 'app-settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{}');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const settings = createLocaleSettings({ filePath, preferredLanguages: ['ja-JP'] });
    await settings.load();
    expect(settings.snapshot()).toEqual({ preference: 'automatic', effectiveLocale: 'ja' });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Invalid saved settings document'));
    warning.mockRestore();
  });
});
