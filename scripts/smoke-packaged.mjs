import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { flipFuses, getCurrentFuseWire, FuseV1Options, FuseVersion } from '@electron/fuses';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const unpackedRoot = path.join(repositoryRoot, 'release', 'win-unpacked');
const executable = path.join(unpackedRoot, 'LINE Agent Assistant.exe');
const resources = path.join(unpackedRoot, 'resources');

async function mustExist(relativePath) {
  const absolute = path.join(resources, relativePath);
  const info = await stat(absolute).catch(() => null);
  assert.ok(info?.isFile(), `packaged resource is missing: ${relativePath}`);
}

async function waitForExit(child, timeoutMs, description) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${description} did not exit cleanly`)), timeoutMs)),
  ]);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTarget(port, type = 'page') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const page = targets.find((item) => type === 'any' || item.type === type);
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packaged app did not expose a ${type} DevTools target`);
}

async function cdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    },
    close() { socket.close(); },
  };
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'line-agent-smoke-'));
let appProcess;
try {
  const isolatedAppData = {
    APPDATA: path.join(temporaryRoot, 'roaming-app-data'),
    LOCALAPPDATA: path.join(temporaryRoot, 'local-app-data'),
    PROGRAMDATA: path.join(temporaryRoot, 'program-data'),
  };
  await Promise.all(Object.values(isolatedAppData).map((directory) => mkdir(directory, { recursive: true })));
  for (const file of [
    'resource-manifest.json', 'line-worker/process-entry.js', 'line-worker/native/AttachmentBroker.exe',
    'line-worker/node_modules/@evex/linejs/package.json', 'line-worker/node_modules/@line-agent/contracts/package.json',
    'line-worker/node_modules/@line-agent/line-chrome/package.json', 'line-worker/node_modules/@line-agent/line-chrome/dist/index.js',
    'line-worker/node_modules/zod/package.json', 'native/JobHost.exe', 'database/migrations/001_initial.sql',
    'database/migrations/005_pending_route_recovery.sql', 'app.asar',
  ]) await mustExist(file);
  process.stdout.write('Packaged files and native resources verified.\n');

  // The shipped executable must keep --inspect disabled. The smoke driver needs the main-process inspector,
  // so it runs a throwaway copy with only that one fuse re-enabled.
  const shipped = await getCurrentFuseWire(executable);
  assert.equal(shipped[FuseV1Options.EnableNodeCliInspectArguments], 48 /* '0' */, 'shipped executable must disable --inspect');
  // Long (non 8.3) path: the renderer identity check compares file:// URLs literally.
  const smokeRoot = path.join(realpathSync.native(temporaryRoot), 'app');
  await cp(unpackedRoot, smokeRoot, { recursive: true });
  const smokeResources = path.join(smokeRoot, 'resources');
  // Exercise the real production entry without optional Chrome implementation files or package resolution.
  await rm(path.join(smokeResources, 'line-worker', 'chrome-adapter.js'), { force: true });
  await rm(path.join(smokeResources, 'line-worker', 'node_modules', '@line-agent', 'line-chrome'), { recursive: true, force: true });
  const smokeExecutable = path.join(smokeRoot, path.basename(executable));
  await flipFuses(smokeExecutable, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });

  const port = await freePort();
  const mainPort = await freePort();
  appProcess = spawn(smokeExecutable, [`--remote-debugging-port=${port}`, `--inspect=${mainPort}`, `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`], {
    cwd: smokeRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...isolatedAppData, LINE_AGENT_PACKAGED_SMOKE_HEADLESS: '1' },
  });
  let appStderr = '';
  appProcess.stderr?.on('data', (chunk) => { appStderr = (appStderr + chunk.toString()).slice(-8192); });
  appProcess.once('exit', (code, signal) => {
    if (code !== null && code !== 0) process.stderr.write(`Packaged app exited early (${code}/${signal}): ${appStderr}\n`);
  });
  const mainTarget = await waitForTarget(mainPort, 'any');
  const mainProtocol = await cdp(mainTarget.webSocketDebuggerUrl);
  const workerEntry = path.join(repositoryRoot, 'scripts', 'fixtures', 'smoke-worker-entry.mjs');
  const productionWorkerEntry = path.join(smokeResources, 'line-worker', 'process-entry.js');
  const attachmentRoot = path.join(temporaryRoot, 'attachments');
  const workerExpression = `(async () => {
    const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/smoke.cjs')('electron');
    await electron.app.whenReady();
    return await new Promise((resolve, reject) => {
    const { utilityProcess } = electron;
    const child = utilityProcess.fork(${JSON.stringify(workerEntry)}, [], { env: {
      LINE_AGENT_SMOKE_WORKER_ROOT: ${JSON.stringify(path.join(resources, 'line-worker'))},
      LINE_AGENT_SMOKE_ATTACHMENT_ROOT: ${JSON.stringify(attachmentRoot)}
    }, serviceName: 'line-agent-packaged-smoke-worker' });
    let protocolAcknowledged = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker modeAck timeout')); }, 20000);
    child.on('message', (event) => {
      if (event?.type === 'workerProtocolAck') {
        if (event.protocolVersion !== 4) {
          clearTimeout(timer); child.kill(); reject(new Error('worker protocolAck version mismatch'));
          return;
        }
        protocolAcknowledged = true;
        return;
      }
      if (event?.type !== 'modeAck') return;
      if (!protocolAcknowledged) {
        clearTimeout(timer); child.kill(); reject(new Error('worker modeAck arrived before protocolAck'));
        return;
      }
      clearTimeout(timer); child.kill(); resolve(event);
    });
    child.on('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error('worker exited ' + code)); } });
    child.postMessage({ type: 'init', protocolVersion: 4, accountId: 'packaged-smoke-account', workerInstanceId: 'packaged-smoke-worker', mode: 'MONITOR_ONLY', controlEpoch: 7, durableCursor: { version: 1, revision: '0', globalRev: '0', individualRev: '0' } });
    });
  })()`;
  const workerResult = await mainProtocol.call('Runtime.evaluate', { expression: workerExpression, awaitPromise: true, returnByValue: true });
  assert.equal(workerResult.exceptionDetails, undefined, 'packaged utility-process worker failed');
  assert.deepEqual(workerResult.result.value, { type: 'modeAck', accountId: 'packaged-smoke-account', workerInstanceId: 'packaged-smoke-worker', mode: 'MONITOR_ONLY', controlEpoch: 7, drained: true });
  const productionWorkerExpression = `(async () => {
    const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/smoke.cjs')('electron');
    await electron.app.whenReady();
    return await new Promise((resolve, reject) => {
      const child = electron.utilityProcess.fork(${JSON.stringify(productionWorkerEntry)}, [], { env: {
        LINE_WORKER_ATTACHMENT_ROOT: ${JSON.stringify(attachmentRoot)}
      }, serviceName: 'line-agent-production-worker-smoke', stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const messages = [];
      let settled = false;
      let expectedTermination = false;
      const timer = setTimeout(() => fail('production worker init timeout'), 20000);
      const fail = (reason) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(new Error(reason + '; stderr=' + stderr)); };
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('exit', (code, signal) => {
        if (expectedTermination && !settled) {
          settled = true; clearTimeout(timer); resolve({ messages, stderr, exit: { code, signal } });
        } else if (!settled) fail('production worker exited ' + code + '/' + signal);
      });
      child.on('message', (raw) => {
        const event = raw?.data ?? raw;
        if (!event || typeof event !== 'object') return;
        messages.push(event.type);
        if (event.type === 'workerProtocolAck') {
          if (event.protocolVersion !== 4 || event.manualSend !== true) fail('production worker protocolAck mismatch');
          return;
        }
        if (event.type !== 'modeAck') return;
        if (messages[0] !== 'workerProtocolAck' || event.accountId !== 'production-smoke-account'
          || event.workerInstanceId !== 'production-smoke-worker' || event.mode !== 'MONITOR_ONLY'
          || event.controlEpoch !== 9 || event.drained !== true) {
          fail('production worker modeAck mismatch');
          return;
        }
        setTimeout(() => {
          if (settled) return;
          if (messages.join(',') !== 'workerProtocolAck,modeAck') { fail('unexpected production worker event: ' + messages.join(',')); return; }
          if (/ERR_MODULE_NOT_FOUND|Cannot find package|UnhandledPromiseRejection/i.test(stderr)) { fail('production worker startup error'); return; }
          expectedTermination = true;
          child.kill();
        }, 100);
      });
      child.postMessage({ type: 'init', protocolVersion: 4, accountId: 'production-smoke-account',
        workerInstanceId: 'production-smoke-worker', mode: 'MONITOR_ONLY', controlEpoch: 9,
        durableCursor: { version: 1, revision: '0', globalRev: '0', individualRev: '0' } });
    });
  })()`;
  const productionResult = await mainProtocol.call('Runtime.evaluate', { expression: productionWorkerExpression, awaitPromise: true, returnByValue: true });
  assert.equal(productionResult.exceptionDetails, undefined, 'production process-entry failed to initialize');
  assert.deepEqual(productionResult.result.value.messages, ['workerProtocolAck', 'modeAck']);
  assert.doesNotMatch(productionResult.result.value.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package|UnhandledPromiseRejection/i);
  assert.ok(productionResult.result.value.exit.code !== null || productionResult.result.value.exit.signal !== null,
    'production worker exit reason was not captured after smoke termination');
  process.stdout.write(`Production worker init passed; stderr=${JSON.stringify(productionResult.result.value.stderr)} exit=${JSON.stringify(productionResult.result.value.exit)}\n`);
  const target = await waitForTarget(port);
  const protocol = await cdp(target.webSocketDebuggerUrl);
  let handshake;
  const renderDeadline = Date.now() + 10_000;
  while (Date.now() < renderDeadline) {
    const evaluation = await protocol.call('Runtime.evaluate', { expression: `(async () => ({ api: typeof window.lineAgent === 'object', snapshot: (await window.lineAgent.getSnapshot()).control.phase, rendered: Boolean(document.querySelector('#root')?.textContent?.trim()) }))()`, awaitPromise: true, returnByValue: true });
    handshake = evaluation.result.value;
    if (handshake.rendered) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(handshake, { api: true, snapshot: 'idle', rendered: true });
  const visibility = await mainProtocol.call('Runtime.evaluate', { expression: `(() => {
    const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/smoke.cjs')('electron');
    electron.app.emit('activate');
    return electron.BrowserWindow.getAllWindows().map((item) => item.isVisible());
  })()`, returnByValue: true });
  assert.equal(visibility.exceptionDetails, undefined, 'could not inspect packaged BrowserWindow visibility');
  assert.deepEqual(visibility.result.value, [false], 'headless packaged smoke must never show a window');
  protocol.close();
  const quitResult = await mainProtocol.call('Runtime.evaluate', { expression: `process.getBuiltinModule('module').createRequire(process.cwd() + '/smoke.cjs')('electron').app.quit()`, returnByValue: true });
  assert.equal(quitResult.exceptionDetails, undefined, 'main-process app.quit() failed');
  mainProtocol.close();
  const exit = await waitForExit(appProcess, 15_000, 'packaged app after app.quit()');
  assert.equal(exit.code, 0, `packaged app exited with ${exit.code ?? exit.signal}`);
  appProcess = undefined;
  process.stdout.write('Packaged smoke passed: resources, utility-process modeAck, renderer/preload IPC, and clean exit.\n');
} finally {
  if (appProcess && appProcess.exitCode === null) appProcess.kill();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
