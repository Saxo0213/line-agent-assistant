import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAgentUpgradeNotice } from './agent-upgrade-notice.js';

describe('prepareAgentUpgradeNotice', () => {
  let root: string;
  let file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'agent-upgrade-')); file = path.join(root, 'agent', 'upgrade-notice.json'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('lists the sessions for a missing file, writes the state, and gives each id once', async () => {
    const list = vi.fn(async () => ['a', 'b']);
    const notice = await prepareAgentUpgradeNotice({ file, version: '1.0.2', listSessionIds: list });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: '1.0.2', pending: ['a', 'b'] });
    expect(notice.take('a')).toBe(true);
    expect(notice.take('a')).toBe(false);
    expect(notice.take('unknown')).toBe(false);
    await settle();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: '1.0.2', pending: ['b'] });
  });

  it('keeps the pending list for the same version and lists again for another version or bad JSON', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: '1.0.2', pending: ['kept'] }));
    const list = vi.fn(async () => ['fresh']);
    const same = await prepareAgentUpgradeNotice({ file, version: '1.0.2', listSessionIds: list });
    expect(list).not.toHaveBeenCalled();
    expect(same.take('kept')).toBe(true);
    await settle();
    const other = await prepareAgentUpgradeNotice({ file, version: '1.0.3', listSessionIds: list });
    expect(other.take('fresh')).toBe(true);
    await settle();
    await writeFile(file, '{bad');
    const bad = await prepareAgentUpgradeNotice({ file, version: '1.0.3', listSessionIds: list });
    expect(bad.take('fresh')).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reports errors, uses an empty list, and never throws', async () => {
    const onError = vi.fn();
    const failure = new Error('db down');
    const notice = await prepareAgentUpgradeNotice({ file, version: '1.0.2', listSessionIds: async () => { throw failure; }, onError });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(notice.take('a')).toBe(false);
    // A write failure still gives true.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: '1.0.2', pending: ['x'] }));
    const blocked = await prepareAgentUpgradeNotice({ file, version: '1.0.2', listSessionIds: async () => [], onError });
    await rm(file, { force: true });
    await mkdir(file);
    expect(blocked.take('x')).toBe(true);
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
