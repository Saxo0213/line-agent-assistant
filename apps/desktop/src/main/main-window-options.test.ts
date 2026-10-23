import { describe, expect, it } from 'vitest';
import { createMainWindowOptions } from './main-window-options.js';

describe('main window options', () => {
  it('hides the native application menu while preserving renderer isolation', () => {
    expect(createMainWindowOptions('app.ico', 'preload.js')).toMatchObject({
      width: 960,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      autoHideMenuBar: true,
      icon: 'app.ico',
      webPreferences: {
        preload: 'preload.js',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
  });
});
