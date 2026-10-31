import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { copyRuntimeDependencyGraph, pruneRuntimeDependencies, stageResources, verifyStagedResources } from './stage-resources.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('stages and verifies the complete packaged runtime resource contract', async (t) => {
  const temporaryRoot = path.join(repositoryRoot, '.packaging', `test-${process.pid}-${Date.now()}`);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const manifest = await stageResources({ repositoryRoot, outputRoot: temporaryRoot });

  assert.equal(manifest.lineJs.name, '@jsr/evex__linejs');
  assert.equal(manifest.lineJs.version, '3.5.0');
  assert.equal(manifest.lineJs.integrity, 'sha512-LdE2YYA48FAa0NBm8Tq0VyCre5xJ5gQ7+HmJy/VNAE0GozqiuNlB5Y7dKvM1QYe0oyOacYtHHdIknc0xVv8z4w==');
  const required = [
    'line-worker/process-entry.js',
    'line-worker/native/AttachmentBroker.exe',
    'line-worker/node_modules/@evex/linejs/package.json',
    'line-worker/node_modules/@line-agent/contracts/package.json',
    'line-worker/node_modules/@line-agent/line-chrome/package.json',
    'line-worker/node_modules/@line-agent/line-chrome/dist/index.js',
    'line-worker/node_modules/zod/package.json',
    'native/JobHost.exe',
    'database/migrations/001_initial.sql',
    'database/migrations/005_pending_route_recovery.sql',
    'skills/linejs-mcp/SKILL.md',
  ];
  for (const relativePath of required) {
    assert.ok(manifest.files[relativePath], `manifest is missing ${relativePath}`);
  }
  // The JS reader ships once, inside app.asar.unpacked; it is not staged a second time.
  assert.deepEqual(Object.keys(manifest.files).filter((name) => name.startsWith('external-line-reader-js/')), []);
  await assert.rejects(stat(path.join(temporaryRoot, 'external-line-reader-js')), { code: 'ENOENT' });
  const nonRuntime = Object.keys(manifest.files).filter((name) => name.startsWith('line-worker/node_modules/')
    && !name.startsWith('line-worker/node_modules/@evex/linejs/')
    && (/\.d\.[cm]?ts$|\.map$/.test(name) || name.startsWith('line-worker/node_modules/@types/') || /^line-worker\/node_modules\/zod\/src\//.test(name)));
  assert.deepEqual(nonRuntime, []);
  assert.equal(Object.keys(manifest.files).some((name) => name.startsWith('line-worker/node_modules/@line-agent/line-chrome/src/')), false);
  const lineJsPackage = JSON.parse(await readFile(path.join(temporaryRoot, 'line-worker/node_modules/@evex/linejs/package.json'), 'utf8'));
  assert.equal(lineJsPackage.name, '@jsr/evex__linejs');
  await verifyStagedResources(temporaryRoot);
  await assert.rejects(import(pathToFileURL(path.join(temporaryRoot, 'line-worker/process-entry.js')).href), /private worker port and attachment root are required/);
  await assert.rejects(readFile(path.join(temporaryRoot, 'line-worker/test-fixtures/MalformedAttachmentBroker.exe')), /ENOENT/);

  // Import from outside the repository so ancestor node_modules cannot hide an incomplete staged dependency graph.
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'line-agent-isolated-worker-'));
  t.after(() => rm(isolatedRoot, { recursive: true, force: true }));
  await cp(path.join(temporaryRoot, 'line-worker'), path.join(isolatedRoot, 'line-worker'), { recursive: true });
  await rm(path.join(isolatedRoot, 'line-worker', 'chrome-adapter.js'), { force: true });
  await rm(path.join(isolatedRoot, 'line-worker', 'node_modules', '@line-agent', 'line-chrome'), { recursive: true, force: true });
  const isolatedEntry = pathToFileURL(path.join(isolatedRoot, 'line-worker/process-entry.js')).href;
  const childEnv = Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  childEnv.LINE_WORKER_ATTACHMENT_ROOT = path.join(isolatedRoot, 'attachments');
  const isolatedImport = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(isolatedEntry)})`],
    { cwd: isolatedRoot, env: childEnv, encoding: 'utf8' });
  assert.notEqual(isolatedImport.status, 0);
  assert.match(isolatedImport.stderr, /private worker port and attachment root are required/);
  assert.doesNotMatch(isolatedImport.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);

  const linkedOutside = await mkdtemp(path.join(tmpdir(), 'line-agent-manifest-escape-'));
  t.after(() => rm(linkedOutside, { recursive: true, force: true }));
  const stagedLink = path.join(temporaryRoot, 'linked-escape');
  await symlink(linkedOutside, stagedLink, 'junction');
  await assert.rejects(verifyStagedResources(temporaryRoot), /unexpected link/i);
  await unlink(stagedLink);

  const workerEntry = path.join(temporaryRoot, 'line-worker/process-entry.js');
  await writeFile(workerEntry, `${await readFile(workerEntry, 'utf8')}\n// tampered\n`);
  await assert.rejects(verifyStagedResources(temporaryRoot), /hash mismatch.*line-worker\/process-entry\.js/i);
});

