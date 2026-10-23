import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const evidencePath = resolve(repositoryRoot, 'artifacts/verification/friend-whitelist-p0.md');

export const DEFAULT_LIMITS = Object.freeze({
  idleSoakMs: 600_000,
  burstMessages: 10_000,
  maxUtilityWorkersPerAccount: 1,
  totalUtilityWorkerLimit: 4,
  maxProviderExecutions: 2,
  maxProviderExecutionsPerAccount: 1,
  maxQueuedDomainEvents: 256,
  shutdownDeadlineMs: 30_000,
});

const assertFiniteNonnegative = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a nonnegative finite number`);
};

export function normalizeProcessInventory(rootPid, processRows, previouslyOwned = [], observerPid) {
  if (!Array.isArray(processRows) || !Number.isInteger(observerPid) || observerPid <= 0 || observerPid === rootPid) {
    return { processes: [], complete: false, observerPid: observerPid ?? null, rssBytes: 0, rootIdentity: null };
  }
  const byPid = new Map(processRows.map((row) => [Number(row.ProcessId), row]));
  const root = byPid.get(rootPid);
  const observer = byPid.get(observerPid);
  if (!root || !observer) return { processes: [], complete: false, observerPid, rssBytes: 0, rootIdentity: null,
    missingRoot: !root, missingObserver: !observer, observedPids: [...byPid.keys()] };
  const owned = new Map();
  const ancestors = [rootPid];
  while (ancestors.length) {
    const parentPid = ancestors.shift();
    for (const row of processRows) {
      const pid = Number(row.ProcessId);
      if (pid === rootPid || pid === observerPid || Number(row.ParentProcessId) !== parentPid || owned.has(pid)) continue;
      owned.set(pid, row);
      ancestors.push(pid);
    }
  }
  for (const old of previouslyOwned) {
    const row = byPid.get(Number(old.ProcessId));
    if (row && row.ProcessId !== observerPid && String(row.CreationDate) === String(old.CreationDate)) owned.set(Number(row.ProcessId), row);
  }
  const retained = [...owned.values()].sort((a, b) => Number(a.ProcessId) - Number(b.ProcessId));
  const processes = retained.map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId),
    creationDate: String(row.CreationDate), name: String(row.Name), rssBytes: Number(row.WorkingSetSize) || 0 }));
  return { processes, complete: true, observerPid, rootIdentity: { ProcessId: rootPid, CreationDate: String(root.CreationDate) },
    rssBytes: (Number(root.WorkingSetSize) || 0) + processes.reduce((sum, row) => sum + row.rssBytes, 0) };
}

function descendantProcessInventory(pid, previouslyOwned = [], observerDeadlineMs = 5_000) {
  if (process.platform !== 'win32') {
    return { processes: [], method: 'unsupported', complete: false, observerElapsedMs: 0, rssBytes: 0 };
  }
  const oldPids = previouslyOwned.map((item) => Number(item.ProcessId)).filter(Number.isInteger).join(',');
  const command = `$all = Get-CimInstance Win32_Process; $root = $all | Where-Object { [int]$_.ProcessId -eq ${pid} }; $observer = [int]$PID; $ids = @(${pid}); $found = @(); $changed = $true; while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids -contains [int]$p.ParentProcessId -and $ids -notcontains [int]$p.ProcessId) { $ids += [int]$p.ProcessId; $found += $p; $changed = $true } } }; $old = @(${oldPids}); foreach ($p in $all) { if ($old -contains [int]$p.ProcessId -and $found.ProcessId -notcontains $p.ProcessId) { $found += $p } }; $observerRecord = [pscustomobject]@{ ProcessId=$observer; ParentProcessId=0; CreationDate=(Get-Date).ToString('o'); Name='powershell.exe'; WorkingSetSize=[long](Get-Process -Id $observer).WorkingSet64 }; $rows = @($root) + @($found) + @($observerRecord); $result = [pscustomobject]@{ observerPid = $observer; processes = @($rows | ForEach-Object { [pscustomobject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; CreationDate=[string]$_.CreationDate; Name=[string]$_.Name; WorkingSetSize=[long]$_.WorkingSetSize } }) }; $result | ConvertTo-Json -Compress -Depth 4`;
  const started = Date.now();
  const response = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: observerDeadlineMs, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observerElapsedMs = Date.now() - started;
  if (response.error || response.status !== 0) return { processes: [], method: 'Win32_Process observer failed or timed out', complete: false, observerElapsedMs, rssBytes: 0 };
  try {
    const parsed = JSON.parse(response.stdout.trim());
    const inventory = normalizeProcessInventory(pid, parsed.processes, previouslyOwned, Number(parsed.observerPid));
    return { ...inventory, method: 'Win32_Process parent tree plus identity-checked reparented descendants', complete: inventory.complete && observerElapsedMs <= observerDeadlineMs,
      observerElapsedMs };
  } catch {
    return { processes: [], method: 'Win32_Process observer returned invalid inventory', complete: false, observerElapsedMs, rssBytes: 0 };
  }
}

function verifyOwnedProcessesGone(identities, observerDeadlineMs = 5_000) {
  if (process.platform !== 'win32') return { complete: false, remaining: [] };
  const entries = identities.filter((entry) => Number.isInteger(Number(entry?.ProcessId)) && entry?.CreationDate)
    .map((entry) => `${Number(entry.ProcessId)}|${String(entry.CreationDate).replaceAll("'", "''")}`);
  const list = entries.map((entry) => `'${entry}'`).join(',');
  const command = `$wanted = @(${list}); $all = Get-CimInstance Win32_Process; $remaining = @(); foreach ($w in $wanted) { $parts = $w.Split('|',2); $p = $all | Where-Object { [int]$_.ProcessId -eq [int]$parts[0] -and [string]$_.CreationDate -eq [string]$parts[1] }; if ($p) { $remaining += [int]$parts[0] } }; [pscustomobject]@{ observerPid=[int]$PID; remaining=@($remaining) } | ConvertTo-Json -Compress`;
  const response = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: observerDeadlineMs, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (response.error || response.status !== 0) return { complete: false, remaining: [] };
  try {
    const result = JSON.parse(response.stdout.trim());
    return { complete: Number.isInteger(Number(result.observerPid)), remaining: Array.isArray(result.remaining) ? result.remaining.map(Number) : [Number(result.remaining)].filter(Number.isInteger) };
  } catch { return { complete: false, remaining: [] }; }
}

async function runElectronAcceptance(idleSoakMs, shutdownDeadlineMs) {
  if (process.platform !== 'win32') return { runtimeObserved: false, complete: false, blocker: 'Live Electron inventory is supported only on Windows.' };
  const electron = resolve(repositoryRoot, 'node_modules/electron/dist/electron.exe');
  const desktop = resolve(repositoryRoot, 'apps/desktop');
  const profile = await mkdtemp(join(tmpdir(), 'linejs-runtime-inventory-'));
  const env = { ...process.env, LOCALAPPDATA: profile, APPDATA: profile, ELECTRON_ENABLE_LOGGING: '1', LINEJS_RUNTIME_INVENTORY_MODE: '1',
    LINEJS_RUNTIME_INVENTORY_IDLE_SOAK_MS: String(idleSoakMs), LINEJS_RUNTIME_INVENTORY_SIGNAL_DIR: profile };
  for (const key of ['DATABASE_URL', 'LINE_AGENT_BOOTSTRAP_DATABASE_URL', 'LINE_AGENT_ATTACHMENT_ROOT', 'LINE_AGENT_BOOTSTRAP_ATTACHMENT_ROOT']) delete env[key];
  const child = spawn(electron, [desktop, '--disable-gpu', '--no-sandbox', '--enable-logging=stderr'], { cwd: repositoryRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tracker = { processes: [] };
  const ownedIdentities = [];
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitForMarker = async (marker, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const line = output.split(/\r?\n/).find((candidate) => candidate.includes(`"marker":"${marker}"`));
      if (line) { try { return JSON.parse(line); } catch { return null; } }
      if (child.exitCode !== null) return null;
      await delay(100);
    }
    return null;
  };
  const exit = new Promise((resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })));
  const idleSnapshots = [];
  const workloadProcessSnapshots = [];
  const observeApp = () => {
    const snapshot = descendantProcessInventory(child.pid, tracker.processes);
    tracker.processes = snapshot.processes;
    if (snapshot.rootIdentity) ownedIdentities.push(snapshot.rootIdentity);
    ownedIdentities.push(...snapshot.processes.map(({ pid, creationDate }) => ({ ProcessId: pid, CreationDate: creationDate })));
    return snapshot;
  };
  let timedOut = false;
  try {
    const ready = await waitForMarker('LINEJS_RUNTIME_INVENTORY_READY', Math.min(shutdownDeadlineMs, 60_000));
    if (!ready) throw new Error(`Electron startup did not report ready. exit=${child.exitCode} stdout=${output.slice(-2000)} stderr=${stderr.slice(-2000)}`);
    const idleStartedAt = Date.now();
    idleSnapshots.push(observeApp());
    while (Date.now() - idleStartedAt < idleSoakMs) {
      await delay(Math.min(60_000, idleSoakMs - (Date.now() - idleStartedAt)));
      idleSnapshots.push(observeApp());
    }
    const idleSoakElapsedMs = Date.now() - idleStartedAt;
    const idleEnd = await waitForMarker('LINEJS_RUNTIME_INVENTORY_IDLE_END', shutdownDeadlineMs);
    if (!idleEnd) throw new Error(`Electron idle-soak end snapshot was not observed. stdout=${output.slice(-2000)}`);
    const countResources = (resources) => resources.reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {});
    const readyResourceCounts = countResources(ready.activeResources ?? []);
    const idleResourceCounts = countResources(idleEnd.activeResources ?? []);
    const idleResourceGrowth = Object.fromEntries(Object.entries(idleResourceCounts).filter(([name, count]) => count > (readyResourceCounts[name] ?? 0))
      .map(([name, count]) => [name, count - (readyResourceCounts[name] ?? 0)]));
    const idleListenerGrowth = idleEnd.appListenerCount > ready.appListenerCount || idleEnd.ipcListenerCount > ready.ipcListenerCount;
    const capReady = await waitForMarker('LINEJS_RUNTIME_INVENTORY_CAP_READY', shutdownDeadlineMs);
    if (!capReady) throw new Error(`Electron worker-cap probe did not reach the configured cap. stdout=${output.slice(-2000)}`);
    workloadProcessSnapshots.push(observeApp());
    await writeFile(join(profile, 'cap-continue'), 'observed');
    const workerReady = await waitForMarker('LINEJS_RUNTIME_INVENTORY_WORKER_READY', shutdownDeadlineMs);
    if (!workerReady) throw new Error(`Electron utility worker did not become ready for burst. stdout=${output.slice(-2000)}`);
    workloadProcessSnapshots.push(observeApp());
    await writeFile(join(profile, 'burst-continue'), 'observed');
    const burst = await waitForMarker('LINEJS_RUNTIME_INVENTORY_BURST', shutdownDeadlineMs);
    if (!burst) throw new Error(`Electron utility-worker burst did not complete. stdout=${output.slice(-4000)} stderr=${stderr.slice(-2000)}`);
    const shutdownMarker = await waitForMarker('LINEJS_RUNTIME_INVENTORY_SHUTDOWN', shutdownDeadlineMs);
    const closed = await Promise.race([exit, delay(shutdownDeadlineMs).then(() => { timedOut = true; return null; })]);
    const treeComplete = [...idleSnapshots, ...workloadProcessSnapshots].every((snapshot) => snapshot.complete);
    const ownershipAfterExit = verifyOwnedProcessesGone([...new Map(ownedIdentities.map((entry) => [`${entry.ProcessId}:${entry.CreationDate}`, entry])).values()]);
    const orphanProcessCount = ownershipAfterExit.remaining.length;
    const rssSamples = [...idleSnapshots, ...workloadProcessSnapshots].map((snapshot) => snapshot.rssBytes);
    const idleRssSamples = idleSnapshots.map((snapshot) => snapshot.rssBytes);
    const rssDeltaBytes = rssSamples.length ? Math.max(...rssSamples) - Math.min(...rssSamples) : 0;
    const rssMonotonicGrowth = idleRssSamples.length > 1 && Math.max(...idleRssSamples) - Math.min(...idleRssSamples) > 1_048_576
      && idleRssSamples.every((value, index) => index === 0 || value > idleRssSamples[index - 1]);
    const afterOwned = burst.afterShutdown ?? {};
    const admission = burst.workerAdmission ?? {};
    const resourceCounts = (resources) => resources.reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {});
    const readyResources = resourceCounts(ready.activeResources ?? []);
    const shutdownResources = resourceCounts(shutdownMarker?.activeResources ?? []);
    const resourceGrowth = Object.fromEntries(Object.entries(shutdownResources).filter(([name, count]) => count > (readyResources[name] ?? 0))
      .map(([name, count]) => [name, count - (readyResources[name] ?? 0)]));
    const ownerGone = closed?.code === 0 && ownershipAfterExit.complete && orphanProcessCount === 0;
    const resourceGrowthExceptions = ownerGone ? [
      ...Object.keys(idleResourceGrowth).filter((name) => name === 'PipeWrap').map((name) => ({ phase: 'idle', resource: name,
        reason: 'Electron stdio/IPC transport handles are process-owned and the exact PID/creation-time inventory confirms their owner exited.' })),
      ...Object.keys(resourceGrowth).filter((name) => name === 'PipeWrap').map((name) => ({ phase: 'shutdown', resource: name,
        reason: 'Electron stdio/IPC transport handles are process-owned and the exact PID/creation-time inventory confirms their owner exited.' })),
    ] : [];
    const unexpectedResourceGrowth = Object.keys(resourceGrowth).filter((name) => !resourceGrowthExceptions.some((item) => item.resource === name));
    const unexpectedIdleResourceGrowth = Object.keys(idleResourceGrowth).filter((name) => !resourceGrowthExceptions.some((item) => item.phase === 'idle' && item.resource === name));
    const listenerGrowth = (shutdownMarker?.appListenerCount ?? Infinity) > ready.appListenerCount
      || (shutdownMarker?.ipcListenerCount ?? Infinity) > ready.ipcListenerCount;
    const result = { runtimeObserved: true, featureEnabled: ready.featureEnabled, whitelistDispatcherCount: ready.whitelistInvokeChannels?.length ?? null,
      whitelistTimerCount: ready.whitelistTimerCount ?? null,
      whitelistListenerCount: ready.whitelistListenerCount ?? 0, ready, idleEnd, burst, shutdownMarker, idleSoakElapsedMs, idleSnapshots,
      workloadProcessSnapshots, capReady, workerReady,
      processTreeComplete: treeComplete && ownershipAfterExit.complete, ownershipAfterExit, orphanProcessCount,
      processTreeRssBytes: rssSamples, processTreeRss: { baselineBytes: idleRssSamples[0] ?? null,
        peakBytes: rssSamples.length ? Math.max(...rssSamples) : null, drainBytes: 0, rssDeltaBytes },
      rssDeltaBytes, rssMonotonicGrowth, idleResourceGrowth, idleListenerGrowth, resourceGrowth, resourceGrowthExceptions,
      unexpectedResourceGrowth, unexpectedIdleResourceGrowth, listenerGrowth,
      shutdown: { timedOut, exitCode: closed?.code ?? null, passed: !timedOut && closed?.code === 0 },
      complete: treeComplete && ownershipAfterExit.complete && orphanProcessCount === 0 && !rssMonotonicGrowth
        && unexpectedIdleResourceGrowth.length === 0 && !idleListenerGrowth && unexpectedResourceGrowth.length === 0
        && !listenerGrowth && !timedOut && closed?.code === 0
        && burst.statusEvents === DEFAULT_LIMITS.burstMessages && afterOwned.activeWorkers === 0 && afterOwned.launchingWorkers === 0
        && afterOwned.restartTimers === 0 && afterOwned.pendingTasks === 0 && afterOwned.ownedTimers === 0 && afterOwned.ownedListeners === 0
        && admission.configuredCap === DEFAULT_LIMITS.totalUtilityWorkerLimit && admission.acceptedAtCap === admission.configuredCap
        && admission.fifthWorkerRejected === true && admission.afterShutdown?.activeWorkers === 0 };
    await rm(profile, { recursive: true, force: true });
    return result;
  } catch (error) {
    timedOut = true;
    if (child.exitCode === null && Number.isInteger(child.pid)) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true });
    await Promise.race([exit, delay(5_000)]);
    const result = { runtimeObserved: false, complete: false, blocker: error instanceof Error ? error.message : String(error), stderr: stderr.slice(-2000),
      processTreeComplete: false, idleSnapshots, workloadProcessSnapshots, shutdown: { timedOut: true, exitCode: child.exitCode, passed: false } };
    await rm(profile, { recursive: true, force: true });
    return result;
  }
}

const countResources = (resources) => resources.reduce((counts, resource) => ({ ...counts, [resource]: (counts[resource] ?? 0) + 1 }), {});

export function summarizeResourceDelta(before, after) {
  const resourceGrowth = {};
  for (const [name, count] of Object.entries(after.process.resourceCounts)) {
    const increase = count - (before.process.resourceCounts[name] ?? 0);
    if (increase > 0) resourceGrowth[name] = increase;
  }
  const processListenerGrowth = after.process.listenerCount - before.process.listenerCount;
  const processGrowth = after.process.descendantCount - before.process.descendantCount;
  return { resourceGrowth, processListenerGrowth, processGrowth,
    hasGrowth: Object.keys(resourceGrowth).length > 0 || processListenerGrowth > 0 || processGrowth > 0 };
}

export function hasTwoCleanEvidenceRuns(runs, fingerprint, revision) {
  const eligible = runs.filter((run) => run.sourceFingerprint?.digest === fingerprint && run.git?.revision === revision
    && run.git?.workingTreeDirty === false && run.workload?.idleSoakMs === DEFAULT_LIMITS.idleSoakMs
    && run.workload?.messageCount === DEFAULT_LIMITS.burstMessages && run.workload?.drained === true
    && run.inventoryPassed === true && run.gate?.FRIEND_WHITELIST_P0_READY === true
    && run.gate?.blockers?.length === 0 && run.processTreeComplete === true);
  return eligible.length >= 2;
}

export function captureSnapshot(options = {}) {
  const tracker = options.processTracker ?? { processes: [] };
  const tree = options.processTreeInventory ?? descendantProcessInventory(process.pid, tracker.processes, options.observerDeadlineMs);
  tracker.processes = tree.processes ?? [];
  const activeResources = process.getActiveResourcesInfo();
  const resourceCounts = countResources(activeResources);
  const tasks = options.tasks ?? 0;
  const listeners = options.listeners ?? 0;
  const ownedTimers = options.timers ?? 0;
  return {
    capturedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      descendantCount: tree.processes.length,
      descendantPids: tree.processes.map(({ pid }) => pid),
      processTreeMethod: tree.method,
      processTreeComplete: tree.complete,
      processTreeRssBytes: tree.rssBytes,
      observerElapsedMs: tree.observerElapsedMs,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      activeResources,
      resourceCounts,
      listenerCount: process.eventNames().reduce((sum, name) => sum + process.listenerCount(name), 0),
    },
    tasks: { active: tasks },
    timers: { active: ownedTimers },
    listeners: { active: listeners ?? process.eventNames().reduce((sum, name) => sum + process.listenerCount(name), 0) },
  };
}

function zeroGrowth(before, after) {
  const tracked = ['tasks', 'timers', 'listeners'];
  return tracked.every((key) => after[key].active <= before[key].active)
    && after.process.descendantCount <= before.process.descendantCount;
}

export function runtimeRunTimes(electronRuntime, harnessStartedAt, harnessCompletedAt) {
  return {
    startedAt: electronRuntime?.ready?.capturedAt ?? harnessStartedAt,
    completedAt: electronRuntime?.shutdownMarker?.capturedAt ?? harnessCompletedAt,
  };
}

async function disabledFeatureStartupEvidence() {
  return {
    featureEnabled: null,
    whitelistDispatcherCount: null,
    whitelistTimerCount: null,
    whitelistListenerCount: null,
    method: 'no live Electron startup supplied to this inventory run; fail-closed',
    runtimeObserved: false,
  };
}

export async function runInventory(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  assertFiniteNonnegative(limits.idleSoakMs, 'idleSoakMs');
  const electronRuntime = options.liveElectron === false ? null : await runElectronAcceptance(limits.idleSoakMs, limits.shutdownDeadlineMs);
  const idleStart = await captureSnapshot();
  const idleStartedAt = Date.now();
  if (!electronRuntime && limits.idleSoakMs) await delay(limits.idleSoakMs);
  const idleSoakElapsedMs = electronRuntime?.idleSoakElapsedMs ?? Date.now() - idleStartedAt;
  const idleEnd = await captureSnapshot();

  let activeTasks = 0;
  let activeTimers = 0;
  let activeListeners = 0;
  let drainedCount = 0;
  let maxActiveTasks = 0;
  const queue = Array.from({ length: limits.burstMessages }, (_, index) => index);
  let nextMessage = 0;
  const listener = () => { drainedCount += 1; };
  const events = new EventEmitter();
  events.on('message', listener);
  activeListeners += 1;
  const burstStart = await captureSnapshot({ tasks: activeTasks, timers: activeTimers, listeners: activeListeners });
  const workerCount = 1;
  const abortController = new AbortController();
  const shutdownStartedAt = Date.now();
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextMessage < queue.length) {
      const message = queue[nextMessage++];
      if (message === undefined) break;
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      try {
        events.emit('message', message);
        if (limits.messageDelayMs) await delay(limits.messageDelayMs, undefined, { signal: abortController.signal });
        else await yieldToEventLoop();
      } catch (error) {
        if (!abortController.signal.aborted) throw error;
      } finally { activeTasks -= 1; }
      if (abortController.signal.aborted) break;
    }
  });
  let maxActiveTimers = 0;
  let shutdownTimer;
  let burstActive;
  let timedOut = false;
  let workerDrain;
  try {
    workerDrain = Promise.all(workers);
    shutdownTimer = setTimeout(() => { timedOut = true; abortController.abort(); }, limits.shutdownDeadlineMs);
    activeTimers = 1;
    maxActiveTimers = activeTimers;
    burstActive = await captureSnapshot({ tasks: activeTasks, timers: activeTimers, listeners: events.listenerCount('message') });
    await Promise.race([workerDrain, new Promise((resolve) => { shutdownTimer?.unref?.(); })]);
  } finally {
    abortController.abort();
    clearTimeout(shutdownTimer);
    activeTimers = 0;
    events.off('message', listener);
    activeListeners = 0;
    await workerDrain?.catch(() => undefined);
  }
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  const afterDrain = await captureSnapshot({ tasks: activeTasks, timers: activeTimers, listeners: activeListeners });
  const postDrain = [];
  for (let index = 0; index < 3; index += 1) {
    await delay(100);
    postDrain.push(await captureSnapshot({ tasks: activeTasks, timers: activeTimers, listeners: activeListeners }));
  }
  const metrics = [idleStart, idleEnd, burstStart, burstActive, afterDrain, ...postDrain];
  const orphanProcessCount = Math.max(0, afterDrain.process.descendantCount, ...postDrain.map((snapshot) => snapshot.process.descendantCount));
  const maxObservedDescendantCount = Math.max(0, ...metrics.map((snapshot) => snapshot.process.descendantCount));
  const rssSamples = postDrain.map((snapshot) => snapshot.process.rssBytes);
  const rssDeltaBytes = Math.max(...rssSamples) - Math.min(...rssSamples);
  const rssMonotonicGrowth = rssSamples.every((rss, index) => index === 0 || rss > rssSamples[index - 1]) && rssDeltaBytes > 1_048_576;
  const monotonicGrowth = !zeroGrowth(burstStart, afterDrain)
    || postDrain.some((snapshot, index) => index > 0 && !zeroGrowth(postDrain[index - 1], snapshot))
    || postDrain.some((snapshot) => snapshot.tasks.active || snapshot.timers.active || snapshot.listeners.active)
    || rssMonotonicGrowth;
  const featureDisabledStartup = electronRuntime ? {
    featureEnabled: electronRuntime.featureEnabled ?? null,
    whitelistDispatcherCount: electronRuntime.whitelistDispatcherCount ?? null,
    whitelistTimerCount: electronRuntime.whitelistTimerCount ?? null,
    whitelistListenerCount: electronRuntime.whitelistListenerCount ?? null,
    method: 'live Electron startup using isolated LOCALAPPDATA with database/bootstrap environment removed',
    runtimeObserved: electronRuntime.runtimeObserved,
  } : await disabledFeatureStartupEvidence();
  const observedMessages = electronRuntime?.burst?.statusEvents ?? drainedCount;
  const workloadDrained = electronRuntime ? electronRuntime.complete && observedMessages === limits.burstMessages : drainedCount === limits.burstMessages;
  const inventoryPassed = orphanProcessCount === 0 && !monotonicGrowth && drainedCount === limits.burstMessages
    && idleSoakElapsedMs >= limits.idleSoakMs && !timedOut && shutdownElapsedMs <= limits.shutdownDeadlineMs
    && metrics.every((snapshot) => snapshot.process.processTreeComplete)
    && (!electronRuntime || electronRuntime.complete);
  const gateBlockers = [];
  if (limits.idleSoakMs !== DEFAULT_LIMITS.idleSoakMs) gateBlockers.push(`Acceptance requires the full ${DEFAULT_LIMITS.idleSoakMs}ms idle soak.`);
  if (limits.burstMessages !== DEFAULT_LIMITS.burstMessages) gateBlockers.push(`Acceptance requires exactly ${DEFAULT_LIMITS.burstMessages} burst messages.`);
  if (!Number.isInteger(limits.totalUtilityWorkerLimit) || limits.totalUtilityWorkerLimit < 1) gateBlockers.push('No configured global utility-worker cap is proven.');
  if (!featureDisabledStartup.runtimeObserved) gateBlockers.push('Feature-disabled startup was inspected statically; no live Electron startup was observed.');
  if ([featureDisabledStartup.whitelistDispatcherCount, featureDisabledStartup.whitelistTimerCount, featureDisabledStartup.whitelistListenerCount].some((count) => count !== 0)) {
    gateBlockers.push('Feature-disabled startup did not prove zero whitelist dispatchers, timers, and listeners.');
  }
  if (metrics.some((snapshot) => !snapshot.process.processTreeComplete) || (electronRuntime && !electronRuntime.processTreeComplete)) gateBlockers.push('Process-tree inspection is unsupported or incomplete on this platform.');
  if (!electronRuntime || !electronRuntime.runtimeObserved) gateBlockers.push(electronRuntime?.blocker ?? 'No live Electron runtime workload was captured.');
  if (electronRuntime && !electronRuntime.complete) gateBlockers.push('Live utility-worker workload, process cleanup, or application shutdown did not complete.');
  if (electronRuntime?.rssMonotonicGrowth) gateBlockers.push('Live Electron process-tree RSS grew monotonically above the configured noise floor during idle soak.');
  const ready = inventoryPassed && gateBlockers.length === 0;
  const result = {
    schemaVersion: 1,
    ...runtimeRunTimes(electronRuntime, idleStart.capturedAt, postDrain.at(-1).capturedAt),
    git: await gitRevision(),
    sourceFingerprint: await sourceFingerprint(),
    workload: { idleSoakMs: limits.idleSoakMs, idleSoakElapsedMs, messageCount: limits.burstMessages, drained: workloadDrained,
      drainedCount: electronRuntime ? observedMessages : drainedCount,
      messageModel: electronRuntime ? 'live Electron utilityProcess running the production utility-worker gateway; synthetic status events cross the worker IPC boundary' : 'synthetic in-process event burst; not LINE/provider execution' },
    limits: {
      maxUtilityWorkersPerAccount: limits.maxUtilityWorkersPerAccount,
      totalUtilityWorkerLimit: limits.totalUtilityWorkerLimit,
      maxProviderExecutions: limits.maxProviderExecutions,
      maxProviderExecutionsPerAccount: limits.maxProviderExecutionsPerAccount,
      maxQueuedDomainEvents: limits.maxQueuedDomainEvents,
      shutdownDeadlineMs: limits.shutdownDeadlineMs,
    },
    inventory: { idleStart, idleEnd, burstStart, burstActive, afterDrain, postDrain, electronRuntime },
    processTreeComplete: metrics.every((snapshot) => snapshot.process.processTreeComplete) && (!electronRuntime || electronRuntime.processTreeComplete),
    peak: { activeTasks: maxActiveTasks, activeTimers: maxActiveTimers, activeListeners: 1, rssBytes: Math.max(...metrics.map((snapshot) => snapshot.process.rssBytes)) },
    afterDrain: { orphanProcessCount, maxObservedDescendantCount, monotonicGrowth, rssMonotonicGrowth, rssNoiseFloorBytes: 1_048_576, rssDeltaBytes },
    shutdown: { elapsedMs: shutdownElapsedMs, deadlineMs: limits.shutdownDeadlineMs, timedOut, cancelled: timedOut, passed: !timedOut && shutdownElapsedMs <= limits.shutdownDeadlineMs },
    featureDisabledStartup,
    inventoryPassed,
    gate: { FRIEND_WHITELIST_P0_READY: ready, blockers: gateBlockers },
    passed: inventoryPassed,
  };
  if (options.persist !== false) await persistEvidence(result);
  return result;
}

async function gitRevision() {
  const { execFileSync } = await import('node:child_process');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const isEvidencePath = (line) => line.slice(3).replaceAll('\\', '/') === 'artifacts/verification/friend-whitelist-p0.md';
  return { revision, workingTreeDirty: status.some((line) => !isEvidencePath(line)), evidenceFileDirty: status.some(isEvidencePath) };
}

async function sourceFingerprint() {
  const paths = ['apps/desktop/src/main/main.ts', 'apps/desktop/src/main/utility-worker-gateway.ts',
    'apps/desktop/src/main/connected-facade.ts', 'apps/desktop/src/main/runtime-inventory-worker.ts',
    'apps/desktop/src/main/utility-worker-gateway.test.ts', 'apps/desktop/src/main/startup-mode.ts',
    'packages/agent-bridge/src/process-runner.ts', 'scripts/runtime-inventory.mjs', 'scripts/runtime-inventory.test.mjs',
    'apps/desktop/src/main/services/agent-service.ts',
    'apps/desktop/scripts/build.mjs', 'apps/desktop/dist/main.js', 'apps/desktop/dist/runtime-inventory-worker.mjs',
    'electron-builder.yml', 'package.json', 'package-lock.json', 'apps/desktop/package.json'];
  const hash = createHash('sha256');
  for (const relativePath of paths) {
    let contents;
    try { contents = await readFile(resolve(repositoryRoot, relativePath)); }
    catch { contents = Buffer.from('MISSING'); }
    hash.update(relativePath).update('\0').update(contents).update('\0');
  }
  return { algorithm: 'sha256', files: paths, digest: hash.digest('hex') };
}

async function persistEvidence(result) {
  await mkdir(resolve(repositoryRoot, 'artifacts/verification'), { recursive: true });
  let prior = [];
  try {
    const existing = await readFile(evidencePath, 'utf8');
    const match = existing.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) prior = JSON.parse(match[1]).runs ?? [];
  } catch { /* First run creates the evidence file. */ }
  if (result.workload.idleSoakMs === DEFAULT_LIMITS.idleSoakMs && result.workload.messageCount === DEFAULT_LIMITS.burstMessages) {
    prior.push(result);
  }
  const ready = hasTwoCleanEvidenceRuns(prior, result.sourceFingerprint.digest, result.git.revision);
  const document = [
    '# Friend whitelist Recovery P0 runtime evidence',
    '',
    `Status: ${ready ? 'FRIEND_WHITELIST_P0_READY=true' : 'FRIEND_WHITELIST_P0_READY=false'}`,
    '',
    'Runs are append-only and bind to the exact build and source fingerprint. A qualifying pair must be clean on the same revision and fingerprint, include complete exact-PID/creation-time process inventories, drain the live production utility-worker gateway burst, pass the worker-cap admission probe, and shut down with no owned process, task, timer, or listener remaining. Historical records are preserved and never recomputed.',
    '',
    'Configured limits: the production gateway admits at most four utility workers globally and one per account; the Electron acceptance probe starts four, rejects a fifth, then shuts all down. AgentService defaults to two concurrent provider executions; the worker domain-event queue is capped at 256. Provider execution limits are architecture-derived configuration, not exercised by the utility-worker status burst.',
    '',
    '```json',
    JSON.stringify({ runs: prior }, null, 2),
    '```',
    '',
  ].join('\n');
  await writeFile(evidencePath, document, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runInventory();
    console.log(JSON.stringify({ inventoryPassed: result.inventoryPassed, gate: result.gate, git: result.git, workload: result.workload,
      afterDrain: result.afterDrain, shutdown: result.shutdown }, null, 2));
    if (!result.gate.FRIEND_WHITELIST_P0_READY) process.exitCode = 2;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
