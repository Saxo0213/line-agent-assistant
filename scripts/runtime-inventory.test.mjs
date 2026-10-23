import assert from 'node:assert/strict';
import test from 'node:test';

import { captureSnapshot, DEFAULT_LIMITS, hasTwoCleanEvidenceRuns, normalizeProcessInventory, runInventory, runtimeRunTimes, summarizeResourceDelta } from './runtime-inventory.mjs';

test('runtime snapshots expose process, task, listener, timer, and RSS inventory', async () => {
  const snapshot = await captureSnapshot();

  assert.equal(typeof snapshot.process.pid, 'number');
  assert.equal(typeof snapshot.process.rssBytes, 'number');
  assert.equal(typeof snapshot.process.descendantCount, 'number');
  assert.equal(typeof snapshot.tasks.active, 'number');
  assert.equal(typeof snapshot.listeners.active, 'number');
  assert.equal(typeof snapshot.timers.active, 'number');
});

test('resource comparison detects a real persistent timeout and process listener leak', async () => {
  const before = await captureSnapshot();
  const leakListener = () => undefined;
  process.on('warning', leakListener);
  const timer = setTimeout(() => undefined, 60_000);
  try {
    const after = await captureSnapshot();
    const delta = summarizeResourceDelta(before, after);
    assert.equal(delta.processListenerGrowth, 1);
    assert.ok((delta.resourceGrowth.Timeout ?? 0) >= 1);
    assert.equal(delta.hasGrowth, true);
  } finally {
    clearTimeout(timer);
    process.off('warning', leakListener);
  }
});

test('process inventory excludes only its observer PID and retains reparented owned children', () => {
  const rows = [
    { ProcessId: 100, ParentProcessId: 1, CreationDate: 'root', Name: 'node.exe', WorkingSetSize: 200 },
    { ProcessId: 200, ParentProcessId: 100, CreationDate: 'observer', Name: 'powershell.exe', WorkingSetSize: 100 },
    { ProcessId: 201, ParentProcessId: 200, CreationDate: 'observer-child', Name: 'conhost.exe', WorkingSetSize: 100 },
    { ProcessId: 300, ParentProcessId: 100, CreationDate: 'real-child', Name: 'powershell.exe', WorkingSetSize: 300 },
    { ProcessId: 301, ParentProcessId: 300, CreationDate: 'grandchild', Name: 'node.exe', WorkingSetSize: 400 },
    { ProcessId: 400, ParentProcessId: 99, CreationDate: 'same-process', Name: 'node.exe', WorkingSetSize: 500 },
  ];

  const inventory = normalizeProcessInventory(100, rows, [{ ProcessId: 400, CreationDate: 'same-process' }], 200);

  assert.deepEqual(inventory.processes.map(({ pid }) => pid), [300, 301, 400]);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.rssBytes, 1_400);
});

test('process inventory fails closed when the exact observer identity is missing', () => {
  const inventory = normalizeProcessInventory(100, [
    { ProcessId: 100, ParentProcessId: 1, CreationDate: 'root', Name: 'electron.exe', WorkingSetSize: 100 },
  ], [], 200);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.missingRoot, false);
  assert.equal(inventory.missingObserver, true);
});

test('evidence readiness rejects mismatched revisions and incomplete process-tree inventories', () => {
  const accepted = { sourceFingerprint: { digest: 'fingerprint' }, git: { revision: 'revision', workingTreeDirty: false },
    workload: { idleSoakMs: 600_000, messageCount: 10_000, drained: true }, inventoryPassed: true,
    gate: { FRIEND_WHITELIST_P0_READY: true, blockers: [] },
    processTreeComplete: true };
  assert.equal(hasTwoCleanEvidenceRuns([accepted, accepted], 'fingerprint', 'revision'), true);
  assert.equal(hasTwoCleanEvidenceRuns([accepted, { ...accepted, processTreeComplete: false }], 'fingerprint', 'revision'), false);
  assert.equal(hasTwoCleanEvidenceRuns([accepted, { ...accepted, sourceFingerprint: { digest: 'other' } }], 'fingerprint', 'revision'), false);
});

test('live evidence timestamps cover Electron startup through application shutdown', () => {
  const times = runtimeRunTimes({ ready: { capturedAt: 'start' }, shutdownMarker: { capturedAt: 'finish' } }, 'harness-start', 'harness-finish');
  assert.deepEqual(times, { startedAt: 'start', completedAt: 'finish' });
  assert.deepEqual(runtimeRunTimes(null, 'harness-start', 'harness-finish'), { startedAt: 'harness-start', completedAt: 'harness-finish' });
});

test('inventory drains a 10,000-message burst within established worker and provider caps', async () => {
  const result = await runInventory({ idleSoakMs: 0, liveElectron: false, persist: false });

  assert.equal(result.workload.messageCount, 10_000);
  assert.equal(result.workload.drained, true);
  assert.ok(result.inventory.burstActive.tasks.active > 0);
  assert.equal(result.inventory.burstActive.timers.active, 1);
  assert.equal(result.limits.maxUtilityWorkersPerAccount, 1);
  assert.equal(result.limits.totalUtilityWorkerLimit, 4);
  assert.equal(result.limits.maxProviderExecutions, 2);
  assert.equal(result.limits.maxProviderExecutionsPerAccount, 1);
  assert.equal(result.afterDrain.orphanProcessCount, 0);
  assert.equal(result.afterDrain.monotonicGrowth, false);
  assert.ok(result.afterDrain.maxObservedDescendantCount >= result.afterDrain.orphanProcessCount);
  assert.equal(result.inventoryPassed, true);
  assert.equal(result.gate.FRIEND_WHITELIST_P0_READY, false);
  assert.ok(result.gate.blockers.some((item) => item.includes('live Electron startup')));
  assert.equal(result.workload.messageModel, 'synthetic in-process event burst; not LINE/provider execution');
  assert.equal(result.featureDisabledStartup.featureEnabled, null);
  assert.equal(result.featureDisabledStartup.runtimeObserved, false);
  assert.equal(result.featureDisabledStartup.whitelistDispatcherCount, null);
  assert.equal(result.featureDisabledStartup.whitelistTimerCount, null);
  assert.equal(result.featureDisabledStartup.whitelistListenerCount, null);
  assert.ok(result.shutdown.elapsedMs <= 30_000);
});

test('idle soak defaults to ten minutes and shutdown is bounded to thirty seconds', () => {
  assert.equal(DEFAULT_LIMITS.idleSoakMs, 600_000);
  assert.equal(DEFAULT_LIMITS.shutdownDeadlineMs, 30_000);
});

test('a burst timeout aborts work and removes its event listener and timer', async () => {
  const result = await runInventory({ idleSoakMs: 0, burstMessages: 10_000, messageDelayMs: 5, shutdownDeadlineMs: 1, liveElectron: false, persist: false });

  assert.equal(result.shutdown.passed, false);
  assert.equal(result.inventory.afterDrain.tasks.active, 0);
  assert.equal(result.inventory.afterDrain.timers.active, 0);
  assert.equal(result.inventory.afterDrain.listeners.active, 0);
  assert.equal(result.workload.drained, false);
  assert.equal(result.shutdown.cancelled, true);
});

test('inventory waits for the configured idle soak before the burst', async () => {
  const result = await runInventory({ idleSoakMs: 25, burstMessages: 0, liveElectron: false, persist: false });

  assert.ok(result.workload.idleSoakElapsedMs >= 20);
  assert.equal(result.workload.drained, true);
});
