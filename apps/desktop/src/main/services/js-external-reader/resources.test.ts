import { spawn } from 'node:child_process';
import { mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyJsExternalReaderResources } from './resources.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';
import { encodeFrame, FrameDecoder, FRAME_LIMITS, type ProtocolFrame } from './protocol.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const resourceRoot = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1');
let tamperedRoot = '';

describe('JS external reader candidate resources', () => {
  beforeAll(() => {
    buildDesktopScript(desktopRoot, 'build.mjs');
  });

  afterAll(async () => { if (tamperedRoot) await rm(tamperedRoot, { recursive: true, force: true }); });

  it('accepts the release-owned x64 resource tree and rejects a changed bridge binary', async () => {
    const verified = await verifyJsExternalReaderResources(resourceRoot);
    expect(path.basename(verified.bridgePath)).toBe('ExternalReaderBridge.exe');
    expect(path.basename(verified.controllerPath)).toBe('controller.mjs');
    tamperedRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-resources-'));
    for (const name of ['ExternalReaderBridge.exe', 'sqlite3mc_x64.dll', 'controller.mjs', 'manifest.json']) {
      await copyFile(path.join(resourceRoot, name), path.join(tamperedRoot, name));
    }
    const bridge = await readFile(path.join(tamperedRoot, 'ExternalReaderBridge.exe'));
    await writeFile(path.join(tamperedRoot, 'ExternalReaderBridge.exe'), Buffer.concat([bridge, Buffer.from([0]) ]));
    await expect(verifyJsExternalReaderResources(tamperedRoot)).rejects.toThrow('reader_resource_integrity_failed');
  });

  it('packaged production bridge rejects source verification before discovery', async () => {
    const requestId = '9'.repeat(32);
    const child = spawn(path.join(resourceRoot, 'ExternalReaderBridge.exe'), ['--request-id', requestId], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    const timer = setTimeout(() => child.kill(), 3_000);
    try {
      child.stdin.write(encodeFrame({ version: 1, requestId, sequence: 1, type: 'init', operation: 'verify_local_source',
        expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 20_000 }, FRAME_LIMITS.controlBytes));
      child.stdin.end();
      await closed;
      expect(child.exitCode).toBe(4);
      const output = Buffer.concat(chunks);
      const frames: unknown[] = [];
      for (let offset = 0; offset + 4 <= output.byteLength;) {
        const frameBytes = output.readUInt32BE(offset);
        offset += 4;
        expect(offset + frameBytes).toBeLessThanOrEqual(output.byteLength);
        frames.push(JSON.parse(output.subarray(offset, offset + frameBytes).toString('utf8')));
        offset += frameBytes;
      }
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ version: 1, requestId, sequence: 1, type: 'hello' });
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it('exits on EOF before init without source inventory', async () => {
    const requestId = '8'.repeat(32);
    const child = spawn(path.join(resourceRoot, 'ExternalReaderBridge.exe'), ['--request-id', requestId], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
    const frames: ProtocolFrame[] = [];
    const waiters: Array<() => void> = [];
    child.stdout.on('data', (chunk: Buffer) => {
      frames.push(...decoder.push(chunk));
      while (waiters.length && frames.length > 0) waiters.shift()!();
    });
    const waitForFrameCount = async (count: number, timeoutMs = 3_000) => {
      const until = Date.now() + timeoutMs;
      while (frames.length < count && Date.now() < until) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { const index = waiters.indexOf(onFrame); if (index >= 0) waiters.splice(index, 1); reject(new Error('bridge_frame_timeout')); }, until - Date.now());
          const onFrame = () => { clearTimeout(timer); resolve(); };
          waiters.push(onFrame);
        });
      }
      if (frames.length < count) throw new Error('bridge_frame_timeout');
    };
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 3_000);
    try {
      await waitForFrameCount(1);
      child.stdin.end();
      await closed;
      expect(child.exitCode).toBe(4);
      expect(frames.map((frame) => frame.type)).toEqual(['hello']);
    } finally {
      clearTimeout(killTimer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it('exits without source work when EOF arrives before owner-ready', async () => {
    const requestId = '7'.repeat(32);
    const child = spawn(path.join(resourceRoot, 'ExternalReaderBridge.exe'), ['--request-id', requestId], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
    const frames: ProtocolFrame[] = [];
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 3_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge_hello_timeout')), 3_000);
        const check = (chunk: Buffer) => {
          frames.push(...decoder.push(chunk));
          if (frames.length) { clearTimeout(timer); child.stdout.off('data', check); resolve(); }
        };
        child.stdout.on('data', check);
      });
      child.stdin.write(encodeFrame({ version: 1, requestId, sequence: 1, type: 'init', operation: 'verify_official_source',
        expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 5_000 }, FRAME_LIMITS.controlBytes));
      child.stdin.end();
      await closed;
      expect(child.exitCode).toBe(4);
      expect(frames.map((frame) => frame.type)).toEqual(['hello']);
    } finally {
      clearTimeout(killTimer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
