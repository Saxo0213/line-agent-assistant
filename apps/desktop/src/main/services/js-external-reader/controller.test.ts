import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { JsExternalReaderController } from './controller.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { FileOwnerReadyMarkerStore, type OwnerProcessIdentity } from './owner-ready-session.js';
import { verifyJsExternalReaderResources } from './resources.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const bridgePath = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'ExternalReaderBridge.exe');

describe('JS external reader no-EDB bridge handshake', () => {
  beforeAll(() => {
    buildDesktopScript(desktopRoot, 'build.mjs');
  });

  it('negotiates a bounded fixture inventory without touching a LINE source', async () => {
    const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
    const result = await controller.openNoEdbFixture({
      bridgePath,
      requestId: '0123456789abcdef0123456789abcdef',
      expectedMid: 'fixture-own-mid',
      deadlineUnixMs: Date.now() + 5_000,
    });
    expect(result).toEqual({ candidateCount: 0, processCount: 0, edbMiB: [], walMiB: [] });
  });

  it('drains a bounded sequential burst and releases admission after every bridge exits', async () => {
    const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
    for (let index = 0; index < 8; index += 1) {
      const result = await controller.openNoEdbFixture({
        bridgePath,
        requestId: index.toString(16).padStart(32, '0'),
        expectedMid: 'fixture-own-mid',
        deadlineUnixMs: Date.now() + 5_000,
      });
      expect(result.processCount).toBe(0);
    }
  });

  it('waits for a committed-page callback before ACK and asking for another direct page', async () => {
    const resources = await verifyJsExternalReaderResources(path.dirname(bridgePath));
    const requestRoot = await mkdtemp(path.join(os.tmpdir(), 'js-direct-controller-'));
    const requestId = randomUUID().replaceAll('-', '');
    const mainIdentity: OwnerProcessIdentity = { pid: process.pid,
      startedAt: '134000000000000044', imagePath: process.execPath, imageSha256: 'a'.repeat(64) };
    const sourceIdentityDigest = 'b'.repeat(64);
    const script = `
      let input = Buffer.alloc(0), outputSequence = 0;
      const requestId = ${JSON.stringify(requestId)};
      const emit = (type, fields = {}) => { const body=Buffer.from(JSON.stringify({version:1,requestId,sequence:++outputSequence,type,...fields})); const header=Buffer.alloc(4); header.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([header,body])); };
      const decode = () => { while(input.length>=4){const length=input.readUInt32BE(0);if(input.length<4+length)return;const frame=JSON.parse(input.subarray(4,4+length).toString());input=input.subarray(4+length);if(frame.type==='owner_ready')emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[0],sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)}});else if(frame.type==='verify')emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)},schemaVersion:'line-profile-mid-v1'});else if(frame.type==='directory_next')emit('directory_page',{pageNumber:frame.pageNumber,batchDigest:'${'d'.repeat(64)}',rows:[],hasMore:false});else if(frame.type==='auth_candidates')process.stderr.write('AUTH_REQUESTED\\n');else if(frame.type==='poll')emit('page',{pageNumber:frame.pageNumber,batchDigest:'${'c'.repeat(64)}',rows:[],tailRows:[],lastCursor:frame.cursor,hasMore:false});else if(frame.type==='ack'){process.stderr.write('ACK\\n');}else if(frame.type==='close'){emit('closed',{sourceAccessed:true});process.stdin.end();}}};
      process.stdout.on('error',()=>{}); process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);decode();});process.stdin.on('end',()=>process.exit(0));
      emit('hello',{bridgeVersion:'candidate-reader-0.2.0',capability:'fixed_readonly_verify'});
    `;
    let child: ChildProcess | undefined;
    let bridgeIdentity: OwnerProcessIdentity | undefined;
    let stderr = '';
    const launch = ((_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      child = spawn(process.execPath, ['-e', script], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      bridgeIdentity = { pid: child.pid!, startedAt: '134000000000000077', imagePath: resources.bridgePath,
        imageSha256: resources.bridgeSha256 };
      return child;
    }) as unknown as typeof spawn;
    const admission = new ExternalSourceProbeAdmissionGate();
    const controller = new JsExternalReaderController(admission, launch);
    const abort = new AbortController();
    let releaseFirst!: () => void;
    let sawFirst!: () => void;
    let sawSecond!: () => void;
    const first = new Promise<void>((resolve) => { sawFirst = resolve; });
    const second = new Promise<void>((resolve) => { sawSecond = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    let authCandidateCount = 0;
    const realNow = Date.now.bind(Date);
    let clockOffset = 0;
    const acceleratedClock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    const pending = controller.readOfficialMonitor({
      bridgePath, requestRoot, requestId, expectedMid: 'fixture-mid', sourceIdentityDigest,
      cursor: null, deadlineUnixMs: Date.now() + 30_000, mainIdentity,
      markerStore: new FileOwnerReadyMarkerStore(requestRoot, requestId, async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }),
      inspectProcess: async (pid) => pid === bridgeIdentity?.pid ? bridgeIdentity : null,
      onProgress() {},
      async onReady(access) { authCandidateCount = (await access.acquireAuthCandidates()).candidates.length; },
      async onPage() {
        calls++;
        expect(authCandidateCount).toBe(0);
        if (calls === 1) { sawFirst(); await gate; return null; }
        sawSecond(); abort.abort(); return null;
      },
      signal: abort.signal, pollIntervalMs: 1_000,
    });
    try {
      await first;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(1);
      expect(stderr).not.toContain('ACK');
      expect(stderr).not.toContain('AUTH_REQUESTED');
      clockOffset = 60 * 60 * 1_000;
      releaseFirst();
      const outcome = await Promise.race([second.then(() => 'second-page'), pending.then(() => 'resolved', () => 'rejected')]);
      expect(outcome).toBe('second-page');
      expect(stderr).toContain('ACK');
      await expect(pending).rejects.toThrow();
      expect(admission.isBusy()).toBe(false);
      expect(child?.exitCode).toBe(0);
    } finally {
      abort.abort();
      releaseFirst();
      acceleratedClock.mockRestore();
      child?.kill();
      await rm(requestRoot, { recursive: true, force: true });
    }
  }, 30_000);

  async function readOnePage(extra: Record<string, unknown>, field: 'tailWindow' | 'unreadCounts' = 'tailWindow'): Promise<unknown> {
    const resources = await verifyJsExternalReaderResources(path.dirname(bridgePath));
    const requestRoot = await mkdtemp(path.join(os.tmpdir(), 'js-direct-tail-window-'));
    const requestId = randomUUID().replaceAll('-', '');
    const mainIdentity: OwnerProcessIdentity = { pid: process.pid,
      startedAt: '134000000000000044', imagePath: process.execPath, imageSha256: 'a'.repeat(64) };
    const sourceIdentityDigest = 'b'.repeat(64);
    const script = `
      let input = Buffer.alloc(0), outputSequence = 0;
      const requestId = ${JSON.stringify(requestId)};
      const emit = (type, fields = {}) => { const body=Buffer.from(JSON.stringify({version:1,requestId,sequence:++outputSequence,type,...fields})); const header=Buffer.alloc(4); header.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([header,body])); };
      const decode = () => { while(input.length>=4){const length=input.readUInt32BE(0);if(input.length<4+length)return;const frame=JSON.parse(input.subarray(4,4+length).toString());input=input.subarray(4+length);if(frame.type==='owner_ready')emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[0],sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)}});else if(frame.type==='verify')emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)},schemaVersion:'line-profile-mid-v1'});else if(frame.type==='directory_next')emit('directory_page',{pageNumber:frame.pageNumber,batchDigest:'${'d'.repeat(64)}',rows:[],hasMore:false});else if(frame.type==='auth_candidates')process.stderr.write('AUTH_REQUESTED\\n');else if(frame.type==='poll')emit('page',{pageNumber:frame.pageNumber,batchDigest:'${'c'.repeat(64)}',rows:[],tailRows:[],lastCursor:frame.cursor,hasMore:false,...${JSON.stringify(extra)}});else if(frame.type==='ack'){process.stderr.write('ACK\\n');}else if(frame.type==='close'){emit('closed',{sourceAccessed:true});process.stdin.end();}}};
      process.stdout.on('error',()=>{}); process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);decode();});process.stdin.on('end',()=>process.exit(0));
      emit('hello',{bridgeVersion:'candidate-reader-0.2.0',capability:'fixed_readonly_verify'});
    `;
    let child: ChildProcess | undefined;
    let bridgeIdentity: OwnerProcessIdentity | undefined;
    const launch = ((_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      child = spawn(process.execPath, ['-e', script], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      bridgeIdentity = { pid: child.pid!, startedAt: '134000000000000077', imagePath: resources.bridgePath,
        imageSha256: resources.bridgeSha256 };
      return child;
    }) as unknown as typeof spawn;
    const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate(), launch);
    const abort = new AbortController();
    let received: unknown = 'none';
    try {
      await controller.readOfficialMonitor({
        bridgePath, requestRoot, requestId, expectedMid: 'fixture-mid', sourceIdentityDigest,
        cursor: null, deadlineUnixMs: Date.now() + 30_000, mainIdentity,
        markerStore: new FileOwnerReadyMarkerStore(requestRoot, requestId, async (directory) => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }),
        inspectProcess: async (pid) => pid === bridgeIdentity?.pid ? bridgeIdentity : null,
        onProgress() {},
        async onReady() {},
        async onPage(page) { received = page[field] ?? 'absent'; abort.abort(); return null; },
        signal: abort.signal, pollIntervalMs: 1_000,
      }).catch((error: unknown) => { if (received === 'none') throw error; });
      return received;
    } finally {
      abort.abort();
      child?.kill();
      await rm(requestRoot, { recursive: true, force: true });
    }
  }

  it('passes valid unread counts to the page consumer and rejects malformed ones', async () => {
    const valid = { entries: [['chat-a', 3], ['chat-b', 1_000_000]] };
    await expect(readOnePage({ unreadCounts: valid }, 'unreadCounts')).resolves.toEqual(valid);
    await expect(readOnePage({}, 'unreadCounts')).resolves.toBe('absent');
    for (const bad of [
      { entries: [['a', 1], ['a', 2]] },
      { entries: [['a', 0]] },
      { entries: [['a', 1_000_001]] },
      { entries: [['a', 1.5]] },
      { entries: [['a', '1']] },
      { entries: [['', 1]] },
      { entries: [['x'.repeat(513), 1]] },
      { entries: [['a', 1, 2]] },
      { entries: [], extra: 1 },
      { entries: 'a' },
      'unread',
    ]) {
      await expect(readOnePage({ unreadCounts: bad }, 'unreadCounts')).rejects.toThrow('reader_page_invalid');
    }
  }, 120_000);

  it('passes a strictly valid tail window to the page consumer and rejects malformed ones', async () => {
    const ids = ['a', 'b'];
    const valid = { upper: { createdTime: '1000', id: 'b' }, lower: null, complete: true, ids };
    await expect(readOnePage({})).resolves.toBe('absent');
    await expect(readOnePage({ tailWindow: valid })).resolves.toEqual(valid);
    await expect(readOnePage({ tailWindow: { ...valid, lower: { createdTime: '900', id: 'a' } } }))
      .resolves.toMatchObject({ lower: { createdTime: '900', id: 'a' } });
    for (const bad of [
      { ...valid, complete: false },
      { ...valid, extra: 1 },
      { ...valid, ids: ['a', 'a'] },
      { ...valid, ids: ['a', ''] },
      { ...valid, ids: ['a', 'x'.repeat(513)] },
      { ...valid, ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) },
      { ...valid, upper: { createdTime: 'abc', id: 'b' } },
      { ...valid, upper: { createdTime: '1000', id: '' } },
      { ...valid, lower: { createdTime: '-5', id: 'a' } },
      { ...valid, lower: 'a' },
      { upper: valid.upper, complete: true, ids },
      'tail',
    ]) {
      await expect(readOnePage({ tailWindow: bad })).rejects.toThrow('reader_page_invalid');
    }
    await expect(readOnePage({ tailWindow: { ...valid, ids: Array.from({ length: 50 }, (_, index) => `id-${index}`) } }))
      .resolves.toMatchObject({ complete: true });
  }, 120_000);

});
