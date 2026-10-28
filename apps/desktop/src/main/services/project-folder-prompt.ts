import type { AgentToolPolicy } from '@line-agent/contracts';

/**
 * The run-request prompt section naming the mounted /folder project folders and their mode
 * (docs/architecture/project-folders.md). Empty when none are mounted. The stored job prompt never carries it.
 */
export function projectFolderPromptSection(projectDirs: AgentToolPolicy['projectDirs'] | undefined, readOnlyOnly = false): string {
  if (!projectDirs || projectDirs.length === 0) return '';
  return [
    '',
    '',
    '專案資料夾（可用讀取工具查詢）：',
    ...projectDirs.map((dir) => `- ${dir.path}（${dir.writable && !readOnlyOnly ? '可讀寫' : '唯讀'}）`),
    '唯讀的專案資料夾只能查詢，不得建立、修改或刪除其中的檔案。',
  ].join('\n');
}
