import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The schema-names developer tool reader runs only against a synthetic encrypted fixture under a private temp
// directory. Nothing here touches an installed LINE, %LOCALAPPDATA%, or any PostgreSQL.
const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let root = '';

describe('official schema names tool', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'linejs-schema-names-'));
    execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-js-external-reader-fixtures.mjs'), root], { encoding: 'utf8', windowsHide: true });
    await mkdir(path.join(root, 'schema-names'), { recursive: true });
  }, 240_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('lists fixture tables, columns, declared types, pk flags and indexes; never a cell value; denies user-table reads, count() and the sql column', () => {
    const output = execFileSync(path.join(root, 'OfficialSchemaNamesToolHarness.exe'), ['schema-names', path.join(root, 'schema-names')], { encoding: 'utf8', windowsHide: true });
    expect(output.trim().split(/\r?\n/).pop()).toBe('PASS|schema-names');
  }, 120_000);
});
