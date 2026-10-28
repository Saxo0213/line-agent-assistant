import { UpdateCheckRequestSchema, type UpdateCheckState } from '../update-check-protocol.js';
import type { UpdateCheckService } from './services/update-check-service.js';

type Sender = { senderId: number; url: string };
export function createUpdateCheckIpcAdapter(options: { webContentsId: number; rendererUrl: string; service: Pick<UpdateCheckService, 'state' | 'setEnabled' | 'checkNow' | 'openReleasePage' | 'ignore' | 'install'> }) {
  return async (sender: Sender, payload: unknown): Promise<UpdateCheckState> => {
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) throw new Error('Renderer identity mismatch');
    const request = UpdateCheckRequestSchema.parse(payload);
    if (request.type === 'setEnabled') return options.service.setEnabled(request.enabled);
    if (request.type === 'checkNow') return options.service.checkNow();
    if (request.type === 'ignore') return options.service.ignore(request.version);
    if (request.type === 'install') return options.service.install();
    if (request.type === 'openReleasePage') await options.service.openReleasePage();
    return options.service.state();
  };
}
