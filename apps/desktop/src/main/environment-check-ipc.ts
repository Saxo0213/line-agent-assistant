import { EnvironmentCheckRequestSchema, type EnvironmentCheckResult, type EnvironmentInstallResult } from '../environment-check-protocol.js';
import type { EnvironmentCheckService } from './services/environment-check.js';

type Sender = { senderId: number; url: string };
/** Only the main window renderer may call this channel. The request has a fixed shape: a check, or an install id from a fixed list. */
export function createEnvironmentCheckIpcAdapter(options: { webContentsId: number; rendererUrl: string; service: Pick<EnvironmentCheckService, 'check' | 'install'> }) {
  return async (sender: Sender, payload: unknown): Promise<EnvironmentCheckResult | EnvironmentInstallResult> => {
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) throw new Error('Renderer identity mismatch');
    const request = EnvironmentCheckRequestSchema.parse(payload);
    if (request.type === 'installEnvironmentItem') return { started: await options.service.install(request.id) };
    return options.service.check();
  };
}
