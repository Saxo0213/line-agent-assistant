import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_USER_MODEL_ID, DEFAULT_APP_ICON_FILE, resolveDefaultAppIcon } from './app-icon.js';

describe('default application icon', () => {
  it('uses the packaged application identity for Windows taskbar grouping', () => {
    expect(APP_USER_MODEL_ID).toBe('tw.lineagent.assistant');
    expect(APP_USER_MODEL_ID.length).toBeGreaterThan(0);
  });

  it('uses the spring light artwork selected for production', () => {
    expect(DEFAULT_APP_ICON_FILE).toBe('line-agent-spring.ico');
  });

  it('resolves from the desktop assets directory beside dist', () => {
    expect(resolveDefaultAppIcon(path.join('C:', 'repo', 'apps', 'desktop', 'dist')))
      .toBe(path.join('C:', 'repo', 'apps', 'desktop', 'assets', 'icons', 'line-agent-spring.ico'));
  });
});
