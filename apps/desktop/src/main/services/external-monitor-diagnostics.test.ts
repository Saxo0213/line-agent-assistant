import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyExternalMonitorFailure,
  clearExternalMonitorDiagnostic,
  externalMonitorDatabaseFailure,
  externalMonitorFailureDetail,
  recordExternalMonitorDiagnostic,
} from './external-monitor-diagnostics.js';

describe('external monitor diagnostics', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('maps known authority and checkpoint failures to fixed safe codes', () => {
    expect(classifyExternalMonitorFailure(new Error('External source authority is stale'), 'startup'))
      .toBe('external_monitor_authority_stale');
    expect(classifyExternalMonitorFailure(new Error('Direct LINE source checkpoint or authority changed.'), 'runtime'))
      .toBe('external_monitor_checkpoint_changed');
    expect(classifyExternalMonitorFailure(new Error('reader_source_identity_changed'), 'startup'))
      .toBe('external_monitor_source_changed');
  });

  it('distinguishes known reader startup and runtime errors and hides unknown exception text', () => {
    expect(classifyExternalMonitorFailure(new Error('reader_handshake_invalid'), 'startup'))
      .toBe('external_monitor_reader_startup_failed');
    expect(classifyExternalMonitorFailure(new Error('reader_process_failed'), 'runtime'))
      .toBe('external_monitor_reader_failed');
    expect(classifyExternalMonitorFailure(new Error('C:\\private\\line.edb credential=do-not-store'), 'startup'))
      .toBe('external_monitor_unknown');
  });

  it('retains only allowlisted filesystem, source, and reader details', () => {
    const missingPath = Object.assign(new Error('C:\\private\\line.edb credential=hidden'), { code: 'ENOENT', path: 'C:\\private\\line.edb' });
    const deniedPath = Object.assign(new Error('private path and token=hidden'), { code: 'EACCES', path: 'C:\\private\\line.edb' });
    expect(classifyExternalMonitorFailure(missingPath, 'startup')).toBe('external_monitor_reader_startup_failed');
    expect(externalMonitorFailureDetail(missingPath)).toBe('node_enoent');
    expect(externalMonitorFailureDetail(deniedPath)).toBe('node_eacces');
    expect(externalMonitorFailureDetail(new Error('reader_source_identity_changed'))).toBe('reader_source_identity_changed');
    expect(externalMonitorFailureDetail(new Error('reader_source_unsupported:source_io_error'))).toBe('source_io_error');
    expect(externalMonitorFailureDetail(new Error('C:\\private\\line.edb token=hidden'))).toBeUndefined();
  });

  it('converts repository exceptions to a safe database category without retaining their text', () => {
    const failure = externalMonitorDatabaseFailure(new Error('postgres path C:\\secret\nSQL token=private'), 'runtime');
    expect(failure.code).toBe('external_monitor_database_failed');
    expect(failure.message).toBe('external_monitor_database_failed');
    expect(failure.stage).toBe('runtime');
    expect(classifyExternalMonitorFailure(failure, 'runtime')).toBe('external_monitor_database_failed');
  });

  it('atomically replaces one small local record with safe optional detail', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const file = join(root, 'monitor-failure.json');
    await recordExternalMonitorDiagnostic(file, 'startup', 'external_monitor_authority_stale');
    await recordExternalMonitorDiagnostic(file, 'runtime', 'external_monitor_reader_failed', 'node_eacces');

    const contents = await readFile(file, 'utf8');
    const record = JSON.parse(contents) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['code', 'createdAt', 'detail', 'stage', 'version']);
    expect(record).toMatchObject({ version: 1, stage: 'runtime', code: 'external_monitor_reader_failed', detail: 'node_eacces' });
    expect(typeof record.createdAt).toBe('string');
    expect(contents.length).toBeLessThanOrEqual(512);
    expect(contents).not.toMatch(/C:\\|credential|token=|postgres path|SQL/iu);
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toHaveLength(1);
  });

  it('persists only a fixed phase alongside the allowlisted failure category', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const file = join(root, 'monitor-failure.json');
    await recordExternalMonitorDiagnostic(file, 'startup', 'external_monitor_unknown', undefined, 'child_identity');
    const contents = await readFile(file, 'utf8');
    expect(JSON.parse(contents)).toMatchObject({ stage: 'startup', code: 'external_monitor_unknown', phase: 'child_identity' });
    expect(contents).not.toMatch(/path|token|stderr|private|secret/iu);
  });

  it('records distinct fixed producers for manual start and startup resume', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const manualFile = join(root, 'manual.json');
    const resumeFile = join(root, 'resume.json');
    await recordExternalMonitorDiagnostic(manualFile, 'startup', 'external_monitor_reader_startup_failed',
      undefined, 'owner_admission_marker', 'manual_start');
    await recordExternalMonitorDiagnostic(resumeFile, 'startup', 'external_monitor_reader_startup_failed',
      undefined, 'owner_admission_marker', 'startup_resume');
    expect(JSON.parse(await readFile(manualFile, 'utf8'))).toMatchObject({ producer: 'manual_start' });
    expect(JSON.parse(await readFile(resumeFile, 'utf8'))).toMatchObject({ producer: 'startup_resume' });
  });

  it('persists private directory preparation categories without command or path data', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const file = join(root, 'monitor-failure.json');
    await recordExternalMonitorDiagnostic(file, 'startup', 'external_monitor_reader_startup_failed',
      'private_directory_acl_command_timeout', 'private_directory_preparation');
    const contents = await readFile(file, 'utf8');
    expect(JSON.parse(contents)).toMatchObject({ stage: 'startup',
      code: 'external_monitor_reader_startup_failed', detail: 'private_directory_acl_command_timeout',
      phase: 'private_directory_preparation' });
    expect(contents).not.toMatch(/powershell|command text|C:\\|SID|credential|output/iu);
  });

  it('drops a stale failure record after a successful reader startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const file = join(root, 'monitor-failure.json');
    await recordExternalMonitorDiagnostic(file, 'startup', 'external_monitor_unknown');
    await clearExternalMonitorDiagnostic(file);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores diagnostic write failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'external-monitor-diagnostics-'));
    const parentFile = join(root, 'parent');
    await writeFile(parentFile, 'not a directory');
    await expect(recordExternalMonitorDiagnostic(join(parentFile, 'monitor-failure.json'), 'startup', 'external_monitor_unknown'))
      .resolves.toBeUndefined();
  });
});
