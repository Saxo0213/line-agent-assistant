import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createMainBuildOptions } from './build.mjs';

test('the production ESM main build loads bundled CommonJS dependencies', async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'line-main-esm-'));
  const outfile = path.join(outputRoot, 'main.mjs');
  try {
    await build(createMainBuildOptions({
      entryPoint: path.join(import.meta.dirname, 'fixtures', 'esm-main-dependencies.mjs'),
      outfile,
      sourcemap: false,
    }));
    const bundled = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);
    assert.deepEqual(bundled.dependencyTypes, { eventEmitter: 'function', pool: 'function' });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('the packaging config excludes source maps and sets the approved Electron fuses', async () => {
  const config = await readFile(path.join(import.meta.dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8');
  assert.match(config, /^ {2}- '!\*\*\/\*\.map'$/m);
  const fuses = config.slice(config.indexOf('electronFuses:')).split(/\r?\n/).slice(1, 6).join('\n');
  assert.match(fuses, /runAsNode: true/);
  assert.match(fuses, /enableNodeOptionsEnvironmentVariable: false/);
  assert.match(fuses, /enableNodeCliInspectArguments: false/);
  assert.match(fuses, /enableEmbeddedAsarIntegrityValidation: true/);
  assert.match(fuses, /onlyLoadAppFromAsar: true/);
});

test('the packaging config ships only the en, zh, ja and ko Electron locales', async () => {
  const config = await readFile(path.join(import.meta.dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8');
  const block = config.match(/^electronLanguages:\r?\n((?: {2}- .+\r?\n?)+)/m);
  assert.ok(block, 'electronLanguages must be a top-level list');
  const languages = block[1].split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^ {2}- /, '').trim());
  assert.deepEqual([...languages].sort(), ['en-US', 'ja', 'ko', 'zh-CN', 'zh-TW']);
});

test('the NSIS installer runs the app once in first-run setup mode', async () => {
  const root = path.join(import.meta.dirname, '..', '..', '..');
  const config = await readFile(path.join(root, 'electron-builder.yml'), 'utf8');
  const nsis = config.slice(config.indexOf('\nnsis:'));
  assert.match(nsis, /^ {2}include: build\/installer\.nsh$/m);
  const script = await readFile(path.join(root, 'build', 'installer.nsh'), 'utf8');
  assert.match(script, /!macro customInstall/);
  assert.match(script, /ExecWait '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --first-run-setup'/);
});

test('the packaging config uses maximum compression and keeps bundled npm packages out of app.asar', async () => {
  const config = await readFile(path.join(import.meta.dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8');
  assert.match(config, /^compression: maximum$/m);
  assert.match(config, /^ {2}- '!node_modules\{,\/\*\*\/\*\}'$/m);
});

test('only packaged builds minify and keep function names', () => {
  assert.equal(createMainBuildOptions().minify, undefined);
  const packaged = createMainBuildOptions({ sourcemap: false, minify: true });
  assert.equal(packaged.minify, true);
  assert.equal(packaged.keepNames, true);
});

test('packaging scripts build without source maps', async () => {
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'));
  assert.match(manifest.scripts['build:packaged'], /--no-sourcemap/);
  assert.match(manifest.scripts['package:dir'], /^npm run build:packaged /);
  assert.match(manifest.scripts.package, /^npm run build:packaged /);
});