test('refuses destructive staging targets and preserves existing non-managed data', async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'line-agent-not-managed-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'keep.txt');
  await writeFile(sentinel, 'keep');
  await assert.rejects(stageResources({ repositoryRoot, outputRoot: outside }), /managed staging/i);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  await assert.rejects(stageResources({ repositoryRoot, outputRoot: repositoryRoot }), /managed staging/i);
  await assert.rejects(stageResources({ repositoryRoot, outputRoot: path.parse(repositoryRoot).root }), /managed staging/i);
});

test('rejects an intermediate staging junction before creating or deleting external data', async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'line-agent-staging-junction-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'keep.txt');
  await writeFile(sentinel, 'keep');
  const intermediate = path.join(repositoryRoot, '.packaging', `junction-${process.pid}-${Date.now()}`);
  await symlink(outside, intermediate, 'junction');
  t.after(() => unlink(intermediate));

  await assert.rejects(
    stageResources({ repositoryRoot, outputRoot: path.join(intermediate, 'resources') }),
    /managed staging|direct child|link|junction/i,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  await assert.rejects(readFile(path.join(outside, 'resources', '.line-agent-managed-staging')), /ENOENT/);
});

test('preserves nested dependency versions and rejects junction escapes', async (t) => {
  const fake = await mkdtemp(path.join(tmpdir(), 'line-agent-deps-'));
  t.after(() => rm(fake, { recursive: true, force: true }));
  const modules = path.join(fake, 'node_modules');
  const destination = path.join(fake, 'output');
  await mkdir(path.join(modules, 'root', 'node_modules', 'dep'), { recursive: true });
  await mkdir(path.join(modules, 'dep'), { recursive: true });
  await writeFile(path.join(modules, 'root', 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { dep: '1.0.0' } }));
  await writeFile(path.join(modules, 'root', 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
  await writeFile(path.join(modules, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '2.0.0' }));
  await copyRuntimeDependencyGraph(fake, destination, ['root']);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'root/node_modules/dep/package.json'), 'utf8')).version, '1.0.0');

  const outside = await mkdtemp(path.join(tmpdir(), 'line-agent-dep-escape-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 'escape', version: '1.0.0' }));
  await symlink(outside, path.join(modules, 'escape'), 'junction');
  await assert.rejects(copyRuntimeDependencyGraph(fake, path.join(fake, 'escaped-output'), ['escape']), /link|containment|escape/i);
});

test('pruning drops declarations, types, docs and sources but keeps the whole pinned linejs tree', async (t) => {
  const fake = await mkdtemp(path.join(tmpdir(), 'line-agent-prune-'));
  t.after(() => rm(fake, { recursive: true, force: true }));
  const put = async (relative, content = 'x') => {
    const absolute = path.join(fake, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };
  await put('zod/package.json', JSON.stringify({ name: 'zod', main: './index.cjs', exports: { '.': { '@zod/source': './src/index.ts', import: './index.js' } } }));
  await put('zod/index.js'); await put('zod/index.d.ts'); await put('zod/index.d.cts'); await put('zod/README.md'); await put('zod/src/index.ts');
  await put('dep/package.json', '{"name":"dep"}'); await put('dep/lib.js'); await put('dep/lib.js.map'); await put('dep/CHANGELOG.md'); await put('dep/src/keep.js');
  await put('@types/node/index.d.ts');
  await put('@evex/linejs/package.json', '{"name":"@jsr/evex__linejs"}'); await put('@evex/linejs/mod.d.ts'); await put('@evex/linejs/README.md'); await put('@evex/linejs/x.js.map');

  await pruneRuntimeDependencies(fake);

  const present = async (relative) => stat(path.join(fake, ...relative.split('/'))).then(() => true, () => false);
  assert.equal(await present('zod/index.js'), true);
  assert.equal(await present('zod/package.json'), true);
  for (const gone of ['zod/index.d.ts', 'zod/index.d.cts', 'zod/README.md', 'zod/src', 'dep/lib.js.map', 'dep/CHANGELOG.md', '@types']) {
    assert.equal(await present(gone), false, `${gone} should be pruned`);
  }
  assert.equal(await present('dep/lib.js'), true);
  assert.equal(await present('dep/src/keep.js'), true);
  for (const kept of ['@evex/linejs/package.json', '@evex/linejs/mod.d.ts', '@evex/linejs/README.md', '@evex/linejs/x.js.map']) {
    assert.equal(await present(kept), true, `${kept} must stay`);
  }
});

test('pruning refuses to remove a src folder that a runtime entry points into', async (t) => {
  const fake = await mkdtemp(path.join(tmpdir(), 'line-agent-prune-src-'));
  t.after(() => rm(fake, { recursive: true, force: true }));
  await mkdir(path.join(fake, 'zod', 'src'), { recursive: true });
  await writeFile(path.join(fake, 'zod', 'package.json'), JSON.stringify({ name: 'zod', main: './src/index.js' }));
  await writeFile(path.join(fake, 'zod', 'src', 'index.js'), 'x');
  await assert.rejects(pruneRuntimeDependencies(fake), /points into src/);
});
