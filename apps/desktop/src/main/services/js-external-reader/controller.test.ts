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
import type { NativeMonitorAccess } from './protocol.js';
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
      const decode = () => { while(input.length>=4){const length=input.readUInt32BE(0);if(input.length<4+length)return;const frame=JSON.parse(input.subarray(4,4+length).toString());input=input.subarray(4+length);if(frame.type==='owner_ready')emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[0],sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)}});else if(frame.type==='verify')emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)},schemaVersion:'line-profile-mid-v1'});else if(frame.type==='directory_next')emit('directory_page',{pageNumber:frame.pageNumber,batchDigest:'${'d'.repeat(64)}',rows:[],hasMore:false});else if(frame.type==='auth_candidates')process.stderr.write('AUTH_REQUESTED\\n');else if(frame.type==='poll')emit('page',{pageNumber:frame.pageNumber,batchDigest:'${'c'.repeat(64)}',rows:[],tailRows:[],lastCursor:frame.cursor,hasMore:false});else if(frame.type==='ack'){process.stderr.write('ACK\\n');}else if(frame.type==='wait_change')emit('change',{changed:true});else if(frame.type==='close'){emit('closed',{sourceAccessed:true});process.stdin.end();}}};
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

  // A fake bridge for the idle wait. It records every control frame on stderr and answers wait_change as the
  // scenario says: 'true' and 'false' answer at once, 'wake' answers only after a wake frame, 'hang' never answers.
  function idleBridgeScript(requestId: string, sourceIdentityDigest: string, scenario: string[]): string {
    return `
      let input = Buffer.alloc(0), outputSequence = 0, waits = 0;
      const requestId = ${JSON.stringify(requestId)}, scenario = ${JSON.stringify(scenario)};
      const digest = (c) => c.repeat(64);
      const emit = (type, fields = {}) => { const body=Buffer.from(JSON.stringify({version:1,requestId,sequence:++outputSequence,type,...fields})); const header=Buffer.alloc(4); header.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([header,body])); };
      const decode = () => { while(input.length>=4){const length=input.readUInt32BE(0);if(input.length<4+length)return;const frame=JSON.parse(input.subarray(4,4+length).toString());input=input.subarray(4+length);
        if(['poll','ack','wait_change','wake','attachment_metadata'].includes(frame.type))process.stderr.write('FRAME:'+JSON.stringify(frame)+'\\n');
        if(frame.type==='owner_ready')emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[0],sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)}});
        else if(frame.type==='verify')emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)},schemaVersion:'line-profile-mid-v1'});
        else if(frame.type==='directory_next')emit('directory_page',{pageNumber:frame.pageNumber,batchDigest:digest('d'),rows:[],hasMore:false});
        else if(frame.type==='poll')emit('page',{pageNumber:frame.pageNumber,batchDigest:digest('c'),rows:[],tailRows:[],lastCursor:frame.cursor,hasMore:false});
        else if(frame.type==='wait_change'){const mode=scenario[waits++]??'hang';if(mode==='true')emit('change',{changed:true});else if(mode==='false')emit('change',{changed:false});else process.stderr.write('WAITING:'+mode+'\\n');}
        else if(frame.type==='wake')emit('change',{changed:false});
        else if(frame.type==='attachment_metadata')emit('attachment_metadata',{metadata:null,errorCode:'fixture_none'});
        else if(frame.type==='close'){emit('closed',{sourceAccessed:true});process.stdin.end();}}};
      process.stdout.on('error',()=>{}); process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);decode();});process.stdin.on('end',()=>process.exit(0));
      emit('hello',{bridgeVersion:'candidate-reader-0.2.0',capability:'fixed_readonly_verify'});
    `;
  }

  async function runIdleScenario(scenario: string[], options: {
    stopAfterWaitingCount: number; onWaiting?(decode: () => Promise<unknown>): void;
  }): Promise<{ frames: Array<Record<string, unknown>>; elapsedMs: number; pages: number; decoded: unknown[] }> {
    const resources = await verifyJsExternalReaderResources(path.dirname(bridgePath));
    const requestRoot = await mkdtemp(path.join(os.tmpdir(), 'js-direct-idle-wait-'));
    const requestId = randomUUID().replaceAll('-', '');
    const mainIdentity: OwnerProcessIdentity = { pid: process.pid,
      startedAt: '134000000000000044', imagePath: process.execPath, imageSha256: 'a'.repeat(64) };
    const sourceIdentityDigest = 'b'.repeat(64);
    let child: ChildProcess | undefined;
    let bridgeIdentity: OwnerProcessIdentity | undefined;
    let stderr = '';
    const abort = new AbortController();
    let waitingCount = 0;
    let readyAccess: NativeMonitorAccess | undefined;
    const decoded: unknown[] = [];
    const decode = async () => {
      const value = await readyAccess!.decodeAttachment({ envelope: { format: 1, table: '_message',
        sourceDigest: 'd'.repeat(64), encoding: 'dpapi', data: 'AQID' }, expectedMessageId: 'm1', expectedChatId: 'chat' } as never);
      decoded.push(value);
      return value;
    };
    const launch = ((_command: string, _args: readonly string[], spawnOptions: Parameters<typeof spawn>[2]) => {
      child = spawn(process.execPath, ['-e', idleBridgeScript(requestId, sourceIdentityDigest, scenario)], { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        for (const line of chunk.toString().split('\n')) {
          if (!line.startsWith('WAITING:')) continue;
          waitingCount += 1;
          options.onWaiting?.(decode);
          if (waitingCount >= options.stopAfterWaitingCount) abort.abort();
        }
      });
      bridgeIdentity = { pid: child.pid!, startedAt: '134000000000000077', imagePath: resources.bridgePath, imageSha256: resources.bridgeSha256 };
      return child;
    }) as unknown as typeof spawn;
    const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate(), launch);
    let pages = 0;
    const started = Date.now();
    try {
      await expect(controller.readOfficialMonitor({
        bridgePath, requestRoot, requestId, expectedMid: 'fixture-mid', sourceIdentityDigest,
        cursor: null, deadlineUnixMs: Date.now() + 60_000, mainIdentity,
        markerStore: new FileOwnerReadyMarkerStore(requestRoot, requestId, async (directory) => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }),
        inspectProcess: async (pid) => pid === bridgeIdentity?.pid ? bridgeIdentity : null,
        onProgress() {},
        async onReady(access) { readyAccess = access; },
        async onPage() { pages += 1; return null; },
        signal: abort.signal,
        // The old idle delay: a large value proves that the idle path does not use it.
        pollIntervalMs: 60_000,
      })).rejects.toThrow();
      const elapsedMs = Date.now() - started;
      const frames = stderr.split('\n').filter((line) => line.startsWith('FRAME:'))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      return { frames, elapsedMs, pages, decoded };
    } finally {
      abort.abort();
      child?.kill();
      await rm(requestRoot, { recursive: true, force: true });
    }
  }

  it('waits for a change after an idle page, and polls again after change true or false', async () => {
    const result = await runIdleScenario(['true', 'false', 'hang'], { stopAfterWaitingCount: 1 });
    expect(result.frames.map((frame) => frame.type)).toEqual(
      ['poll', 'ack', 'wait_change', 'poll', 'ack', 'wait_change', 'poll', 'ack', 'wait_change']);
    for (const frame of result.frames.filter((item) => item.type === 'wait_change')) expect(frame.timeoutMs).toBe(30_000);
    expect(result.pages).toBe(3);
    // An idle delay of 5000 ms (or the 60000 ms pollIntervalMs) would show here.
    expect(result.elapsedMs).toBeLessThan(5_000);
  }, 30_000);

  it('stops the session when the abort signal fires during the wait', async () => {
    const result = await runIdleScenario(['hang'], { stopAfterWaitingCount: 1 });
    expect(result.frames.map((frame) => frame.type)).toEqual(['poll', 'ack', 'wait_change']);
    expect(result.pages).toBe(1);
  }, 30_000);

  it('sends a wake frame when auxiliary work arrives during the wait', async () => {
    let started = false;
    const result = await runIdleScenario(['wake', 'hang'], { stopAfterWaitingCount: 2,
      onWaiting(decode) { if (!started) { started = true; void decode(); } } });
    expect(result.frames.map((frame) => frame.type)).toEqual(
      ['poll', 'ack', 'wait_change', 'wake', 'attachment_metadata', 'poll', 'ack', 'wait_change']);
    expect(result.decoded).toEqual([{ metadata: null, errorCode: 'fixture_none' }]);
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
      const decode = () => { while(input.length>=4){const length=input.readUInt32BE(0);if(input.length<4+length)return;const frame=JSON.parse(input.subarray(4,4+length).toString());input=input.subarray(4+length);if(frame.type==='owner_ready')emit('inventory',{buildCode:'accepted',buildVersion:'26.4.2.3957',buildBytes:30634432,buildSha256:'893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',candidateCount:1,processCount:1,edbMiB:[1],walMiB:[0],sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)}});else if(frame.type==='verify')emit('ready',{sourceArchiveFormat:1,sourceIdentityDigest:${JSON.stringify(sourceIdentityDigest)},schemaVersion:'line-profile-mid-v1'});else if(frame.type==='directory_next')emit('directory_page',{pageNumber:frame.pageNumber,batchDigest:'${'d'.repeat(64)}',rows:[],hasMore:false});else if(frame.type==='auth_candidates')process.stderr.write('AUTH_REQUESTED\\n');else if(frame.type==='poll')emit('page',{pageNumber:frame.pageNumber,batchDigest:'${'c'.repeat(64)}',rows:[],tailRows:[],lastCursor:frame.cursor,hasMore:false,...${JSON.stringify(extra)}});else if(frame.type==='ack'){process.stderr.write('ACK\\n');}else if(frame.type==='wait_change')emit('change',{changed:true});else if(frame.type==='close'){emit('closed',{sourceAccessed:true});process.stdin.end();}}};
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
