import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Track A (docs/architecture/official-db-retained-capture-and-content-bridge.md): every scenario runs the
// native OfficialSnapshotToolHarness against synthetic encrypted fixtures under a private temp directory. Nothing
// here touches an installed LINE, its process memory, %LOCALAPPDATA%, or any PostgreSQL.
const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let root = '';
let harness = '';

function scenario(name: string): string {
  const directory = path.join(root, name);
  return execFileSync(harness, [name, directory], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/).pop() ?? '';
}

describe('official snapshot tool (Track A)', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'linejs-official-snapshot-'));
    execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-js-external-reader-fixtures.mjs'), root], { encoding: 'utf8', windowsHide: true });
    harness = path.join(root, 'OfficialSnapshotToolHarness.exe');
    for (const name of ['capture', 'capture-failure', 'candidate-build', 'capture-sides', 'capture-side-failures', 'analyze', 'analyze-failures', 'redaction', 'lock', 'sandbox', 'correlate', 'correlate-caps']) {
      await mkdir(path.join(root, name), { recursive: true });
    }
  }, 240_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('A1: captures to a retained directory, DPAPI round-trips the key, opens the snapshot, writes the manifest last, hides the MID, and lists the capture', () => {
    expect(scenario('capture')).toBe('PASS|capture');
  }, 120_000);
  it('A1: failures at every stage remove only the run\'s own directory and files', () => {
    expect(scenario('capture-failure')).toBe('PASS|capture-failure');
    expect(scenario('candidate-build')).toBe('PASS|candidate-build');
  }, 120_000);
  it('A2/A3/A9: analyze needs only key.dpapi, reports aggregates with correct table coverage and side reports, and leaks no sentinel text, IDs, MIDs, names, file names or keys', () => {
    expect(scenario('analyze')).toBe('PASS|analyze');
  }, 120_000);
  it('A2: a hash mismatch, a wrong key and a malformed key fail closed without output or a lingering sandbox', () => {
    expect(scenario('analyze-failures')).toBe('PASS|analyze-failures');
  }, 120_000);
  it('A4: MID-like, overlong and odd-character JSON keys are redacted, including one nested level', () => {
    expect(scenario('redaction')).toBe('PASS|redaction');
  }, 120_000);
  it('A5: a held lock file stops a concurrent run', () => {
    expect(scenario('lock')).toBe('PASS|lock');
  }, 120_000);
  it('A7: side files use the main key, their own DPAPI-protected key, or are recorded key_not_found while the main capture succeeds', () => {
    expect(scenario('capture-sides')).toBe('PASS|capture-sides');
  }, 120_000);
  it('A8: side verify failures and the total capture limit are recorded, partial files are removed, and the manifest stays last', () => {
    expect(scenario('capture-side-failures')).toBe('PASS|capture-side-failures');
  }, 120_000);
  it('A11: analysis runs on a sandbox copy; retained files stay byte- and mtime-identical; sandboxes are removed on success and failure; stale sandboxes are cleaned only under the lock', () => {
    expect(scenario('sandbox')).toBe('PASS|sandbox');
  }, 120_000);
  it('A12/A13: correlate identifies the JSON, Thrift compact, Thrift binary and protobuf encodings by field path and emits counts only', () => {
    expect(scenario('correlate')).toBe('PASS|correlate');
  }, 120_000);
  it('A15: exceeding the stdin line or total caps gives a fixed error, no output file and no sandbox', () => {
    expect(scenario('correlate-caps')).toBe('PASS|correlate-caps');
  }, 240_000);
});
