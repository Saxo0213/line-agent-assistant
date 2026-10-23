import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideToolUse } from '../../../../../packages/contracts/src/agent-execution-policy.js';
import { resolveWritePathEvidence } from './write-path-evidence.js';

const roots: string[] = [];
async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'linejs-write-evidence-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('resolveWritePathEvidence', () => {
  it('resolves existing and not-yet-existing workspace files', async () => {
    const root = await tempRoot();
    const dir = join(root, 'workspace');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'existing.txt'), 'ok');
    const realRoot = await realpath(dir);
    const existing = await resolveWritePathEvidence(join(dir, 'docs', 'existing.txt'), dir);
    expect(existing).toEqual({ resolvedTarget: join(realRoot, 'docs', 'existing.txt'), resolvedWorkspaceRoot: realRoot });
    const future = await resolveWritePathEvidence(join(dir, 'docs', 'future.txt'), dir);
    expect(future).toEqual({ resolvedTarget: join(realRoot, 'docs', 'future.txt'), resolvedWorkspaceRoot: realRoot });
  });

  it('follows a workspace junction outside for existing and future targets', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'existing.txt'), 'outside');
    const link = join(workspace, 'linked');
    await symlink(outside, link, 'junction');
    const workspaceReal = await realpath(workspace);
    for (const targetPath of [join(link, 'existing.txt'), join(link, 'future.txt')]) {
      const evidence = await resolveWritePathEvidence(targetPath, workspace);
      expect(evidence?.resolvedTarget.startsWith(await realpath(outside))).toBe(true);
      expect(decideToolUse('workspace_write', [], 'operator', 'Write', { file_path: targetPath }, evidence)).toBe('ask');
    }
    expect(workspaceReal).not.toBe(await realpath(outside));
  });

  it('follows a file symlink outside when supported', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    await mkdir(workspace);
    await writeFile(outside, 'outside');
    const link = join(workspace, 'file.txt');
    try { await symlink(outside, link, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { console.info('Skipped file symlink case: OS denied symlink creation (EPERM)'); return; }
      throw error;
    }
    const evidence = await resolveWritePathEvidence(link, workspace);
    expect(evidence?.resolvedTarget).toBe(await realpath(outside));
  });

  it('rejects a dangling file symlink inside the workspace', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'missing-outside.txt');
    await mkdir(workspace);
    const link = join(workspace, 'dangling.txt');
    try { await symlink(outside, link, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { console.info('Skipped dangling file symlink case: OS denied symlink creation (EPERM)'); return; }
      throw error;
    }
    expect(await resolveWritePathEvidence(link, workspace)).toBeNull();
  });

  it('rejects a dangling workspace junction and targets beneath it', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'missing-outside-dir');
    await mkdir(workspace);
    const link = join(workspace, 'dangling-dir');
    try { await symlink(outside, link, 'junction'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { console.info('Skipped dangling junction case: OS denied junction creation (EPERM)'); return; }
      throw error;
    }
    expect(await resolveWritePathEvidence(join(link, 'target.txt'), workspace)).toBeNull();
  });

  it('keeps a missing multi-level tail under an existing workspace directory inside', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'existing'), { recursive: true });
    const target = join(workspace, 'existing', 'future', 'nested', 'file.txt');
    const evidence = await resolveWritePathEvidence(target, workspace);
    expect(evidence).toEqual({
      resolvedTarget: join(await realpath(join(workspace, 'existing')), 'future', 'nested', 'file.txt'),
      resolvedWorkspaceRoot: await realpath(workspace),
    });
  });

  it('rejects parent traversal and UNC paths', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    expect(await resolveWritePathEvidence(`${workspace}\\..\\outside`, workspace)).toBeNull();
    expect(await resolveWritePathEvidence('\\\\server\\share\\file.txt', workspace)).toBeNull();
  });
});
