import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi } from '../preload/api.js';
import type { UpdateCheckState } from '../update-check-protocol.js';

/** Live update-check state from Main; stays null when the bridge is unavailable (older test doubles). */
export function useUpdateCheck(api: DesktopApi) {
  const [state, setState] = useState<UpdateCheckState | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = api.onUpdateCheckState?.((next) => { if (live) setState(next); });
    void api.getUpdateCheckState?.().then((next) => { if (live) setState(next); }).catch(() => undefined);
    return () => { live = false; unsubscribe?.(); };
  }, [api]);
  const run = useCallback((call: (() => Promise<UpdateCheckState>) | undefined) => {
    void call?.().then(setState).catch(() => undefined);
  }, []);
  return {
    state,
    setEnabled: (enabled: boolean) => run(api.setUpdateCheckEnabled ? () => api.setUpdateCheckEnabled!(enabled) : undefined),
    checkNow: () => run(api.checkForUpdateNow),
    openReleasePage: () => run(api.openUpdateReleasePage),
    ignore: (version: string) => run(api.ignoreUpdateVersion ? () => api.ignoreUpdateVersion!(version) : undefined),
    install: () => run(api.installUpdate),
  };
}
