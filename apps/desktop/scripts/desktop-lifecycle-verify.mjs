import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024;
const FIXED_FAILURES = new Set(['timeout', 'old_process_alive', 'command_outcome_missing', 'command_failed', 'replacement_missing',
  'missing_reader', 'replacement_after_quit', 'duplicate_replacement', 'command_launch_failed', 'process_observation_failed', 'initial_process_scope_invalid', 'evidence_write_failed']);

export function identifyOwnedProcesses(rows, { executablePath, readerPath }) {
  const mainExe = resolve(executablePath).toLowerCase();
  const readerExe = resolve(readerPath).toLowerCase();
  const mains = rows.filter((row) => Number.isInteger(Number(row.pid)) && String(row.executablePath ?? '').toLowerCase() === mainExe &&
    !/--type\s*=/.test(String(row.commandLine ?? '')));
  const readers = rows.filter((row) => Number.isInteger(Number(row.pid)) && String(row.executablePath ?? '').toLowerCase() === readerExe);
  const relaunchers = rows.filter((row) => Number.isInteger(Number(row.pid)) && String(row.executablePath ?? '').toLowerCase() === mainExe &&
    /(?:^|\s)--type\s*=\s*relauncher(?:\s|$)/i.test(String(row.commandLine ?? '')));
  return [...mains.map((row) => ({ ...row, pid: Number(row.pid), role: 'main' })),
    ...readers.map((row) => ({ ...row, pid: Number(row.pid), role: 'reader' })),
    ...relaunchers.map((row) => ({ ...row, pid: Number(row.pid), role: 'relauncher' }))];
}

export function classifyProcessObservations({ command, oldMainPids, oldReaderPids, oldRelauncherPids = [], finalProcesses, commandExitCode, timedOut }) {
  const live = new Set(finalProcesses.map((row) => Number(row.pid)));
  const oldMainAlive = oldMainPids.some((pid) => live.has(Number(pid)));
  const oldReaderAlive = oldReaderPids.some((pid) => live.has(Number(pid)));
  const oldRelauncherAlive = oldRelauncherPids.some((pid) => live.has(Number(pid)));
  const mains = finalProcesses.filter((row) => row.role === 'main');
  const readers = finalProcesses.filter((row) => row.role === 'reader');
  const ownedReaders = readers.filter((row) => mains.some((main) => Number(main.pid) === Number(row.parentPid)));
  let failureReason = null;
  if (timedOut) failureReason = 'timeout';
  else if (oldMainAlive || oldReaderAlive || oldRelauncherAlive) failureReason = 'old_process_alive';
  else if (commandExitCode === null) failureReason = 'command_outcome_missing';
  else if (commandExitCode !== 0) failureReason = 'command_failed';
  else if (command === 'quit' && (mains.length || readers.length || finalProcesses.some((row) => row.role === 'relauncher'))) failureReason = 'replacement_after_quit';
  else if (command === 'restart' && mains.length > 1) failureReason = 'duplicate_replacement';
  else if (command === 'restart' && mains.length === 0) failureReason = 'replacement_missing';
  else if (command === 'restart' && readers.length > 1) failureReason = 'duplicate_replacement';
  else if (command === 'restart' && (mains.length !== 1 || ownedReaders.length !== 1)) failureReason = 'missing_reader';
  return { status: failureReason ? 'failed' : 'passed', failureReason, oldMainAlive, oldReaderAlive, oldRelauncherAlive,
    replacementMainPids: mains.map((row) => Number(row.pid)), replacementReaderPids: ownedReaders.map((row) => Number(row.pid)) };
}

async function observeProcesses(timeoutMs = 5_000) {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolveRows, reject) => {
    const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; let settled = false;
    const finish = (error, rows) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolveRows(rows); };
    const timer = setTimeout(() => { query.kill(); finish(new Error('process_observation_failed')); }, timeoutMs);
    query.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_OBSERVATION_BYTES) { query.kill(); finish(new Error('process_observation_failed')); }
    });
    query.once('error', () => finish(new Error('process_observation_failed')));
    query.once('close', (code) => {
      if (code !== 0) return finish(new Error('process_observation_failed'));
      try {
        const parsed = JSON.parse(output || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        finish(null, rows.map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), name: String(row.Name ?? ''),
          executablePath: String(row.ExecutablePath ?? ''), commandLine: String(row.CommandLine ?? '') })));
      } catch { finish(new Error('process_observation_failed')); }
    });
  });
}

