import {
  AgentExtensionsError, AgentExtensionsRepository, type SecretCodec,
} from '@line-agent/database';
import type {
  AgentExtensionTools, AgentExtensionsState, AgentMcpImportCandidate, AgentMcpImportListing, AgentMcpImportResult, AgentMcpServerInput,
  AgentMcpServerSummary, AgentRunExtensions,
} from '@line-agent/contracts';
import { readImportSources, type AgentExtensionImportLocations, type ImportEntry } from './agent-extension-import.js';
import type { SecretBackend } from './secret-store.js';

/** Seals secret JSON with the OS user-bound backend (Windows DPAPI, the same one that protects LINE credentials). */
export class BackendSecretCodec implements SecretCodec {
  constructor(private readonly backend: SecretBackend) {}
  async seal(plain: string): Promise<string> { return Buffer.from(await this.backend.protect(Buffer.from(plain, 'utf8'))).toString('base64'); }
  async open(sealed: string): Promise<string> { return Buffer.from(await this.backend.unprotect(Buffer.from(sealed, 'base64'))).toString('utf8'); }
}

export class AgentExtensionsServiceError extends Error {
  constructor(public readonly code: 'NAME_TAKEN' | 'NOT_FOUND' | 'LIMIT' | 'INVALID', message: string) { super(message); this.name = 'AgentExtensionsServiceError'; }
}

/** Main-side owner of the extra Agent tools: stored servers, built-in tool additions, local imports and the per-run resolution. */
export class AgentExtensionsService {
  constructor(private readonly repository: AgentExtensionsRepository, private readonly locations: () => AgentExtensionImportLocations) {}

  async state(): Promise<AgentExtensionsState> {
    return { servers: await this.repository.list(), tools: await this.repository.getTools() };
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof AgentExtensionsError) throw new AgentExtensionsServiceError(error.code, error.message);
      throw error;
    }
  }

  save(input: AgentMcpServerInput): Promise<AgentMcpServerSummary> { return this.guard(() => this.repository.save(input)); }
  delete(id: string): Promise<void> { return this.guard(() => this.repository.delete(id)); }
  setEnabled(id: string, enabled: boolean): Promise<AgentMcpServerSummary> { return this.guard(() => this.repository.setEnabled(id, enabled)); }
  setTools(tools: AgentExtensionTools): Promise<AgentExtensionTools> { return this.repository.setTools(tools); }

  /** Everything found in the local configs, with secrets reduced to key names. The source files are only read. */
  async listImportCandidates(): Promise<AgentMcpImportListing> {
    const taken = await this.repository.names();
    const sources = await readImportSources(this.locations());
    return {
      sources: sources.map((source) => ({
        source: source.source, status: source.status, ...(source.error ? { error: source.error } : {}),
        candidates: source.entries.map((entry): AgentMcpImportCandidate => ({
          source: entry.source, sourceName: entry.sourceName.slice(0, 256), name: entry.name, transport: entry.transport,
          ...(entry.command === undefined ? {} : { command: entry.command }), args: entry.args, envKeys: entry.envKeys,
          ...(entry.url === undefined ? {} : { url: entry.url }), headerKeys: entry.headerKeys,
          ...(entry.issue ? { issue: entry.issue } : {}), nameTaken: taken.has(entry.name),
        })).slice(0, 256),
      })),
    };
  }

  /** Re-reads the sources (secrets never pass through the renderer) and stores the selected definitions with encrypted secrets. */
  async importSelected(selection: Array<{ source: ImportEntry['source']; sourceName: string }>): Promise<AgentMcpImportResult> {
    const sources = await readImportSources(this.locations());
    const result: AgentMcpImportResult = { imported: [], skipped: [] };
    for (const item of selection) {
      const entry = sources.find((source) => source.source === item.source)?.entries.find((candidate) => candidate.sourceName === item.sourceName);
      const skip = (reason: AgentMcpImportResult['skipped'][number]['reason']) => result.skipped.push({ source: item.source, sourceName: item.sourceName, reason });
      if (!entry) { skip('NOT_FOUND'); continue; }
      if (entry.issue === 'RESERVED_NAME') { skip('RESERVED_NAME'); continue; }
      if (entry.issue || !entry.input) { skip('UNSUPPORTED'); continue; }
      try {
        await this.repository.save(entry.input, entry.source);
        result.imported.push(entry.name);
      } catch (error) {
        if (error instanceof AgentExtensionsError && (error.code === 'NAME_TAKEN' || error.code === 'LIMIT')) skip(error.code);
        else if (error instanceof AgentExtensionsError) skip('UNSUPPORTED');
        else throw error;
      }
    }
    return result;
  }

  /** Decrypted extras for one eligible run; null when there is nothing to add. */
  resolveForRun(): Promise<AgentRunExtensions | null> { return this.repository.resolveForRun(); }
}
