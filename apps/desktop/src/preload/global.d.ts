import type { DesktopApi } from './api.js';
declare global {
  interface Window { lineAgent: DesktopApi }
}
export {};
