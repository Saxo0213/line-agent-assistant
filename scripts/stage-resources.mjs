import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEJS_VERSION = '3.5.0';
const LINEJS_INTEGRITY = 'sha512-LdE2YYA48FAa0NBm8Tq0VyCre5xJ5gQ7+HmJy/VNAE0GozqiuNlB5Y7dKvM1QYe0oyOacYtHHdIknc0xVv8z4w==';
const thisRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_MARKER = '.line-agent-managed-staging';

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function copyRequired(source, destination) {
  try {
    await stat(source);
  } catch {
    throw new Error(`Required packaged resource is missing: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  // Source maps never ship. A leftover `//# sourceMappingURL=` comment in a staged .js file is harmless at runtime.
  await cp(source, destination, { recursive: true, force: true, dereference: false, filter: (entry) => !entry.toLowerCase().endsWith('.map') });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertContainedTree(root, allowedRoot) {
  const allowedReal = await realpath(allowedRoot);
  const visit = async (current) => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Unexpected link in packaged dependency: ${current}`);
    const currentReal = await realpath(current);
    if (currentReal !== allowedReal && !isInside(allowedReal, currentReal)) throw new Error(`Dependency containment escape: ${current}`);
    if (!info.isDirectory()) return;
    for (const entry of await readdir(current)) await visit(path.join(current, entry));
  };
  await visit(root);
}

export async function copyRuntimeDependencyGraph(repositoryRoot, destinationNodeModules, rootNames) {
  const sourceNodeModules = path.join(repositoryRoot, 'node_modules');
  const sourceNodeModulesReal = await realpath(sourceNodeModules);
  const copied = new Set();
  const pending = rootNames.map((name) => ({ name, declaredBy: repositoryRoot, optional: false }));
  const resolveInstalled = async ({ name, declaredBy, optional }) => {
    let cursor = declaredBy;
    while (path.resolve(cursor).startsWith(path.resolve(repositoryRoot))) {
      const candidate = path.join(cursor, 'node_modules', ...name.split('/'));
      if (await stat(path.join(candidate, 'package.json')).then(() => true, () => false)) return candidate;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (optional) return null;
    throw new Error(`Runtime dependency ${name} declared by ${declaredBy} is not installed; run npm ci`);
  };
  while (pending.length > 0) {
    const request = pending.shift();
    const source = await resolveInstalled(request);
    if (!source) continue;
    const sourceReal = await realpath(source);
    if (!isInside(sourceNodeModulesReal, sourceReal)) throw new Error(`Runtime dependency containment escape: ${source}`);
    await assertContainedTree(source, sourceNodeModules);
    const relativeSource = path.relative(sourceNodeModules, source);
    if (relativeSource.startsWith('..')) throw new Error(`Runtime dependency escaped node_modules: ${source}`);
    if (copied.has(relativeSource)) continue;
    const packageJson = await readJson(path.join(source, 'package.json'));
    const destination = path.join(destinationNodeModules, relativeSource);
    await copyRequired(source, destination);
    copied.add(relativeSource);
    pending.push(...Object.keys(packageJson.dependencies ?? {}).map((name) => ({ name, declaredBy: source, optional: false })));
    pending.push(...Object.keys(packageJson.optionalDependencies ?? {}).map((name) => ({ name, declaredBy: source, optional: true })));
  }
  return [...copied].sort();
}

// Non-runtime files that never load in the packaged worker. `@evex/linejs` is pinned by tree hash and is never touched.
const PINNED_PACKAGE_PREFIX = '@evex/linejs';
const NON_RUNTIME_FILE = /(\.d\.[cm]?ts|\.map)$|^(readme|changelog)(\.[^/\\]*)?$/i;
const SOURCE_FOLDER_PACKAGES = ['zod', '@noble/ciphers', 'browser-or-node'];

function entryTargets(value, into = []) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => entryTargets(item, into));
  else if (value && typeof value === 'object') {
    // Custom conditions such as `@zod/source` are never resolved by Node, so they may point at sources.
    for (const [condition, nested] of Object.entries(value)) if (!condition.startsWith('@')) entryTargets(nested, into);
  }
  return into;
}

export async function pruneRuntimeDependencies(nodeModulesRoot) {
  const walk = async (current, relative) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entryRelative === PINNED_PACKAGE_PREFIX || entryRelative.startsWith(`${PINNED_PACKAGE_PREFIX}/`)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entryRelative === '@types') await rm(absolute, { recursive: true, force: true });
        else await walk(absolute, entryRelative);
      } else if (entry.isFile() && NON_RUNTIME_FILE.test(entry.name)) {
        await rm(absolute, { force: true });
      }
    }
  };
  await walk(nodeModulesRoot, '');
  for (const name of SOURCE_FOLDER_PACKAGES) {
    const packageRoot = path.join(nodeModulesRoot, ...name.split('/'));
    const packageJson = await readJson(path.join(packageRoot, 'package.json')).catch(() => null);
    if (!packageJson) continue;
    const targets = [packageJson.main, packageJson.module, packageJson.bin, packageJson.exports].flatMap((value) => entryTargets(value));
    if (targets.some((target) => /(^|\/)src(\/|$)/.test(target))) throw new Error(`Runtime entry of ${name} points into src; refusing to prune it`);
    await rm(path.join(packageRoot, 'src'), { recursive: true, force: true });
  }
}

async function filesBelow(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in staged resources: ${absolute}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute).replaceAll('\\', '/'));
  }
  return result;
}

async function prepareManagedOutput(repositoryRoot, outputRoot) {
  const repositoryReal = await realpath(repositoryRoot);
  const managedParent = path.join(repositoryRoot, '.packaging');
  const resolvedOutput = path.resolve(outputRoot);
  if (path.dirname(resolvedOutput) !== path.resolve(managedParent)) throw new Error('Output must be a direct child of the managed staging root');
  let parentInfo = await lstat(managedParent).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (parentInfo?.isSymbolicLink()) throw new Error('Managed staging parent must not be a link');
  if (parentInfo && !parentInfo.isDirectory()) throw new Error('Managed staging parent must be a directory');
  if (!parentInfo) {
    await mkdir(managedParent);
    parentInfo = await lstat(managedParent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('Managed staging parent must be a directory, not a link');
  }
  const managedParentReal = await realpath(managedParent);
  if (!isInside(repositoryReal, managedParentReal)) throw new Error('Managed staging parent escaped repository');
  const existing = await lstat(resolvedOutput).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Existing staging output is not a managed directory');
    const marker = await readFile(path.join(resolvedOutput, STAGING_MARKER), 'utf8').catch(() => null);
    if (marker !== 'line-agent-packaging-v1\n') throw new Error('Refusing to delete existing non-managed staging output');
    await rm(resolvedOutput, { recursive: true, force: true });
  }
  await mkdir(resolvedOutput, { recursive: true });
  await writeFile(path.join(resolvedOutput, STAGING_MARKER), 'line-agent-packaging-v1\n');
  return resolvedOutput;
}

async function sha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

async function hashFiles(root) {
  const hashes = {};
  for (const relativePath of await filesBelow(root)) {
    if (relativePath === 'resource-manifest.json') continue;
    hashes[relativePath] = await sha256(path.join(root, relativePath));
  }
  return hashes;
}

function lineJsLockContract(lock) {
  const record = lock.packages?.['node_modules/@evex/linejs'];
  if (!record || record.name !== '@jsr/evex__linejs' || record.version !== LINEJS_VERSION || record.integrity !== LINEJS_INTEGRITY) {
    throw new Error('package-lock.json does not pin the approved physical @jsr/evex__linejs@3.5.0 artifact');
  }
  return { name: record.name, version: record.version, integrity: record.integrity, resolved: record.resolved };
}

export async function stageResources({ repositoryRoot = thisRepositoryRoot, outputRoot = path.join(repositoryRoot, '.packaging', 'resources') } = {}) {
  const lock = await readJson(path.join(repositoryRoot, 'package-lock.json'));
  const lineJs = lineJsLockContract(lock);
  outputRoot = await prepareManagedOutput(repositoryRoot, outputRoot);

  const workerRoot = path.join(outputRoot, 'line-worker');
  await copyRequired(path.join(repositoryRoot, 'packages', 'line-worker', 'dist'), workerRoot);
  await rm(path.join(workerRoot, 'test-fixtures'), { recursive: true, force: true });
  await rm(path.join(workerRoot, 'src'), { recursive: true, force: true });
  await writeFile(path.join(workerRoot, 'package.json'), `${JSON.stringify({ name: '@line-agent/packaged-line-worker', private: true, type: 'module' }, null, 2)}\n`);

  const contractsRoot = path.join(workerRoot, 'node_modules', '@line-agent', 'contracts');
  await copyRequired(path.join(repositoryRoot, 'packages', 'contracts', 'dist'), path.join(contractsRoot, 'dist'));
  await writeFile(path.join(contractsRoot, 'package.json'), `${JSON.stringify({ name: '@line-agent/contracts', version: '0.0.0', type: 'module', exports: { '.': './dist/index.js' }, dependencies: { zod: '^4.0.0' } }, null, 2)}\n`);
  const lineChromeRoot = path.join(workerRoot, 'node_modules', '@line-agent', 'line-chrome');
  await copyRequired(path.join(repositoryRoot, 'packages', 'line-chrome', 'dist'), path.join(lineChromeRoot, 'dist'));
  await writeFile(path.join(lineChromeRoot, 'package.json'), `${JSON.stringify({ name: '@line-agent/line-chrome', version: '0.0.0', type: 'module', exports: { '.': './dist/index.js' } }, null, 2)}\n`);
  const runtimeDependencies = await copyRuntimeDependencyGraph(repositoryRoot, path.join(workerRoot, 'node_modules'), ['@evex/linejs', 'zod']);
  await pruneRuntimeDependencies(path.join(workerRoot, 'node_modules'));

  await copyRequired(path.join(repositoryRoot, 'packages', 'agent-bridge', 'dist', 'native', 'JobHost.exe'), path.join(outputRoot, 'native', 'JobHost.exe'));
  if (process.platform === 'win32') await copyRequired(path.join(repositoryRoot, 'apps', 'desktop', 'dist', 'native', 'ChatResourceArchiveHost.exe'), path.join(outputRoot, 'native', 'ChatResourceArchiveHost.exe'));
  await copyRequired(path.join(repositoryRoot, 'packages', 'database', 'migrations'), path.join(outputRoot, 'database', 'migrations'));
  await copyRequired(path.join(repositoryRoot, 'skills', 'linejs-mcp'), path.join(outputRoot, 'skills', 'linejs-mcp'));

  const files = await hashFiles(outputRoot);
  const lineJsFiles = Object.entries(files).filter(([name]) => name.startsWith('line-worker/node_modules/@evex/linejs/'));
  const treeHash = createHash('sha256').update(lineJsFiles.map(([name, hash]) => `${name}\0${hash}\n`).join('')).digest('hex');
  const manifest = { schemaVersion: 1, lineJs: { ...lineJs, treeHash }, runtimeDependencies, files };
  await writeFile(path.join(outputRoot, 'resource-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyStagedResources(outputRoot);
  return manifest;
}

export async function verifyStagedResources(outputRoot) {
  const manifest = await readJson(path.join(outputRoot, 'resource-manifest.json'));
  if (manifest.lineJs?.name !== '@jsr/evex__linejs' || manifest.lineJs?.version !== LINEJS_VERSION || manifest.lineJs?.integrity !== LINEJS_INTEGRITY) {
    throw new Error('Staged LINEJS package identity or lock integrity does not match the approved artifact');
  }
  const packageJson = await readJson(path.join(outputRoot, 'line-worker', 'node_modules', '@evex', 'linejs', 'package.json'));
  if (packageJson.name !== '@jsr/evex__linejs' || packageJson.version !== LINEJS_VERSION) {
    throw new Error('Staged physical @evex/linejs package is not @jsr/evex__linejs@3.5.0');
  }
  const lineChromePackage = await readJson(path.join(outputRoot, 'line-worker', 'node_modules', '@line-agent', 'line-chrome', 'package.json'));
  if (lineChromePackage.name !== '@line-agent/line-chrome' || lineChromePackage.exports?.['.'] !== './dist/index.js') {
    throw new Error('Staged @line-agent/line-chrome package entry is invalid');
  }
  await stat(path.join(outputRoot, 'line-worker', 'node_modules', '@line-agent', 'line-chrome', 'dist', 'index.js'));
  const currentFiles = await hashFiles(outputRoot);
  const expectedNames = Object.keys(manifest.files).sort();
  const currentNames = Object.keys(currentFiles).sort();
  if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames)) throw new Error('Staged resource file set mismatch');
  for (const relativePath of expectedNames) {
    if (currentFiles[relativePath] !== manifest.files[relativePath]) throw new Error(`Hash mismatch for ${relativePath}`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const manifest = await stageResources({ outputRoot });
  process.stdout.write(`Staged ${Object.keys(manifest.files).length} verified resource files.\n`);
}
