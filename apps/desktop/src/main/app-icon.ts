import path from 'node:path';

export const DEFAULT_APP_ICON_FILE = 'line-agent-spring.ico';
export const APP_USER_MODEL_ID = 'tw.lineagent.assistant';

export function resolveDefaultAppIcon(mainDirectory: string): string {
  return path.resolve(mainDirectory, '..', 'assets', 'icons', DEFAULT_APP_ICON_FILE);
}
