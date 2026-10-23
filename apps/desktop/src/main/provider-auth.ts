import type {AgentProvider, ProviderStatus} from '@line-agent/contracts';

type AuthProbe = {status:'authenticated'|'logged_out'|'not_installed'|'error'; detail?:string};

export async function probeInitialProviderAuth(options: {
  getAuthStatus(provider:AgentProvider):Promise<AuthProbe>;
  report(status:ProviderStatus):void;
}):Promise<void> {
  await Promise.all((['codex','claude'] as const).map(async provider => {
    let auth:AuthProbe;
    try { auth=await options.getAuthStatus(provider); }
    catch { auth={status:'error',detail:'Unable to inspect the official CLI login status.'}; }
    const status=auth.status==='authenticated'?'logged_in':auth.status;
    options.report({provider,status,detail:auth.detail??null});
  }));
}
