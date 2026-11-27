import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_FEATURES, checkExtensionFeatures } from './extension-features.js';

// Pinned 3.7.2 copy of this PC. The tests that need it are skipped when it is absent.
const MAIN_JS = nodePath.join(process.env.APPDATA ?? '', '@line-agent', 'desktop', 'official-download-bridge', 'ext', '3.7.2', 'static', 'js', 'main.js');
const present = existsSync(MAIN_JS);

describe('extension feature signatures', () => {
  it('uses safe, unique names', () => {
    const names = EXTENSION_FEATURES.map((feature) => feature.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z0-9_]{1,24}$/);
  });

  it.skipIf(!present)('passes every signature on main.js of 3.7.2', () => {
    expect(checkExtensionFeatures(readFileSync(MAIN_JS, 'latin1'))).toEqual({ ok: true, failed: [] });
  });

  it.skipIf(!present)('fails the named signature when the code text changed', () => {
    const text = readFileSync(MAIN_JS, 'latin1');
    const changed = text.replace('e.MEDIA_VIEWER="media_viewer"', 'e.MEDIA_VIEWER="media_viewer2"')
      .replace('LOGGED_IN="logged_in"', 'LOGGED_IN="signed_in"');
    const result = checkExtensionFeatures(changed);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['LOGIN_STATES', 'MEDIA_VIEWER']);
  });

  it('fails every signature on an unrelated text', () => {
    expect(checkExtensionFeatures('nothing').failed).toHaveLength(EXTENSION_FEATURES.length);
  });
});
