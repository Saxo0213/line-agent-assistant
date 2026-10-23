import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseMigrations, resolveJobHost, resolveWorkerEntry } from './resources.js';

describe('runtime resources', () => {
  it('resolves the worktree worker from desktop dist and packaged worker from resources', () => {
    const dist = path.join('C:', 'repo', 'apps', 'desktop', 'dist');
    expect(resolveWorkerEntry(false, dist, 'C:\\resources')).toBe(path.join('C:', 'repo', 'packages', 'line-worker', 'dist', 'process-entry.js'));
    expect(resolveWorkerEntry(true, dist, 'C:\\resources')).toBe(path.join('C:\\resources', 'line-worker', 'process-entry.js'));
  });

  it('resolves packaged migrations and native job host from explicit resources', () => {
    const dist = path.join('C:', 'repo', 'apps', 'desktop', 'dist');
    expect(resolveDatabaseMigrations(true, dist, 'C:\\resources')).toBe(path.join('C:\\resources', 'database', 'migrations'));
    expect(resolveJobHost(true, dist, 'C:\\resources')).toBe(path.join('C:\\resources', 'native', 'JobHost.exe'));
    expect(resolveDatabaseMigrations(false, dist, 'C:\\resources')).toBe(path.join('C:', 'repo', 'packages', 'database', 'migrations'));
    expect(resolveJobHost(false, dist, 'C:\\resources')).toBe(path.join('C:', 'repo', 'packages', 'agent-bridge', 'dist', 'native', 'JobHost.exe'));
  });
});
