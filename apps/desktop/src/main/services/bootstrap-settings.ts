import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DpapiUserSecretBackend, type SecretBackend } from './secret-store.js';

export interface BootstrapConfiguration {
  databaseUrl: string;
  attachmentRoot: string;
  /** Present only for the app-managed embedded PostgreSQL; paths derive from LOCALAPPDATA. */
  embedded?: { version: string; port: number };
}

function parseEmbedded(value: unknown): { version: string; port: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || !('version' in value) || !('port' in value) || typeof value.version !== 'string'
    || !/^\d+\.\d+$/.test(value.version) || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('Invalid bootstrap settings');
  }
  return { version: value.version, port: value.port };
}

export function bootstrapFromEnvironment(environment: NodeJS.ProcessEnv): BootstrapConfiguration | null {
  const databaseUrl = environment.DATABASE_URL ?? environment.LINE_AGENT_BOOTSTRAP_DATABASE_URL;
  const attachmentRoot = environment.LINE_AGENT_ATTACHMENT_ROOT ?? environment.LINE_AGENT_BOOTSTRAP_ATTACHMENT_ROOT;
  if (!databaseUrl && !attachmentRoot) return null;
  if (!databaseUrl || !attachmentRoot) throw new Error('DATABASE_URL and LINE_AGENT_ATTACHMENT_ROOT must both be configured');
  if (!databaseUrl.startsWith('postgresql://') || !isAbsolute(attachmentRoot)) throw new Error('Invalid bootstrap environment settings');
  return { databaseUrl, attachmentRoot };
}

export class BootstrapSettings {
  private readonly folder: string;
  constructor(environment: { LOCALAPPDATA?: string } = process.env,
    private readonly backend: SecretBackend = new DpapiUserSecretBackend()) {
    if (!environment.LOCALAPPDATA || !isAbsolute(environment.LOCALAPPDATA)) throw new Error('LOCALAPPDATA is required');
    this.folder = join(environment.LOCALAPPDATA, 'LineAgentAssistant');
  }

  get root(): string { return this.folder; }

  async load(): Promise<BootstrapConfiguration | null> {
    let text: string;
    try { text = await readFile(join(this.folder, 'bootstrap.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('databaseUrlProtected' in value) || !('attachmentRoot' in value)
      || typeof value.databaseUrlProtected !== 'string' || typeof value.attachmentRoot !== 'string'
      || !isAbsolute(value.attachmentRoot)) {
      throw new Error('Invalid bootstrap settings');
    }
    const databaseUrl = Buffer.from(await this.backend.unprotect(Buffer.from(value.databaseUrlProtected, 'base64'))).toString('utf8');
    if (!databaseUrl.startsWith('postgresql://')) throw new Error('Invalid bootstrap database connection');
    const embedded = parseEmbedded('embedded' in value ? value.embedded : undefined);
    return { databaseUrl, attachmentRoot: value.attachmentRoot, ...(embedded ? { embedded } : {}) };
  }

  async save(config: BootstrapConfiguration): Promise<void> {
    if (!config.databaseUrl.startsWith('postgresql://') || !isAbsolute(config.attachmentRoot)) {
      throw new Error('Invalid bootstrap settings');
    }
    await mkdir(this.folder, { recursive: true });
    const databaseUrlProtected = Buffer.from(await this.backend.protect(Buffer.from(config.databaseUrl, 'utf8'))).toString('base64');
    const temporary = join(this.folder, `bootstrap.${randomUUID()}.tmp`);
    const embedded = parseEmbedded(config.embedded);
    try {
      await writeFile(temporary, JSON.stringify({ databaseUrlProtected, attachmentRoot: config.attachmentRoot, ...(embedded ? { embedded } : {}) }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.folder, 'bootstrap.json'));
    } finally { await rm(temporary, { force: true }); }
  }
}
