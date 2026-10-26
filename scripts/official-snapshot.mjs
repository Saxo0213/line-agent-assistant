import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveRows } from './official-snapshot-live-rows.mjs';

// Runner for the retained official-database tool (docs/architecture/official-db-retained-capture-and-content-bridge.md).
//   node scripts/official-snapshot.mjs capture                  expected MID read-only from line_accounts, passed on stdin
//   node scripts/official-snapshot.mjs list
//   node scripts/official-snapshot.mjs analyze <captureId>
//   node scripts/official-snapshot.mjs correlate <captureId>    live rows read-only from LineJS PostgreSQL, piped on stdin
//   node scripts/official-snapshot.mjs delete <captureId>
// Build first: node apps/desktop/scripts/build-official-snapshot-tool.mjs
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(repo, 'apps', 'desktop', 'dist', 'official-snapshot-tool', 'OfficialSnapshotTool.exe');
const [command, ...rest] = process.argv.slice(2);
if (!command || !['capture', 'list', 'analyze', 'correlate', 'delete'].includes(command)) {
  throw new Error('Usage: node scripts/official-snapshot.mjs capture|list|analyze <captureId>|correlate <captureId>|delete <captureId> [--root <dir>]');
}

async function connectProduction() {
  const bootstrap = JSON.parse(await readFile(path.join(process.env.LOCALAPPDATA, 'LineAgentAssistant', 'bootstrap.json'), 'utf8'));
  const script = `Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $output=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($output))`;
  const decryptor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks = [];
  decryptor.stdout.on('data', (chunk) => chunks.push(chunk));
  decryptor.stdin.end(bootstrap.databaseUrlProtected);
  const code = await new Promise((resolve, reject) => { decryptor.once('error', reject); decryptor.once('close', resolve); });
  if (code !== 0) throw new Error('bootstrap_unprotect_failed');
  let databaseUrl = Buffer.from(Buffer.concat(chunks).toString('utf8').trim(), 'base64').toString('utf8');
  try {
    const require = createRequire(path.join(repo, 'apps', 'desktop', 'package.json'));
    const { Client } = require('pg');
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, application_name: 'linejs-official-snapshot' });
    await client.connect();
    return client;
  } finally { databaseUrl = undefined; }
}

function runExe(args, stdinData) {
  const child = spawn(exe, args, { stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'], windowsHide: true });
  if (stdinData !== undefined) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinData);
  }
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
}

if (command === 'list' || command === 'analyze' || command === 'delete') {
  const result = spawnSync(exe, [command, ...rest], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (command === 'capture') {
  const client = await connectProduction();
  let ownMid;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='10s'");
    const result = await client.query("SELECT own_mid FROM line_accounts WHERE product_role='PRIMARY_ADMIN' AND own_mid IS NOT NULL");
    if (result.rows.length !== 1 || typeof result.rows[0].own_mid !== 'string') throw new Error('bound_mid_not_unique');
    ownMid = result.rows[0].own_mid;
    await client.query('ROLLBACK');
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { await client.end(); }
  process.exitCode = await runExe([command, ...rest], `${ownMid}\n`);
  ownMid = undefined;
} else {
  const client = await connectProduction();
  let rows;
  try { rows = await fetchLiveRows(client); } finally { await client.end(); }
  process.stderr.write(`LIVE_ROWS|${rows.lines.length}|dropped=${rows.dropped}|truncated=${rows.truncated ? 1 : 0}\n`);
  process.exitCode = await runExe([command, ...rest], rows.lines.join(''));
}
