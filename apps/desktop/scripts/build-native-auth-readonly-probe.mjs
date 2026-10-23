import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const desktopRoot = resolve(import.meta.dirname, '..');
const outputDirectory = join(desktopRoot, 'dist', 'native-auth-readonly-probe');
const nativeDirectory = join(desktopRoot, 'native');
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (process.platform !== 'win32' || !systemRoot) throw new Error('windows_native_probe_build_required');
await mkdir(outputDirectory, { recursive: true });
const compiler = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const inventory = join(nativeDirectory, 'OfficialSourceInventory.cs');
const headerProbe = join(nativeDirectory, 'OfficialSourceHeaderProbe.cs');
const main = join(nativeDirectory, 'OfficialAuthCandidateMain.cs');
const harness = join(nativeDirectory, 'OfficialSourceHeaderProbeHarness.cs');
const references = ['/reference:System.Web.Extensions.dll'];
const production = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${join(outputDirectory, 'official-auth-candidate.exe')}`,
  ...references, main, headerProbe, inventory], { encoding: 'utf8', windowsHide: true });
if (production.status !== 0) throw new Error('native_helper_compile_failed');
const fixtures = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/define:READER_AUTH_PROBE_TEST',
  `/out:${join(outputDirectory, 'official-auth-header-tests.exe')}`, headerProbe, harness, inventory],
{ encoding: 'utf8', windowsHide: true });
if (fixtures.status !== 0) throw new Error('native_fixture_compile_failed');
await build({ entryPoints: [join(desktopRoot, 'scripts', 'probes', 'native-auth-readonly-probe.ts')],
  outfile: join(outputDirectory, 'native-auth-readonly-probe.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external', sourcemap: false, minify: false });
process.stdout.write('PASS|NATIVE_AUTH_READONLY_PROBE_BUILD\n');