function launchCommand(executablePath, workingDirectory, args, command) {
  const child = spawn(executablePath, [...args, `--${command}`], { cwd: workingDirectory, windowsHide: true, stdio: 'ignore' });
  let resolveCompletion;
  const completion = new Promise((resolveCode) => { resolveCompletion = resolveCode; });
  child.once('error', () => resolveCompletion(-1));
  child.once('close', (code) => resolveCompletion(Number.isInteger(code) ? code : -1));
  return { completion, release() { child.unref(); } };
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const writeEvidenceFile = async (path, record) => { const target = resolve(path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8'); };
async function writeEvidenceBounded(writeEvidence, path, result) {
  let timer;
  try {
    await Promise.race([writeEvidence(path, result), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('evidence_write_failed')), 5_000); })]);
    return true;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}

export async function runVerification({ command, executablePath, workingDirectory, readerPath = resolve(workingDirectory ?? '.', 'dist/js-external-reader/v1/ExternalReaderBridge.exe'),
  args = [], deadlineMs = 90_000, settleMs = 2_000, pollMs = 250, evidencePath = 'desktop-lifecycle-evidence.json',
  observe = observeProcesses, launch = () => launchCommand(executablePath, workingDirectory, args, command), delay: wait = delay, writeEvidence = writeEvidenceFile }) {
  if (!['quit', 'restart'].includes(command) || !executablePath || !workingDirectory || !Number.isFinite(deadlineMs) || deadlineMs < 1000 || deadlineMs > 300_000 ||
    !Number.isFinite(settleMs) || settleMs < 0 || settleMs > 10_000 || !Number.isFinite(pollMs) || pollMs < 10) throw new Error('invalid_verification_options');
  const startedAt = new Date().toISOString(); const deadline = Date.now() + deadlineMs;
  let commandExitCode = null; let timedOut = false; let failureReason = null; let handle; let settleCompleted = false;
  let before = []; let current = []; let replacementIdentity = null;
  const ownedRows = (rows, oldMainPids = []) => {
    const byPid = new Map(rows.map((row) => [Number(row.pid), row]));
    const identified = identifyOwnedProcesses(rows, { executablePath, readerPath });
    const ownedRelaunchers = identified.filter((row) => row.role === 'relauncher' && (() => {
      let parent = Number(row.parentPid); const visited = new Set();
      while (Number.isInteger(parent) && !visited.has(parent)) {
        if (oldMainPids.includes(parent)) return true;
        visited.add(parent); parent = Number(byPid.get(parent)?.parentPid);
      }
      return false;
    })());
    return [...identified.filter((row) => row.role !== 'relauncher'), ...ownedRelaunchers];
  };
  const validInventory = (rows) => Array.isArray(rows) && rows.every((row) => Number.isInteger(Number(row.pid)) && Number(row.pid) > 0 &&
    Number.isInteger(Number(row.parentPid)) && Number(row.parentPid) >= 0 && typeof row.executablePath === 'string' && typeof row.commandLine === 'string') &&
    new Set(rows.map((row) => Number(row.pid))).size === rows.length;
  const ownerLifecycleEvidence = { status: 'unavailable', receipt: null, outcome: null };
  const record = (classification = {}) => ({ startedAt, finishedAt: new Date().toISOString(), command,
    executablePath: resolve(executablePath), workingDirectory: resolve(workingDirectory), readerPath: resolve(readerPath),
    oldMainPids: before.filter((row) => row.role === 'main').map((row) => row.pid), oldReaderPids: before.filter((row) => row.role === 'reader').map((row) => row.pid),
    ownerLifecycleEvidence, commandExitCode, deadlineMs, settleMs, timedOut, settleCompleted, finalProcesses: current.map(({ pid, parentPid, name, executablePath: exe, role }) => ({ pid, parentPid, name, executablePath: exe, role })),
    ...classification, ...(failureReason ? { failureReason, status: 'failed' } : {}) });
  try {
    const initial = await observe(Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (!validInventory(initial)) throw new Error('process_observation_failed');
    const initialMains = identifyOwnedProcesses(initial, { executablePath, readerPath }).filter((row) => row.role === 'main');
    before = ownedRows(initial, initialMains.map((row) => row.pid));
    const initialReaders = before.filter((row) => row.role === 'reader');
    if (initialMains.length !== 1 || initialReaders.length !== 1 || Number(initialReaders[0]?.parentPid) !== initialMains[0]?.pid) {
      failureReason = 'initial_process_scope_invalid';
      const failed = record({ status: 'failed', oldMainAlive: false, oldReaderAlive: false, replacementMainPids: [], replacementReaderPids: [] });
      if (!await writeEvidenceBounded(writeEvidence, evidencePath, failed)) failed.failureReason = 'evidence_write_failed';
      return failed;
    }
    try { handle = await launch(); }
    catch { failureReason = 'command_launch_failed'; }
    if (!handle && !failureReason) failureReason = 'command_launch_failed';
    const commandCompletion = handle?.completion ?? Promise.resolve(null);
    let commandSettled = false;
    commandCompletion.then((code) => { commandSettled = true; commandExitCode = Number.isInteger(code) ? code : null; }, () => { commandSettled = true; commandExitCode = null; });
    let settledSince = null;
    while (!failureReason && Date.now() < deadline) {
      const observed = await observe(Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (!validInventory(observed)) { failureReason = 'process_observation_failed'; break; }
      current = ownedRows(observed, initialMains.map((row) => row.pid));
      const oldAlive = before.some((row) => current.some((seen) => seen.pid === row.pid));
      const newMains = current.filter((row) => row.role === 'main' && !before.some((old) => old.pid === row.pid));
      const newReaders = current.filter((row) => row.role === 'reader' && !before.some((old) => old.pid === row.pid));
      if (command === 'restart' && (newMains.length > 1 || newReaders.length > 1)) { failureReason = 'duplicate_replacement'; break; }
      const replacementReady = newMains.length === 1 && newReaders.length === 1 && Number(newReaders[0].parentPid) === newMains[0].pid &&
        !current.some((row) => row.role === 'relauncher');
      const candidateIdentity = replacementReady ? `${newMains[0].pid}:${newReaders[0].pid}` : null;
      if (replacementIdentity && candidateIdentity && replacementIdentity !== candidateIdentity) { failureReason = 'duplicate_replacement'; break; }
      if (candidateIdentity && !replacementIdentity) replacementIdentity = candidateIdentity;
      const processGoal = !oldAlive && (command === 'quit' ? current.length === 0 : replacementReady);
      if (processGoal && commandSettled) {
        settledSince ??= Date.now();
        if (Date.now() - settledSince >= settleMs) { settleCompleted = true; break; }
      } else settledSince = null;
      await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    if (Date.now() >= deadline) timedOut = true;
    if (!failureReason && !timedOut) {
      const observed = await observe(Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (!validInventory(observed)) failureReason = 'process_observation_failed';
      else current = ownedRows(observed, before.filter((row) => row.role === 'main').map((row) => row.pid));
      if (Date.now() >= deadline) timedOut = true;
      if (!failureReason && !timedOut && command === 'restart') {
        const mains = current.filter((row) => row.role === 'main'); const readers = current.filter((row) => row.role === 'reader');
        if (mains.length !== 1 || readers.length !== 1 || Number(readers[0].parentPid) !== mains[0]?.pid || current.some((row) => row.role === 'relauncher') ||
          replacementIdentity !== `${mains[0]?.pid}:${readers[0]?.pid}`) failureReason = 'duplicate_replacement';
      }
    }
  } catch {
    if (Date.now() >= deadline) timedOut = true;
    else failureReason = 'process_observation_failed';
  } finally {
    if (handle) { try { handle.release?.(); } catch { /* Fixed result is preserved; owned handle release was attempted. */ } }
  }
  if (!failureReason) {
    const classified = classifyProcessObservations({ command, oldMainPids: before.filter((row) => row.role === 'main').map((row) => row.pid),
      oldReaderPids: before.filter((row) => row.role === 'reader').map((row) => row.pid), oldRelauncherPids: before.filter((row) => row.role === 'relauncher').map((row) => row.pid), finalProcesses: current, commandExitCode, timedOut });
    failureReason = classified.failureReason;
    const result = record(classified);
    if (!await writeEvidenceBounded(writeEvidence, evidencePath, result)) { result.status = 'failed'; result.failureReason = 'evidence_write_failed'; }
    return result;
  }
  const result = record({ status: 'failed', oldMainAlive: before.some((row) => current.some((seen) => seen.pid === row.pid)),
    oldReaderAlive: before.some((row) => row.role === 'reader' && current.some((seen) => seen.pid === row.pid)), replacementMainPids: [], replacementReaderPids: [] });
  if (!await writeEvidenceBounded(writeEvidence, evidencePath, result)) result.failureReason = 'evidence_write_failed';
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).map((entry) => { const [key, ...value] = entry.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
  try {
    const result = await runVerification({ command: options.command, executablePath: options.exe, workingDirectory: options.cwd,
      readerPath: options.reader, args: options.args ? options.args.split('|') : [], deadlineMs: Number(options.deadline ?? 90_000),
      evidencePath: options.evidence ?? 'desktop-lifecycle-evidence.json' });
    process.stdout.write(`${result.status}${result.failureReason && FIXED_FAILURES.has(result.failureReason) ? ` ${result.failureReason}` : ''}\n`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch { process.stderr.write('invalid_verification_options\n'); process.exitCode = 2; }
}
