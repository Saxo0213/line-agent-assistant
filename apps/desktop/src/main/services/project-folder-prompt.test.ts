import { describe, expect, it } from 'vitest';
import { projectFolderPromptSection } from './project-folder-prompt.js';

describe('projectFolderPromptSection', () => {
  const dirs = [{ path: 'D:/a', writable: false }, { path: 'D:/b', writable: true }];
  it('is empty without folders and lists each folder with its mode', () => {
    expect(projectFolderPromptSection([])).toBe('');
    expect(projectFolderPromptSection(undefined)).toBe('');
    const text = projectFolderPromptSection(dirs);
    expect(text).toContain('- D:/a（唯讀）');
    expect(text).toContain('- D:/b（可讀寫）');
  });
  it('shows every folder read-only when the job cannot write at all (Codex own folder not writable)', () => {
    const text = projectFolderPromptSection(dirs, true);
    expect(text).toContain('- D:/b（唯讀）');
    expect(text).not.toContain('可讀寫');
  });
});
