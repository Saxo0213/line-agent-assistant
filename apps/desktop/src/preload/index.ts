import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopApi } from './api.js';

contextBridge.exposeInMainWorld('lineAgent', createDesktopApi(ipcRenderer));
