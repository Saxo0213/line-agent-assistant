import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProcessObservations, identifyOwnedProcesses, runVerification } from './desktop-lifecycle-verify.mjs';

const paths = { executablePath: 'C:\\LINEJS\\node_modules\\electron\\dist\\electron.exe',
  workingDirectory: 'C:\\LINEJS\\apps\\desktop', readerPath: 'C:\\LINEJS\\apps\\desktop\\dist\\js-external-reader\\v1\\ExternalReaderBridge.exe' };
const mainRow = { pid: 10, parentPid: 1, executablePath: paths.executablePath, name: 'electron.exe', commandLine: 'electron.exe .' };
const readerRow = { pid: 11, parentPid: 10, executablePath: paths.readerPath, name: 'ExternalReaderBridge.exe', commandLine: 'reader' };

test('identifies only the exact main and its exact owned reader', () => {
  const rows = [mainRow, readerRow,
    { ...readerRow, pid: 12, parentPid: 99, executablePath: 'C:\\other\\ExternalReaderBridge.exe' },
    { ...readerRow, pid: 13, parentPid: 99, executablePath: 'C:\\other\\ExternalReaderBridge.exe', commandLine: 'C:\\LINEJS\\ExternalReaderBridge.exe' }];
  assert.deepEqual(identifyOwnedProcesses(rows, paths).map(({ pid, role }) => [pid, role]), [[10, 'main'], [11, 'reader']]);
});

test('identifies exact Electron relauncher candidates', () => {
  const relauncher = { ...mainRow, pid: 12, parentPid: 10, commandLine: 'electron.exe --type=relauncher' };
  const unrelated = { ...relauncher, pid: 13, parentPid: 99 };
  assert.deepEqual(identifyOwnedProcesses([mainRow, readerRow, relauncher, unrelated], paths).map(({ pid, role }) => [pid, role]),
    [[10, 'main'], [11, 'reader'], [12, 'relauncher'], [13, 'relauncher']]);
});

test('rejects a contaminated or ambiguous initial process inventory before launching', async () => {
  for (const rows of [[mainRow, readerRow, { ...mainRow, pid: 20 }], [mainRow], [readerRow]]) {
    let launched = false;
    const evidence = [];
    const result = await runVerification({ command: 'quit', ...paths, observe: async () => rows,
      launch: () => { launched = true; throw Error('must_not_launch'); }, writeEvidence: async (_path, record) => evidence.push(record) });
    assert.equal(launched, false);
    assert.equal(result.failureReason, 'initial_process_scope_invalid');
    assert.equal(evidence.length, 1);
  }
});

test('waits for reader and main to exit, command termination, and a bounded settle period', async () => {
  let tick = 0; let launched = false;
  const record = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, settleMs: 100, pollMs: 10,
    observe: async () => { tick++; return tick < 2 ? [mainRow, readerRow] : []; },
    launch: () => { launched = true; return { completion: Promise.resolve(0), release() {} }; },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
  assert.equal(launched, true);
  assert.equal(record.status, 'passed');
  assert.equal(record.settleCompleted, true);
});

