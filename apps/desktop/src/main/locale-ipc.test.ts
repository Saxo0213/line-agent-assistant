import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocaleSettings } from './locale-settings.js';
import { createLocaleIpcAdapter } from './locale-ipc.js';

describe('locale IPC', () => {
  it('validates requests and restricts reads and updates to the trusted renderer', async () => {
    const settings = createLocaleSettings({ filePath: path.join(tmpdir(), 'locale-ipc-test.json'), preferredLanguages: ['ja-JP'], writeFile: async () => undefined as never, renameFile: async () => undefined as never });
    await settings.load();
    const adapter = createLocaleIpcAdapter({ webContentsId: 2, rendererUrl: 'file:///app/index.html', settings });
    await expect(adapter({ senderId: 2, url: 'file:///app/index.html' }, { type: 'getLocale' })).resolves.toEqual({ preference: 'automatic', effectiveLocale: 'ja' });
    await expect(adapter({ senderId: 3, url: 'file:///app/index.html' }, { type: 'getLocale' })).rejects.toThrow('Renderer identity mismatch');
    await expect(adapter({ senderId: 2, url: 'https://evil.invalid' }, { type: 'setLocale', preference: 'ko' })).rejects.toThrow('Renderer identity mismatch');
    await expect(adapter({ senderId: 2, url: 'file:///app/index.html' }, { type: 'setLocale', preference: 'fr' })).rejects.toThrow();
  });

  it('does not expose a locale update if atomic persistence fails', async () => {
    const settings = createLocaleSettings({ filePath: path.join(tmpdir(), 'locale-ipc-failure-test.json'), preferredLanguages: ['en'], writeFile: async () => { throw new Error('disk full'); } });
    const adapter = createLocaleIpcAdapter({ webContentsId: 2, rendererUrl: 'file:///app/index.html', settings });
    await settings.load();
    await expect(adapter({ senderId: 2, url: 'file:///app/index.html' }, { type: 'setLocale', preference: 'ja' })).rejects.toThrow('disk full');
    await expect(adapter({ senderId: 2, url: 'file:///app/index.html' }, { type: 'getLocale' })).resolves.toEqual({ preference: 'automatic', effectiveLocale: 'en' });
  });
});
