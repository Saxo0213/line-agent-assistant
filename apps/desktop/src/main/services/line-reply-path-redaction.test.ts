import { describe, expect, it } from 'vitest';
import { APP_DATA_LABEL, CHAT_WORKSPACE_LABEL, redactAppPaths } from './line-reply-path-redaction.js';

const DATA = 'C:\\Users\\user\\AppData\\Local\\LineAgentAssistant\\data';
const CHAT = `${DATA}\\agent-workspace\\groups\\0f8c2d4e-aaaa-bbbb-cccc-1234567890ab`;

describe('app paths in a LINE reply', () => {
  it('replaces the chat workspace path and keeps the relative rest', () => {
    expect(redactAppPaths(`本群專案資料夾是 ${CHAT}。`, { chatWorkspace: CHAT })).toBe(`本群專案資料夾是 ${CHAT_WORKSPACE_LABEL}。`);
    expect(redactAppPaths(`檔案在「${CHAT}\\notes\\a.txt」`, { chatWorkspace: CHAT })).toBe(`檔案在「${CHAT_WORKSPACE_LABEL}\\notes\\a.txt」`);
  });

  it('replaces any other app data path, also from another drive or user, even when the workspace is unknown', () => {
    expect(redactAppPaths(`看 ${CHAT}`)).toBe(`看 ${APP_DATA_LABEL}`);
    expect(redactAppPaths('log: D:/Users/bob/AppData/Local/LineAgentAssistant/logs/x.log (ok)')).toBe(`log: ${APP_DATA_LABEL} (ok)`);
    expect(redactAppPaths('root `E:\\Agent\\Work\\x.txt`', { appRoots: ['E:\\Agent\\Work'] })).toBe(`root \`${APP_DATA_LABEL}\``);
  });

  it('keeps the path of a bound project folder', () => {
    const nas = '\\\\nas\\projects\\HA\\dwg';
    const mapped = 'Z:\\projects\\HA\\dwg\\plan.dwg';
    const text = `專案資料夾：${mapped}，工作資料夾 ${CHAT}，NAS ${nas}`;
    expect(redactAppPaths(text, { chatWorkspace: CHAT })).toBe(`專案資料夾：${mapped}，工作資料夾 ${CHAT_WORKSPACE_LABEL}，NAS ${nas}`);
  });
});
