import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { verifyLinejsPackage } from './version.js';

const installedRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@evex/linejs/base'))), '..');
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

it('accepts the exact official JSR 3.5.0 package and fixture source files', async () => {
  await expect(verifyLinejsPackage(installedRoot)).resolves.toMatchObject({ status: 'verified', version: '3.5.0' });
});

it('fails closed when a pinned RequestClient fixture drifts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linejs-version-'));
  temporary.push(root);
  await mkdir(join(root, 'base', 'request'), { recursive: true });
  await writeFile(join(root, 'package.json'), await readFile(join(installedRoot, 'package.json')));
  await writeFile(join(root, 'base', 'request', 'mod.js'), '// drifted');
  await expect(verifyLinejsPackage(root)).resolves.toMatchObject({ status: 'PROTOCOL_UNVERIFIED' });
});

it('rejects a newer package version before any network effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linejs-version-'));
  temporary.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@jsr/evex__linejs', version: '3.5.1' }));
  await expect(verifyLinejsPackage(root)).resolves.toMatchObject({ status: 'PROTOCOL_UNVERIFIED' });
});
