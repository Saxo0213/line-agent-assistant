import { join } from 'node:path';

/** Built-in fallback artifact. Download only this exact URL over HTTPS; redirects are refused. */
export const EMBEDDED_PG_PIN = Object.freeze({
  version: '18.6',
  url: 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip',
  size: 384_620_317,
  sha256: 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2',
});

/** Server manifest (preferred source). Empty would disable the manifest step. */
export const EMBEDDED_PG_MANIFEST_URL = 'https://raw.githubusercontent.com/Saxo0213/line-agent-assistant/main/manifest.json';

export const EMBEDDED_PG_MANIFEST_URL_PATTERN = /^https:\/\/get\.enterprisedb\.com\/postgresql\/postgresql-(18\.\d+)-\d+-windows-x64-binaries\.zip$/;
export const EMBEDDED_PG_ADMIN_USER = 'line_agent_admin';
export const EMBEDDED_PG_DATABASE = 'line_agent';
export const EMBEDDED_PG_PORT_RANGE = Object.freeze({ first: 55432, last: 55531 });
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
export const MANAGED_CONF_MARKER = '# --- line-agent managed settings ---';

export type EmbeddedPaths = ReturnType<typeof embeddedPaths>;

/**
 * All locations derive from the embedded root (%ProgramData%\LineAgentAssistant\postgres\<SID>, an ASCII path; see
 * root.ts); none are stored in bootstrap.json.
 */
export function embeddedPaths(embeddedRoot: string, version: string) {
  const postgres = embeddedRoot;
  const install = join(postgres, version);
  return {
    postgres, downloads: join(postgres, 'downloads'), install, bin: join(install, 'bin'), data: join(postgres, 'data'),
    logs: join(postgres, 'logs'), log: join(postgres, 'logs', 'postgresql.log'), installed: join(install, '.installed.json'),
  };
}
