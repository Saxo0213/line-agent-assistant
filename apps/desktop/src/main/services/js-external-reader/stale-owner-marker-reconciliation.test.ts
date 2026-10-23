import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileStaleOwnerMarkers, type ProcessLiveness } from './stale-owner-marker-reconciliation.js';

const mainPid = 34101;
const childPid = 34102;
const mainStartedAt = '134000000000000001';
const childStartedAt = '134000000000000002';
const mainHash = 'a'.repeat(64);
const bridgeHash = 'b'.repeat(64);
let roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

describe('stale JS import owner marker reconciliation', () => {
  it('provisions a missing private root and removes an owned marker only when both process identities are gone', async () => {
    const { parent, root } = await paths();
    const id = 'a'.repeat(32);
    await mkdir(root);
    await putMarker(root, id, ownedMarker(id));
    const queries: number[] = [];
    await reconcile({ root, now: 200, query: async (pid) => { queries.push(pid); return { kind: 'absent' }; } });
    expect(queries).toEqual([mainPid, childPid]);
    await expect(readdir(path.join(root, `probe-${id}`))).rejects.toThrow();
    expect(await readdir(parent)).toContain(path.basename(root));
  });

  it.each([
    ['same PID and creation time', (pid: number): ProcessLiveness => ({ kind: 'present', startedAt: pid === mainPid ? mainStartedAt : childStartedAt })],
    ['unknown query', (_pid: number): ProcessLiveness => ({ kind: 'unknown' })],
  ])('keeps the entry and fails closed for %s', async (_label, query) => {
    const { root } = await paths();
    const id = 'b'.repeat(32);
    await mkdir(root);
    await putMarker(root, id, ownedMarker(id));
    await expect(reconcile({ root, query })).rejects.toThrow();
    expect(await readdir(path.join(root, `probe-${id}`))).toEqual(['owner.json']);
  });

  it('treats a replaced PID as dead and recovers an empty directory left after marker unlink', async () => {
    const { root } = await paths();
    const id = 'c'.repeat(32);
    await mkdir(root);
    await putMarker(root, id, ownedMarker(id));
    await mkdir(path.join(root, `probe-${'d'.repeat(32)}`));
    await reconcile({ root, query: async (pid) => ({ kind: 'present', startedAt: pid === mainPid ? '134000000000000099' : '134000000000000098' }) });
    expect(await readdir(root)).toEqual([]);
  });

  it('requires an expired provisional deadline and does not remove its marker early', async () => {
    const { root } = await paths();
    const id = 'e'.repeat(32);
    await mkdir(root);
    await putMarker(root, id, { version: 1, phase: 'provisional', requestId: id, mainPid, mainStartedAt,
      mainImageSha256: mainHash, bridgeImageSha256: bridgeHash, deadlineUnixMs: 300 });
    await expect(reconcile({ root, now: 200, query: async () => ({ kind: 'absent' }) })).rejects.toThrow('reader_stale_provisional_not_expired');
    expect(await readdir(path.join(root, `probe-${id}`))).toEqual(['owner.json']);
  });

  it('fails closed on malformed markers, unexpected children, and inventories above eight entries', async () => {
    const { root } = await paths();
    await mkdir(root);
    const malformed = 'f'.repeat(32);
    await mkdir(path.join(root, `probe-${malformed}`));
    await writeFile(path.join(root, `probe-${malformed}`, 'owner.json'), '{');
    await expect(reconcile({ root, query: async () => ({ kind: 'absent' }) })).rejects.toThrow('reader_stale_marker_invalid');
    await rm(path.join(root, `probe-${malformed}`), { recursive: true, force: true });
    const extra = '1'.repeat(32);
    await mkdir(path.join(root, `probe-${extra}`));
    await writeFile(path.join(root, `probe-${extra}`, 'snapshot.db'), 'must remain untouched');
    await expect(reconcile({ root, query: async () => ({ kind: 'absent' }) })).rejects.toThrow('reader_stale_entry_unknown');
    expect(await readFile(path.join(root, `probe-${extra}`, 'snapshot.db'), 'utf8')).toBe('must remain untouched');
    await rm(path.join(root, `probe-${extra}`), { recursive: true, force: true });
    for (let index = 0; index < 9; index += 1) await mkdir(path.join(root, `probe-${index.toString(16).padStart(32, '0')}`));
    await expect(reconcile({ root, query: async () => ({ kind: 'absent' }) })).rejects.toThrow('reader_stale_inventory_limit');
  });

  it('rechecks marker identity after liveness query before unlinking', async () => {
    const { root } = await paths();
    const id = '2'.repeat(32);
    const markerPath = await putMarker(root, id, ownedMarker(id));
    let queryCount = 0;
    await expect(reconcile({ root, query: async () => {
      queryCount += 1;
      if (queryCount === 1) await writeFile(markerPath, JSON.stringify({ ...ownedMarker(id), childImagePath: 'C:\\changed.exe' }));
      return { kind: 'absent' };
    } })).rejects.toThrow('reader_stale_marker_changed');
    expect(await readdir(path.join(root, `probe-${id}`))).toEqual(['owner.json']);
  });
});

async function paths(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'linejs-stale-marker-'));
  roots.push(parent);
  return { parent, root: path.join(parent, 'new-request-root') };
}

async function putMarker(root: string, requestId: string, marker: object): Promise<string> {
  const directory = path.join(root, `probe-${requestId}`);
  await mkdir(directory, { recursive: true });
  const markerPath = path.join(directory, 'owner.json');
  await writeFile(markerPath, JSON.stringify(marker));
  return markerPath;
}

function ownedMarker(requestId: string) {
  return { version: 1, phase: 'owned', requestId, mainPid, mainStartedAt, mainImageSha256: mainHash,
    bridgeImageSha256: bridgeHash, deadlineUnixMs: 100, childPid, childStartedAt, childImagePath: 'C:\\reader.exe' };
}

async function reconcile(input: { root: string; query: (pid: number) => Promise<ProcessLiveness> | ProcessLiveness; now?: number }) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  await reconcileStaleOwnerMarkers({ requestRoot: input.root, deadlineUnixMs: Date.now() + 10_000, signal: controller.signal,
    ensurePrivateRoot: async () => { await mkdir(input.root, { recursive: true }); },
    queryProcess: async (pid) => input.query(pid),
    trackSettlement(work) { pending.add(work); void work.finally(() => pending.delete(work)); },
    ...(input.now === undefined ? {} : { now: () => input.now! }),
  });
  expect(pending.size).toBe(0);
}
