import { realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';

/**
 * Where a /folder project folder may live (docs/architecture/project-folders.md).
 * Every path is compared in its canonical form (`fs.realpath`: junctions and symlinks resolved), case-insensitively.
 */
export interface ProjectPathPolicy {
  /** Nothing equal to or below these may be bound (Windows directory, Program Files, ProgramData). */
  forbiddenTrees: readonly string[];
  /** Nothing equal to, below, or above these may be bound (app data, installation, the Agent workspace and its parents). */
  protectedPaths: readonly string[];
  /** The path itself and its parents are refused, its sub-folders are fine (the user profile root). */
  profileRoots: readonly string[];
  /** The Agent workspace; resolved per call because the operator can change it. Refused when equal, above or below. */
  workspace?: () => Promise<string | null>;
}

export type ProjectPathReason = 'not_absolute' | 'unsupported_chars' | 'not_found' | 'forbidden';
export type ProjectPathCheck = { ok: true; path: string } | { ok: false; reason: ProjectPathReason };

/** Characters that are glob / rule syntax in a Claude permission rule; a folder containing one cannot be protected reliably. */
export const PROJECT_PATH_UNSUPPORTED = /[()[\]{}*?!^#"`<>|\0\r\n]/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/;

const comparable = (path: string): string => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();
const isInside = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}\\`);

/** `\\?\C:\x` -> `C:\x`, `\\?\UNC\s\h\x` -> `\\s\h\x`. */
export function stripExtendedPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return /^\\\\\?\\[A-Za-z]:\\/.test(path) ? path.slice(4) : path;
}

async function canonicalOrSelf(path: string): Promise<string> {
  try { return stripExtendedPrefix(await realpath(path)); } catch { return path; }
}

/** The policy locations a default Windows install implies; `extra*` come from the running app. */
export function defaultProjectPathPolicy(options: {
  environment?: Record<string, string | undefined>;
  homeDirectory: string;
  protectedPaths?: readonly string[];
  workspace?: () => Promise<string | null>;
}): ProjectPathPolicy {
  const env = options.environment ?? process.env;
  const present = (...values: Array<string | undefined>): string[] => values.filter((value): value is string => !!value && DRIVE_PATH.test(value));
  return {
    forbiddenTrees: present(env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData),
    protectedPaths: [
      ...present(env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'LineAgentAssistant')),
      ...(options.protectedPaths ?? []),
    ],
    profileRoots: [options.homeDirectory],
    ...(options.workspace ? { workspace: options.workspace } : {}),
  };
}

/**
 * Validates and canonicalizes a user supplied project folder path. Used when a folder is bound and again every time an Agent job
 * starts (a folder that moved, vanished or now resolves into a forbidden place must not be mounted).
 */
export async function validateProjectFolderPath(raw: string, policy: ProjectPathPolicy): Promise<ProjectPathCheck> {
  const input = raw.trim();
  if (!input || input.length > 1000 || !(DRIVE_PATH.test(input) || UNC_PATH.test(input))) return { ok: false, reason: 'not_absolute' };
  if (/^[\\/]{2}[?.][\\/]/.test(input)) return { ok: false, reason: 'not_absolute' };
  let real: string;
  try {
    if (!(await stat(input)).isDirectory()) return { ok: false, reason: 'not_found' };
    real = stripExtendedPrefix(await realpath(input));
  } catch { return { ok: false, reason: 'not_found' }; }
  if (!(DRIVE_PATH.test(real) || UNC_PATH.test(real))) return { ok: false, reason: 'forbidden' };
  const target = comparable(real);
  // Drive root (`D:\`) and UNC share root (`\\server\share`).
  if (comparable(win32.parse(real).root) === target) return { ok: false, reason: 'forbidden' };
  for (const tree of policy.forbiddenTrees) {
    for (const candidate of new Set([comparable(tree), comparable(await canonicalOrSelf(tree))])) if (isInside(candidate, target)) return { ok: false, reason: 'forbidden' };
  }
  const workspace = policy.workspace ? await policy.workspace().catch(() => null) : null;
  for (const protectedPath of [...policy.protectedPaths, ...(workspace ? [workspace] : [])]) {
    for (const candidate of new Set([comparable(protectedPath), comparable(await canonicalOrSelf(protectedPath))])) {
      if (isInside(candidate, target) || isInside(target, candidate)) return { ok: false, reason: 'forbidden' };
    }
  }
  for (const root of policy.profileRoots) {
    for (const candidate of new Set([comparable(root), comparable(await canonicalOrSelf(root))])) if (isInside(target, candidate)) return { ok: false, reason: 'forbidden' };
  }
  // After the location rules, so a forbidden place such as `Program Files (x86)` is reported as forbidden.
  if (PROJECT_PATH_UNSUPPORTED.test(real)) return { ok: false, reason: 'unsupported_chars' };
  return { ok: true, path: real };
}
