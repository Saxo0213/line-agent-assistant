import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeRetiredProbeOutput } from './build-retired-output.mjs';

test('removes only the retired generated Python probe from existing build output', async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'line-build-retired-probe-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const scriptsRoot = path.join(outputRoot, 'scripts');
  await mkdir(scriptsRoot);
  const helper = path.join(scriptsRoot, 'external-monitor-probe.py');
  const unrelated = path.join(scriptsRoot, 'keep.js');
  await writeFile(helper, 'obsolete');
  await writeFile(unrelated, 'keep');

  await removeRetiredProbeOutput(scriptsRoot);

  await assert.rejects(stat(helper), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});
