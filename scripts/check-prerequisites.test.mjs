import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('missing optional provider CLIs do not block core prerequisites', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-agent-prereq-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node.cmd'), '@echo off\r\nif "%1"=="--version" (echo v24.22.1) else (exit /b 0)\r\n');
  const env = {
    ...process.env,
    PATH: bin,
    TEST_DATABASE_URL: 'postgresql://line_agent_demo:line_agent_demo_only@127.0.0.1:55433/line_agent_demo',
    LINE_AGENT_ATTACHMENT_ROOT: path.join(root, 'attachments'),
    LINE_AGENT_WORKSPACE: path.join(root, 'workspace'),
  };
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const result = await execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1'), '-Demo'], { env });
  assert.match(result.stdout, /\[SKIP\] Codex CLI - optional provider is not installed/);
  assert.match(result.stdout, /\[SKIP\] Claude CLI - optional provider is not installed/);
  await assert.rejects(execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1'), '-Demo', '-RequireCodex'], { env }), /Command failed/);
});

test('development launcher forwards named switches for demo and production profiles', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-agent-dev-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'bin');
  await mkdir(scripts);
  await mkdir(bin);
  await writeFile(path.join(scripts, 'dev.ps1'), await readFile(path.join(repositoryRoot, 'scripts/dev.ps1'), 'utf8'));
  await writeFile(path.join(scripts, 'check-prerequisites.ps1'), [
    '[CmdletBinding()]',
    'param([switch]$Demo)',
    '"$($Demo.IsPresent),$env:DATABASE_URL" | Set-Content -LiteralPath $env:PREREQ_CAPTURE',
    'exit 0',
  ].join('\r\n'));
  await writeFile(path.join(bin, 'npm.cmd'), '@echo off\r\necho %*>>"%NPM_CAPTURE%"\r\nexit /b 0\r\n');
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const run = async (name, args, databaseUrl, testDatabaseUrl) => {
    const prerequisiteCapture = path.join(root, `${name}-prerequisite.txt`);
    const npmCapture = path.join(root, `${name}-npm.txt`);
    await execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'dev.ps1'), ...args], { env: {
      ...process.env,
      PATH: bin,
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      PREREQ_CAPTURE: prerequisiteCapture,
      NPM_CAPTURE: npmCapture,
    } });
    return {
      prerequisite: (await readFile(prerequisiteCapture, 'utf8')).trim(),
      npm: (await readFile(npmCapture, 'utf8')).trim().split(/\r?\n/),
    };
  };

  assert.deepEqual(await run('demo', ['-Demo'], '', 'postgresql://demo'), {
    prerequisite: 'True,postgresql://demo',
    npm: ['run build', 'run start --workspace @line-agent/desktop'],
  });
  assert.deepEqual(await run('production', [], 'postgresql://production', ''), {
    prerequisite: 'False,postgresql://production',
    npm: ['run build', 'run start --workspace @line-agent/desktop'],
  });
});

test('non-demo setup wizard prerequisites skip unset database and paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-agent-prereq-skip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node.cmd'), '@echo off\r\nif "%1"=="--version" (echo v24.22.1) else (exit /b 0)\r\n');
  const env = { ...process.env, PATH: bin, DATABASE_URL: '', MIGRATION_DATABASE_URL: '', LINE_AGENT_ATTACHMENT_ROOT: '', LINE_AGENT_WORKSPACE: '' };
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const result = await execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1')], { env });
  assert.match(result.stdout, /\[SKIP\] PostgreSQL URL - not set; the app setup wizard configures the database/);
  assert.match(result.stdout, /\[SKIP\] Attachment root - not set; chosen in the app setup wizard/);
  assert.match(result.stdout, /\[SKIP\] Workspace - not set; chosen in the app setup wizard/);
});

test('non-demo rejects demo credentials and demo requires both paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-agent-prereq-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node.cmd'), '@echo off\r\nif "%1"=="--version" (echo v24.22.1) else (exit /b 0)\r\n');
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const baseEnv = { ...process.env, PATH: bin, LINE_AGENT_ATTACHMENT_ROOT: '', LINE_AGENT_WORKSPACE: '' };
  await assert.rejects(execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1')], {
    env: { ...baseEnv, DATABASE_URL: 'postgresql://line_agent_demo:line_agent_demo_only@127.0.0.1:55433/line_agent_demo' },
  }), /Command failed/);
  await assert.rejects(execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1'), '-Demo'], {
    env: { ...baseEnv, TEST_DATABASE_URL: 'postgresql://line_agent_demo:line_agent_demo_only@127.0.0.1:55433/line_agent_demo' },
  }), /Command failed/);
});

test('Node.js check enforces patched minimums per release line', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'line-agent-prereq-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const cases = [
    ['v24.16.0', false], ['v24.22.0', false], ['v24.22.1', true],
    ['v22.23.3', false], ['v22.23.4', true],
    ['v26.12.0', false], ['v26.12.1', true],
    ['v25.9.0', false], ['v20.19.0', false], ['v28.0.0', true],
  ];
  for (const [version, pass] of cases) {
    const bin = path.join(root, `bin-${version}`);
    await mkdir(bin);
    await writeFile(path.join(bin, 'node.cmd'), `@echo off\r\nif "%1"=="--version" (echo ${version}) else (exit /b 0)\r\n`);
    const env = { ...process.env, PATH: bin, DATABASE_URL: '', MIGRATION_DATABASE_URL: '', LINE_AGENT_ATTACHMENT_ROOT: '', LINE_AGENT_WORKSPACE: '' };
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryRoot, 'scripts/check-prerequisites.ps1')];
    let stdout;
    if (pass) {
      stdout = (await execute(powershell, args, { env })).stdout;
    } else {
      const error = await execute(powershell, args, { env }).then(() => null, (caught) => caught);
      assert.ok(error, `${version} should exit non-zero`);
      stdout = error.stdout;
    }
    const expected = pass ? /\[PASS\] Node\.js/ : /\[FAIL\] Node\.js/;
    assert.match(stdout, expected, `${version}`);
  }
});
