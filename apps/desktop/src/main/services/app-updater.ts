import electronUpdater from 'electron-updater';
import { UPDATE_REPO_NAME, UPDATE_REPO_OWNER } from '../../update-check-protocol.js';
import type { AppUpdaterLike } from './update-check-service.js';

type ConfigurableUpdater = AppUpdaterLike & {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; releaseType: 'release' }): void;
};

/**
 * electron-updater configured for manual download and install. The GitHub feed is set explicitly,
 * so the updater does not depend on a packaged `app-update.yml`.
 */
export function configureAppUpdater(updater: ConfigurableUpdater): AppUpdaterLike {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.setFeedURL({ provider: 'github', owner: UPDATE_REPO_OWNER, repo: UPDATE_REPO_NAME, releaseType: 'release' });
  return updater;
}

export function loadAppUpdater(): AppUpdaterLike {
  return configureAppUpdater(electronUpdater.autoUpdater as unknown as ConfigurableUpdater);
}
