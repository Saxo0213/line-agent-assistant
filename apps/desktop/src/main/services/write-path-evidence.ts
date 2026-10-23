import { realpath as realpathCallback } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { WritePathEvidence } from '@line-agent/contracts';

const MAX_SEGMENTS = 64;
const realpathNative = (path: string) => new Promise<string>((resolvePath, reject) => {
  realpathCallback.native(path, (error, resolved) => error ? reject(error) : resolvePath(resolved));
});

// Exported for P3 to call when write-tool authorization is wired into Main.
export async function resolveWritePathEvidence(targetPath: string, workspaceRoot: string): Promise<WritePathEvidence | null> {
  const rejectsSpecial = (value: string) => value.startsWith('\\\\') || value.startsWith('//');
  if (!isAbsolute(targetPath) || !isAbsolute(workspaceRoot) || rejectsSpecial(targetPath) || rejectsSpecial(workspaceRoot)) return null;
  if (targetPath.split(/[\\/]+/).includes('..') || workspaceRoot.split(/[\\/]+/).includes('..')) return null;

  try {
    const resolvedWorkspaceRoot = await realpathNative(workspaceRoot);
    let candidate = resolve(targetPath);
    const tail: string[] = [];
    for (let segments = 0; segments < MAX_SEGMENTS; segments++) {
      try {
        const resolved = await realpathNative(candidate);
        if (tail.length && !(await stat(resolved)).isDirectory()) return null;
        const resolvedTarget = tail.length ? join(resolved, ...tail.reverse()) : resolved;
        return { resolvedTarget, resolvedWorkspaceRoot };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        try {
          await lstat(candidate);
          return null;
        } catch (lstatError) {
          if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        }
        const parent = dirname(candidate);
        if (parent === candidate) return null;
        const segment = candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
        if (!segment || segment === '.' || segment === '..') return null;
        tail.push(segment);
        candidate = parent;
      }
    }
    return null;
  } catch {
    return null;
  }
}
