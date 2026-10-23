import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const nativeExe = process.argv[2];
if (!nativeExe) throw new Error('diagnostic_executable_required');
const bootstrapPath = path.join(process.env.LOCALAPPDATA, 'LineAgentAssistant', 'bootstrap.json');
const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'));
const ps = `Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $output=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($output))`;
const encodedPs = Buffer.from(ps, 'utf16le').toString('base64');
const decryptor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPs],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
const decryptedParts = [];
decryptor.stdout.on('data', (chunk) => decryptedParts.push(chunk));
decryptor.stdin.end(bootstrap.databaseUrlProtected);
const decryptCode = await new Promise((resolve, reject) => {
  decryptor.once('error', reject);
  decryptor.once('close', resolve);
});
if (decryptCode !== 0) throw new Error('bootstrap_unprotect_failed');
let databaseUrl = Buffer.from(Buffer.concat(decryptedParts).toString('utf8').trim(), 'base64').toString('utf8');
const require = createRequire('D:/LINEJS/node_modules/.audit-native-full-data-audit.cjs');
const { Client } = require('pg');
const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, application_name: 'linejs-native-full-data-audit' });
let ownMid;
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10s'");
  const result = await client.query("SELECT own_mid FROM line_accounts WHERE product_role = 'PRIMARY_ADMIN' AND own_mid IS NOT NULL");
  if (result.rows.length !== 1 || typeof result.rows[0].own_mid !== 'string') throw new Error('bound_mid_not_unique');
  ownMid = result.rows[0].own_mid;
  await client.query('ROLLBACK');
} catch {
  try { await client.query('ROLLBACK'); } catch {}
  throw new Error('readonly_bound_mid_lookup_failed');
} finally {
  try { await client.end(); } catch {}
  databaseUrl = undefined;
}

const tempRoot = os.tmpdir();
const copies = (await readdir(tempRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('linejs-native-audit-'));
if (copies.length < 1) throw new Error('retained_capture_missing');
const copyCandidates = await Promise.all(copies.map(async (entry) => ({
  path: path.join(tempRoot, entry.name), modified: (await stat(path.join(tempRoot, entry.name))).mtimeMs,
})));
copyCandidates.sort((left, right) => right.modified - left.modified);
const copyDirectory = copyCandidates[0].path;
const child = spawn(nativeExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
let stdout = '';
let ownMidSent = false;
let copyTokenSeen = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  while (stdout.includes('\n')) {
    const index = stdout.indexOf('\n');
    const line = stdout.slice(0, index).replace(/\r$/, '');
    stdout = stdout.slice(index + 1);
    if (line.startsWith('COPY_TOKEN|')) {
      copyTokenSeen = true;
      continue;
    }
    process.stdout.write(line + '\n');
  }
});
child.once('spawn', () => { child.stdin.write(ownMid + '\n' + copyDirectory + '\n'); ownMid = undefined; ownMidSent = true; });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (ownMidSent) child.stdin.write(chunk); });
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
if (stdout.trim()) process.stdout.write(stdout.trimEnd() + '\n');
if (copyTokenSeen) process.stdout.write('COPY_RETAINED|1\n');
process.stdout.write('RUNNER_EXIT|' + code + '\n');
