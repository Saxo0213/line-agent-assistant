import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = resolve(root, 'native', 'ChatResourceArchiveHost.cs');
const output = resolve(root, 'dist', 'native', 'ChatResourceArchiveHost.exe');
const staleTestOutput = resolve(root, 'dist', 'native', 'ChatResourceArchiveHost.Test.exe');
const testOutput = resolve(root, '..', '..', 'node_modules', '.cache', 'chat-resource-archive', 'ChatResourceArchiveHost.Test.exe');
const framework = process.env.WINDIR ? resolve(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : '';
if (process.platform !== 'win32') process.exit(0);
if (!framework) throw new Error('The Windows .NET Framework x64 C# compiler is required');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(dirname(testOutput), { recursive: true });
rmSync(staleTestOutput, { force: true });
for (const [target, define] of [[output, undefined], [testOutput, '/define:CHAT_RESOURCE_ARCHIVE_TESTS']]) {
  const built = spawnSync(framework, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', ...(define ? [define] : []), `/out:${target}`, source], { stdio: 'inherit', shell: false });
  if (built.error) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
}
