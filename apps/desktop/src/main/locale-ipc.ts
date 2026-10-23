import { LocaleRequestSchema } from '../locale.js';
import type { createLocaleSettings } from './locale-settings.js';

type Sender = { senderId: number; url: string };
type Settings = ReturnType<typeof createLocaleSettings>;
export function createLocaleIpcAdapter(options: { webContentsId: number; rendererUrl: string; settings: Settings }) {
  return async (sender: Sender, payload: unknown) => {
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) throw new Error('Renderer identity mismatch');
    const request = LocaleRequestSchema.parse(payload);
    return request.type === 'getLocale' ? options.settings.snapshot() : options.settings.update(request.preference);
  };
}
