import { describe, expect, it, vi } from 'vitest';
import { configureAppUpdater } from './app-updater.js';

describe('configureAppUpdater', () => {
  it('sets the GitHub feed explicitly and disables automatic download and install', () => {
    const updater = { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), on: vi.fn() };
    configureAppUpdater(updater as never);
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'Saxo0213', repo: 'line-agent-assistant', releaseType: 'release' });
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
  });
});
