import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../preload/api.js';
import type { FriendRow } from '../main/service-facade.js';

type FriendsState = { accountId: string | null; friends: FriendRow[] | null; error: boolean };

/**
 * Friend list of one account for the conversation list's 好友 view. Fetches when enabled and again whenever `token`
 * (the snapshot revision) changes. At most one request is in flight: a change that arrives meanwhile is coalesced into
 * one follow-up request, and results for a disabled view or another account are dropped. No timer.
 */
export function useFriends(api: DesktopApi, accountId: string | null, enabled: boolean, token: unknown): { friends: FriendRow[] | null; error: boolean } {
  const [state, setState] = useState<FriendsState>({ accountId: null, friends: null, error: false });
  const flight = useRef({ running: false, dirty: false });
  const target = useRef<string | null>(null);
  useEffect(() => {
    target.current = enabled ? accountId : null;
    if (!enabled || !accountId) return;
    const run = () => {
      const current = flight.current;
      if (current.running) { current.dirty = true; return; }
      const id = target.current;
      if (!id) return;
      current.running = true;
      current.dirty = false;
      api.listFriends(id).then(
        (friends) => { if (target.current === id) setState({ accountId: id, friends, error: false }); },
        () => { if (target.current === id) setState((previous) => ({ accountId: id, friends: previous.accountId === id ? previous.friends : null, error: true })); },
      ).finally(() => {
        current.running = false;
        if (current.dirty && target.current) { current.dirty = false; run(); }
      });
    };
    run();
    return () => { target.current = null; };
  }, [api, accountId, enabled, token]);
  const matches = enabled && state.accountId === accountId;
  return { friends: matches ? state.friends : null, error: matches && state.error };
}
