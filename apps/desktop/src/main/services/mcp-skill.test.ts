import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLinejsMcpSkill, MCP_SKILL_MAX_BYTES, withMcpSkill, withOutputChannel } from './mcp-skill.js';
import { resolveSkillsDirectory } from '../resources.js';

describe('app-owned LINEJS MCP Skill', () => {
  it('ships a secret-free Traditional Chinese Skill naming the read-only tools', async () => {
    const text = await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), ''));
    expect(text).toContain('list_targets');
    expect(text).toContain('query_target_messages_by_time');
    for (const needle of ['query_agent_room_history', '只在需要先前對話內容時才查', '先用關鍵字縮小範圍', '不要一頁一頁把紀錄全部讀完']) expect(text).toContain(needle);
    expect(text).toMatch(/[\u4e00-\u9fff]/);
    expect(text).not.toMatch(/li_job_|la_mcp_|Bearer|LINEJS_INTERNAL_MCP_TOKEN/);
  });
  it('ships the 總結 rules within the size limit', async () => {
    const text = await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), ''));
    expect(text).toContain('## 總結');
    for (const needle of ['範圍與對象', '決議／待辦', '未解問題', 'notes\\YYYY-MM-DD-<主題>.md', '輸出位置', '【標題】', '台灣時間']) expect(text).toContain(needle);
  });
  it('names chat types with the app words and states the Agent room is account-independent', async () => {
    const text = (await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), '')))!;
    for (const needle of ['個人（direct）', '群組（group）', '聊天室（room）', '社群（community）', '討論串（thread）', '一對一', '不屬於任何 LINE 帳號']) expect(text).toContain(needle);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MCP_SKILL_MAX_BYTES);
  });
  it('adds one channel line per source type', () => {
    expect(withOutputChannel('p', 'ui')).toBe('輸出位置：Agent 聊天室（可使用 Markdown）\n\np');
    expect(withOutputChannel('p', 'line')).toBe('輸出位置：LINE（只能用純文字，不要使用 Markdown）\n\np');
    expect(withOutputChannel('p', 'line').match(/輸出位置/g)).toHaveLength(1);
  });
  it('prepends exactly once and tolerates a missing or oversized Skill', async () => {
    expect(withMcpSkill('SKILL', 'prompt')).toBe('SKILL\n\n---\n\nprompt');
    expect(withMcpSkill(null, 'prompt')).toBe('prompt');
    const dir = await mkdtemp(path.join(tmpdir(), 'skill-'));
    try {
      expect(await loadLinejsMcpSkill(dir)).toBeNull();
      await mkdir(path.join(dir, 'linejs-mcp'));
      await writeFile(path.join(dir, 'linejs-mcp', 'SKILL.md'), 'x'.repeat(MCP_SKILL_MAX_BYTES + 1));
      expect(await loadLinejsMcpSkill(dir)).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('resolves packaged and development Skill directories', () => {
    expect(resolveSkillsDirectory(true, 'C:\app\dist', 'C:\res')).toBe(path.join('C:\res', 'skills'));
    expect(resolveSkillsDirectory(false, path.join('C:', 'repo', 'apps', 'desktop', 'dist'), 'C:\res')).toBe(path.join('C:', 'repo', 'skills'));
  });
});
