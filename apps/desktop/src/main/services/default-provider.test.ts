import { describe, expect, it } from 'vitest';
import { normalizeDefaultProvider, resolveDefaultProvider } from './default-provider.js';

describe('default provider rule', () => {
  it('uses Codex only for the stored value codex; missing or invalid means Claude', () => {
    expect(normalizeDefaultProvider('codex')).toBe('codex');
    for (const value of ['claude', undefined, null, '', 'CODEX', 7]) expect(normalizeDefaultProvider(value)).toBe('claude');
  });
  it('reads the global app setting', async () => {
    const keys: string[] = [];
    expect(await resolveDefaultProvider({ getAppSetting: async (key) => { keys.push(key); return 'codex'; } })).toBe('codex');
    expect(keys).toEqual(['default_provider']);
  });
});
