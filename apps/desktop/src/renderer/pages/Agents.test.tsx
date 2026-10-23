// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, screen, waitFor} from '@testing-library/react';
import type {DesktopApi} from '../../preload/api.js';
import {Agents} from './Agents.js';
import { renderWithAgentLocale } from './agentTestLocale.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agents provider authentication controls', () => {
  it('refreshes unknown providers and requires confirmation to log out', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const api = {
      agentLogin: vi.fn(async () => ({type:'accepted',requestId:'x',ok:true} as const)),
      agentLogout: vi.fn(async () => ({type:'accepted',requestId:'x',ok:true} as const)),
      agentRefreshStatus: vi.fn(async () => ({type:'accepted',requestId:'x',ok:true} as const)),
    } as unknown as DesktopApi;
    renderWithAgentLocale(<Agents api={api} headingRef={React.createRef()} providers={[
      {provider:'codex',status:'logged_in',detail:null},
      {provider:'claude',status:'unknown',detail:null},
    ]} />);

    expect(screen.queryByRole('button',{name:'登入 Codex'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'登出 Codex'}));
    fireEvent.click(screen.getByRole('button',{name:'重新檢查 Claude'}));

    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.agentLogout).toHaveBeenCalledWith('codex'));
    expect(api.agentRefreshStatus).toHaveBeenCalledWith('claude');
    expect(api.agentLogin).not.toHaveBeenCalled();
  });
});
