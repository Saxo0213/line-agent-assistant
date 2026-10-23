import type { BrowserWindowConstructorOptions } from 'electron';

export function createMainWindowOptions(icon: string, preload: string): BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F4F7F6',
    title: 'LINE Agent Assistant',
    icon,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}
