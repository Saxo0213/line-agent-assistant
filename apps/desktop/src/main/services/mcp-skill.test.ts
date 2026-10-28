import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIdentityBlock, GROUP_MENTION_LINE, loadLinejsMcpSkill, MCP_SKILL_MAX_BYTES, withMcpSkill, withOutputChannel } from './mcp-skill.js';
import { resolveSkillsDirectory } from '../resources.js';
import { CREATE_SCHEDULE_TOOL_DEFINITION, UPDATE_SCHEDULE_TOOL_DEFINITION } from './mcp-service.js';

describe('app-owned LINEJS MCP Skill', () => {
  it('ships a secret-free Traditional Chinese Skill naming the read-only tools', async () => {
    const text = await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), ''));
    expect(text).toContain('list_targets');
    expect(text).toContain('query_target_messages_by_time');
    for (const needle of ['query_agent_room_history', '只在需要先前對話內容時才查', '先用關鍵字縮小範圍', '不要一頁一頁把紀錄全部讀完']) expect(text).toContain(needle);
    expect(text).toMatch(/[\u4e00-\u9fff]/);
    expect(text).not.toMatch(/li_job_|la_mcp_|Bearer|LINEJS_INTERNAL_MCP_TOKEN/);
  });
  it('tells the Agent to take schedule chats only from the current request', async () => {
    const text = (await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), '')))!;
    for (const needle of ['這次請求中指名聊天室', '不沿用先前對話中提過的', '沒指名聊天室就建立 `custom`', '`targets` 留空']) expect(text).toContain(needle);
  });
  it('tells the Agent to use a contact card mid as the send target', async () => {
    const text = (await loadLinejsMcpSkill(resolveSkillsDirectory(false, path.resolve(import.meta.dirname, '../..'), '')))!;
    for (const needle of ['[聯絡人卡片]', '`chatId` 等於該 mid', '不要改傳到其他聊天室']) expect(text).toContain(needle);
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

describe('schedule tool guidance', () => {
  it('create and update descriptions limit chats to the current request and send unnamed requests to a custom task', () => {
    const create = CREATE_SCHEDULE_TOOL_DEFINITION.description;
    for (const needle of ['only for chats the user names in the current request', 'never carry a chat over from earlier conversation', 'custom task whose prompt restates the request', 'leave targets empty']) expect(create).toContain(needle);
    expect(UPDATE_SCHEDULE_TOOL_DEFINITION.description).toContain('names in the current request');
    expect(UPDATE_SCHEDULE_TOOL_DEFINITION.description).toContain('custom task with the request as prompt and empty targets');
    expect(CREATE_SCHEDULE_TOOL_DEFINITION.inputSchema.properties.targets.description).toContain('never one carried over from earlier conversation');
  });
});

describe('identity block', () => {
  const agent = { accountId: 'acc-1', name: 'Agentsaxo' };
  const admin = { accountId: 'acc-1', chatId: 'uadmin', name: '徐佳誠' };

  it('LINE job in the administrator direct chat: the speaker is the administrator', () => {
    const block = formatIdentityBlock({ agent, admin, current: { accountId: 'acc-1', chatType: 'direct', chatId: 'uadmin', title: '徐佳誠', isAdmin: true } });
    expect(block).toMatchInlineSnapshot(`
      "【身分】
      Agent 帳號：Agentsaxo（accountId=acc-1）
      管理員（主要管理者）：徐佳誠；與 Agent 的私訊 accountId=acc-1，chatType=direct，chatId=uadmin
      目前對話：徐佳誠（accountId=acc-1，chatType=direct，chatId=uadmin）；目前對話者就是管理員
      「我／給我／管理員／主要管理者」都指上述管理員；要傳給他時直接用上述 key。"
    `);
    expect(block.length).toBeLessThanOrEqual(600);
  });

  it('LINE group job: names the group and does not claim the speaker is the administrator', () => {
    const block = formatIdentityBlock({ agent, admin, current: { accountId: 'acc-1', chatType: 'group', chatId: 'g1', title: '專案群', isAdmin: false } });
    expect(block).toMatchInlineSnapshot(`
      "【身分】
      Agent 帳號：Agentsaxo（accountId=acc-1）
      管理員（主要管理者）：徐佳誠；與 Agent 的私訊 accountId=acc-1，chatType=direct，chatId=uadmin
      目前對話：專案群（accountId=acc-1，chatType=group，chatId=g1）
      要指名回覆某位成員時，請寫 @成員名稱（名稱需與聊天紀錄顯示的一致），系統會轉成 LINE 標註；沒有對應成員時維持原文。
      「我／給我／管理員／主要管理者」都指上述管理員；要傳給他時直接用上述 key。"
    `);
    expect(block).not.toContain('目前對話者就是管理員');
  });

  it('group and room jobs name the asker and explain @name mentions; direct chats do not', () => {
    const current = { accountId: 'acc-1', chatType: 'group', chatId: 'g1', title: '專案群', isAdmin: false };
    const group = formatIdentityBlock({ agent, admin, current: { ...current, askerName: '小明' } });
    expect(group).toContain('提問者：小明');
    expect(group).toContain(GROUP_MENTION_LINE);
    expect(formatIdentityBlock({ agent, admin, current: { ...current, chatType: 'room' } })).toContain(GROUP_MENTION_LINE);
    expect(formatIdentityBlock({ agent, admin, current: { ...current, chatType: 'room' } })).not.toContain('提問者');
    const direct = formatIdentityBlock({ agent, admin, current: { ...current, chatType: 'direct', askerName: '小明' } });
    expect(direct).not.toContain('提問者');
    expect(direct).not.toContain(GROUP_MENTION_LINE);
  });

  it('Agent room job has no current-conversation line', () => {
    const block = formatIdentityBlock({ agent, admin, current: null });
    expect(block).toMatchInlineSnapshot(`
      "【身分】
      Agent 帳號：Agentsaxo（accountId=acc-1）
      管理員（主要管理者）：徐佳誠；與 Agent 的私訊 accountId=acc-1，chatType=direct，chatId=uadmin
      「我／給我／管理員／主要管理者」都指上述管理員；要傳給他時直接用上述 key。"
    `);
    expect(block).not.toContain('目前對話');
  });

  it('says so when no Primary Admin is linked, and never exceeds 800 characters', () => {
    expect(formatIdentityBlock({ agent, admin: null, current: null })).toContain('尚未連結主要管理者');
    const long = formatIdentityBlock({ agent: { accountId: 'a'.repeat(200), name: 'n'.repeat(200) }, admin: { accountId: 'b'.repeat(200), chatId: 'c'.repeat(200), name: 'm'.repeat(200) },
      current: { accountId: 'd'.repeat(200), chatType: 'group', chatId: 'e'.repeat(200), title: 't'.repeat(200), isAdmin: false } });
    expect(long.length).toBeLessThanOrEqual(800);
  });
});
