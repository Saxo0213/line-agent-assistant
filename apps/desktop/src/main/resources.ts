import path from 'node:path';

export function resolveWorkerEntry(packaged: boolean, mainDir: string, resourcesPath: string): string {
  return packaged
    ? path.join(resourcesPath, 'line-worker', 'process-entry.js')
    : path.resolve(mainDir, '../../../packages/line-worker/dist/process-entry.js');
}

export function resolveDatabaseMigrations(packaged: boolean, mainDir: string, resourcesPath: string): string {
  return packaged ? path.join(resourcesPath, 'database', 'migrations') : path.resolve(mainDir, '../../../packages/database/migrations');
}

export function resolveJobHost(packaged: boolean, mainDir: string, resourcesPath: string): string {
  return packaged ? path.join(resourcesPath, 'native', 'JobHost.exe') : path.resolve(mainDir, '../../../packages/agent-bridge/dist/native/JobHost.exe');
}

export function resolveSkillsDirectory(packaged: boolean, mainDir: string, resourcesPath: string): string {
  return packaged ? path.join(resourcesPath, 'skills') : path.resolve(mainDir, '../../../skills');
}