test('fails when an old-main relauncher survives, and passes when it drains during settle', async () => {
  const relauncher = { ...mainRow, pid: 12, parentPid: 10, commandLine: 'electron.exe --type=relauncher' };
  const unrelated = { ...relauncher, pid: 99, parentPid: 1 };
  for (const [drain, expected] of [[false, 'old_process_alive'], [true, null]]) {
    let tick = 0;
    const result = await runVerification({ command: 'quit', ...paths, deadlineMs: 3000, settleMs: 50, pollMs: 10,
      observe: async () => { tick++; if (tick === 1) return [mainRow, readerRow, relauncher, unrelated]; return drain && tick >= 3 ? [unrelated] : [relauncher, unrelated]; },
      launch: () => ({ completion: Promise.resolve(0), release() {} }),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
    if (expected) assert.equal(result.status, 'failed');
    else assert.equal(result.status, 'passed');
  }
});

test('ignores an unrelated Electron relauncher while waiting for quit', async () => {
  const unrelated = { ...mainRow, pid: 99, parentPid: 1, commandLine: 'electron.exe --type=relauncher' };
  let tick = 0;
  const result = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, settleMs: 30, pollMs: 10,
    observe: async () => { tick++; return tick === 1 ? [mainRow, readerRow, unrelated] : [unrelated]; },
    launch: () => ({ completion: Promise.resolve(0), release() {} }), delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
  assert.equal(result.status, 'passed');
});

test('fails if replacement identity changes during the settle window', async () => {
  let tick = 0;
  const result = await runVerification({ command: 'restart', ...paths, deadlineMs: 1000, settleMs: 100, pollMs: 10,
    observe: async () => { tick++; const pid = tick < 5 ? 20 : 30; return tick === 1 ? [mainRow, readerRow] : [{ ...mainRow, pid }, { ...readerRow, pid: pid + 1, parentPid: pid }]; },
    launch: () => ({ completion: Promise.resolve(0), release() {} }), delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
  assert.equal(result.failureReason, 'duplicate_replacement');
});

test('detects a delayed duplicate during settle', async () => {
  let tick = 0;
  const record = await runVerification({ command: 'restart', ...paths, deadlineMs: 1000, settleMs: 100, pollMs: 10,
    observe: async () => { tick++; if (tick === 1) return [mainRow, readerRow]; if (tick < 4) return [{ ...mainRow, pid: 20 }, { ...readerRow, pid: 21, parentPid: 20 }]; return [{ ...mainRow, pid: 20 }, { ...readerRow, pid: 21, parentPid: 20 }, { ...mainRow, pid: 30 }, { ...readerRow, pid: 31, parentPid: 30 }]; },
    launch: () => ({ completion: Promise.resolve(0), release() {} }), delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
  assert.equal(record.failureReason, 'duplicate_replacement');
});

test('handles launch and observation failures with fixed evidence and releases the launch handle', async () => {
  let released = false;
  const failed = await runVerification({ command: 'quit', ...paths, observe: async () => [mainRow, readerRow],
    launch: () => { throw Error('sentinel-secret-should-not-escape'); }, writeEvidence: async () => {} });
  assert.equal(failed.failureReason, 'command_launch_failed');
  assert.doesNotMatch(JSON.stringify(failed), /sentinel-secret/);
  let observations = 0;
  const observeFailure = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, observe: async () => {
      if (observations++ === 0) return [mainRow, readerRow];
      throw Error('sentinel-secret-should-not-escape');
    }, launch: () => ({ completion: new Promise(() => {}), release() { released = true; } }), writeEvidence: async () => {} });
  assert.equal(observeFailure.failureReason, 'process_observation_failed');
  assert.equal(released, true);
  assert.doesNotMatch(JSON.stringify(observeFailure), /sentinel-secret/);
});

test('waits for command termination and classifies a nonzero result', async () => {
  let done;
  const record = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, settleMs: 10, pollMs: 10,
    observe: async () => [mainRow, readerRow], launch: () => ({ completion: new Promise((resolve) => { done = resolve; }), release() {} }),
    delay: async (ms) => { if (!done) return; done(9); await new Promise((resolve) => setTimeout(resolve, ms)); }, writeEvidence: async () => {} });
  assert.equal(record.commandExitCode, 9);
  assert.equal(record.failureReason, 'timeout');
});

test('times out the complete invocation, releases the owned launcher handle, and writes fixed evidence', async () => {
  let released = false; let saved; let observations = 0;
  const record = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, settleMs: 10, pollMs: 10,
    observe: async () => { observations++; if (observations === 2) await new Promise((resolve) => setTimeout(resolve, 1100)); return [mainRow, readerRow]; }, launch: () => ({ completion: new Promise(() => {}), release() { released = true; } }),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async (_path, evidence) => { saved = evidence; } });
  assert.equal(record.failureReason, 'timeout');
  assert.equal(released, true);
  assert.equal(saved.failureReason, 'timeout');
  assert.equal(observations, 2);
});

test('keeps a process query failure before the deadline distinct from timeout', async () => {
  const result = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, pollMs: 10,
    observe: async () => { throw Error('query-failed'); }, launch: () => ({ completion: new Promise(() => {}), release() {} }), writeEvidence: async () => {} });
  assert.equal(result.timedOut, false);
  assert.equal(result.failureReason, 'process_observation_failed');
});

test('reports owner receipt and outcome unavailable instead of treating launcher stdout as authority', async () => {
  const record = await runVerification({ command: 'quit', ...paths, deadlineMs: 1000, settleMs: 10, pollMs: 10, observe: async () => [mainRow, readerRow],
    launch: () => ({ completion: Promise.resolve(0), stdout: 'sentinel-secret [desktop-lifecycle] exit-initiated', release() {} }),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), writeEvidence: async () => {} });
  assert.deepEqual(record.ownerLifecycleEvidence, { status: 'unavailable', receipt: null, outcome: null });
  assert.doesNotMatch(JSON.stringify(record), /sentinel-secret/);
});

test('reports an evidence write failure with a fixed code', async () => {
  const result = await runVerification({ command: 'quit', ...paths, observe: async () => [mainRow, readerRow],
    launch: () => { throw Error('private-launch-error'); }, writeEvidence: async () => { throw Error('sentinel-secret'); } });
  assert.equal(result.failureReason, 'evidence_write_failed');
  assert.doesNotMatch(JSON.stringify(result), /sentinel-secret|private-launch-error/);
});

test('does not count a replacement reader owned by another process', () => {
  const result = classifyProcessObservations({ command: 'restart', oldMainPids: [10], oldReaderPids: [11],
    finalProcesses: [{ pid: 20, role: 'main' }, { pid: 21, parentPid: 99, role: 'reader' }], commandExitCode: 0, timedOut: false });
  assert.equal(result.failureReason, 'missing_reader');
  assert.deepEqual(result.replacementReaderPids, []);
});

test('classifies exact process outcomes with fixed codes', () => {
  const result = classifyProcessObservations({ command: 'restart', oldMainPids: [10], oldReaderPids: [11],
    finalProcesses: [{ pid: 20, role: 'main' }, { pid: 21, parentPid: 20, role: 'reader' }], commandExitCode: 0, timedOut: false });
  assert.equal(result.status, 'passed');
  assert.equal(classifyProcessObservations({ command: 'restart', oldMainPids: [10], oldReaderPids: [11], finalProcesses: [], commandExitCode: 0, timedOut: true }).failureReason, 'timeout');
});
