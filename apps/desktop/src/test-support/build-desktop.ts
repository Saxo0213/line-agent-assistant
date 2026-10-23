import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Environment flag set by tests/support/prebuild-desktop.ts once the desktop bundle and the JS external reader
 * resources were built for this vitest run.
 */
export const DESKTOP_PREBUILT_ENV = 'LINEJS_TEST_DESKTOP_PREBUILT';

/**
 * Builds a desktop script for a test file unless the run already built it once.
 *
 * Vitest runs test files in parallel and every one of them used to rebuild the same dist/ tree. The reader bridge
 * executable is spawned by sibling test files while that happens, so a late rebuild failed csc ("file in use") or
 * replaced the manifest under a running test (reader_resource_integrity_failed). The run now builds once in the
 * global setup and files only fall back to building when they run outside that setup.
 */
export function buildDesktopScript(desktopRoot: string, script: 'build.mjs' | 'build-js-external-reader.mjs',
  stdio: 'inherit' | Array<'ignore' | 'inherit'> = 'inherit'): void {
  if (process.env[DESKTOP_PREBUILT_ENV] === '1') return;
  execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', script)], { stdio });
}
