import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { gitBashPath } from '@line-agent/agent-bridge';

/**
 * The Git executable that sits next to the Git Bash the app already finds for Claude (`<root>\bin\bash.exe` gives `<root>\cmd\git.exe`).
 * Undefined when Git Bash or that file is missing: the chat folder then gets no Git boundary.
 */
export function findGitExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
  const bash = gitBashPath(environment, isFile);
  if (!bash) return undefined;
  const root = win32.dirname(win32.dirname(bash));
  return [win32.join(root, 'cmd', 'git.exe'), win32.join(root, 'bin', 'git.exe')].find(isFile);
}
