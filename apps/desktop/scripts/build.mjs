import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { removeRetiredProbeOutput } from './build-retired-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Packaged builds minify; `keepNames` preserves function/class names that diagnostics and error text may print.
export function minifyOptions(minify) {
  return minify ? { minify: true, keepNames: true } : {};
}

export function createMainBuildOptions({
  entryPoint = path.join(root, 'src/main/main.ts'),
  outfile = path.join(root, 'dist/main.js'),
  sourcemap = true,
  minify = false,
} = {}) {
  return { entryPoints: [entryPoint], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    external: ['electron'], sourcemap, ...minifyOptions(minify),
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
}

export async function buildDesktop({ sourcemap = true, minify = false } = {}) {
  await viteBuild({ configFile: path.join(root, 'vite.config.ts') });
  if (process.platform === 'win32' && process.arch === 'x64') {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build-js-external-reader.mjs'), ...(minify ? ['--minify'] : [])], { stdio: 'inherit', windowsHide: true });
  }
  const scripts = path.join(root, 'dist', 'scripts');
  await mkdir(scripts, { recursive: true });
  await removeRetiredProbeOutput(scripts);
  const shrink = minifyOptions(minify);
  await build(createMainBuildOptions({ sourcemap, minify }));
  await build({ entryPoints: [path.join(root, 'src/mcp-stdio-bridge/index.ts')], outfile: path.join(root, 'dist/mcp-stdio-bridge.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap, ...shrink });
  await build({ entryPoints: [path.join(root, 'src/main/runtime-inventory-worker.ts')], outfile: path.join(root, 'dist/runtime-inventory-worker.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron'], sourcemap, ...shrink });
  await build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'dist/preload.cjs'), bundle: true,
    platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap, ...shrink });
}

// `--no-sourcemap` is used by the packaging scripts only; development builds keep their maps and stay unminified.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packaged = process.argv.includes('--no-sourcemap');
  await buildDesktop({ sourcemap: !packaged, minify: packaged });
}
