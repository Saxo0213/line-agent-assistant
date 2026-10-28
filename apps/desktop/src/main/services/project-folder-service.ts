import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { WritableConversationKey } from '@line-agent/contracts';
import { PROJECT_FOLDERS_PER_CHAT_MAX, type ProjectFolderMode, type ProjectFolderRepository } from '@line-agent/database';
import type { SystemTextInput, SystemTextResult } from './agent-line-send-service.js';
import { validateProjectFolderPath, type ProjectPathPolicy, type ProjectPathReason } from './project-folder-path.js';
import type { FolderCommand } from './trigger-router.js';

/** Audit principal of a /folder notice (the same kind of principal as system:free_mode). */
const PROJECT_FOLDER_AUDIT_PRINCIPAL = 'system:project_folder' as const;

const modeLabel = (mode: ProjectFolderMode): string => mode === 'READ_WRITE' ? '讀寫' : '唯讀';

export const PROJECT_FOLDER_TEXT = {
  bound: (path: string, mode: ProjectFolderMode) => `已綁定專案資料夾：${path}（${modeLabel(mode)}）`,
  updated: (path: string, mode: ProjectFolderMode) => `已更新專案資料夾：${path}（${modeLabel(mode)}）`,
  unchanged: (path: string, mode: ProjectFolderMode) => `專案資料夾已綁定：${path}（${modeLabel(mode)}）`,
  removed: (path: string) => `已解除專案資料夾：${path}`,
  removedAll: (count: number) => `已解除本聊天室全部專案資料夾（${count} 個）`,
  list: (rows: ReadonlyArray<{ path: string; mode: ProjectFolderMode }>) =>
    ['本聊天室的專案資料夾：', ...rows.map((row, index) => `${index + 1}. ${row.path}（${modeLabel(row.mode)}）`)].join('\n'),
  none: '本聊天室沒有綁定專案資料夾',
  notBound: '本聊天室沒有綁定這個資料夾',
  notFound: '路徑不存在或不是資料夾',
  notAbsolute: '請提供完整的絕對路徑，例如 D:\\公司\\專案',
  forbidden: '此路徑不允許綁定',
  unsupportedChars: '路徑含有不支援的字元：( ) [ ] { } * ? ! ^ # " ` < > |',
  limit: `每個聊天室最多綁定 ${PROJECT_FOLDERS_PER_CHAT_MAX} 個專案資料夾`,
  usage: '用法：/folder <絕對路徑>（唯讀）、/folder rw <絕對路徑>（讀寫）、/folder（列出）、/folder off [絕對路徑]（解除）',
  failed: '專案資料夾設定失敗，請稍後再試',
} as const;

const REASON_TEXT: Record<ProjectPathReason, string> = {
  not_absolute: PROJECT_FOLDER_TEXT.notAbsolute,
  unsupported_chars: PROJECT_FOLDER_TEXT.unsupportedChars,
  not_found: PROJECT_FOLDER_TEXT.notFound,
  forbidden: PROJECT_FOLDER_TEXT.forbidden,
};

export type ProjectFolderStore = Pick<ProjectFolderRepository, 'list' | 'bind' | 'unbind' | 'unbindAll' | 'recordSkipped'>;

export interface ProjectFolderServiceOptions {
  store: ProjectFolderStore;
  sendSystemText(input: SystemTextInput): Promise<SystemTextResult>;
  /** Evaluated on every bind and every job start. */
  policy: ProjectPathPolicy;
  onError?(error: unknown): void;
}

/** A bound folder that passed the job-start check: canonical, existing and still an allowed location. */
export interface ProjectFolderMount { path: string; mode: ProjectFolderMode }

const laneKey = (key: WritableConversationKey): string => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const same = (left: string, right: string): boolean => win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase() === win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();

/**
 * `/folder` for the Primary Administrator: binds company project folders to the chat the command is sent in
 * (docs/architecture/project-folders.md). Commands of one chat run in order.
 */
export class ProjectFolderService {
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ProjectFolderServiceOptions) {}

  handleCommand(key: WritableConversationKey, actor: string, command: FolderCommand): Promise<void> {
    const id = laneKey(key);
    const run = (this.lanes.get(id) ?? Promise.resolve()).then(async () => {
      let reply: string;
      try { reply = await this.execute(key, actor, command); }
      catch (error) { this.options.onError?.(error); reply = PROJECT_FOLDER_TEXT.failed; }
      await this.notify(key, reply);
    }).catch((error: unknown) => this.options.onError?.(error));
    this.lanes.set(id, run);
    void run.finally(() => { if (this.lanes.get(id) === run) this.lanes.delete(id); });
    return run;
  }

  /**
   * The folders to mount for a job of this chat, checked again now. A folder that is gone, moved (its canonical path changed)
   * or no longer allowed is left out and audited; the job itself never fails because of it.
   */
  async resolveMounts(chat: { accountId: string; chatType: string; chatId: string }): Promise<ProjectFolderMount[]> {
    if (chat.chatType !== 'direct' && chat.chatType !== 'group' && chat.chatType !== 'room') return [];
    const key: WritableConversationKey = { accountId: chat.accountId, chatType: chat.chatType, chatId: chat.chatId };
    const rows = await this.options.store.list(key);
    const mounts: ProjectFolderMount[] = [];
    for (const row of rows) {
      const check = await validateProjectFolderPath(row.path, this.options.policy);
      if (check.ok && check.path === row.path) { mounts.push({ path: row.path, mode: row.mode }); continue; }
      const reason = check.ok ? 'path_changed' : check.reason;
      await this.options.store.recordSkipped(key, row.path, reason).catch((error: unknown) => this.options.onError?.(error));
    }
    return mounts;
  }

  private async execute(key: WritableConversationKey, actor: string, command: FolderCommand): Promise<string> {
    const store = this.options.store;
    switch (command.action) {
      case 'usage': return PROJECT_FOLDER_TEXT.usage;
      case 'list': {
        const rows = await store.list(key);
        return rows.length === 0 ? PROJECT_FOLDER_TEXT.none : PROJECT_FOLDER_TEXT.list(rows);
      }
      case 'bind': {
        const check = await validateProjectFolderPath(command.path, this.options.policy);
        if (!check.ok) return REASON_TEXT[check.reason];
        const result = await store.bind(key, check.path, command.mode, actor);
        if (result.status === 'limit') return PROJECT_FOLDER_TEXT.limit;
        return PROJECT_FOLDER_TEXT[result.status === 'created' ? 'bound' : result.status](result.row.path, result.row.mode);
      }
      case 'off': {
        if (command.path === null) {
          const removed = await store.unbindAll(key, actor);
          return removed.length === 0 ? PROJECT_FOLDER_TEXT.none : PROJECT_FOLDER_TEXT.removedAll(removed.length);
        }
        const rows = await store.list(key);
        // The folder may be gone from disk already, so also match the typed text against the stored paths.
        const canonical = await validateProjectFolderPath(command.path, this.options.policy);
        const target = rows.find((row) => same(row.path, command.path!) || (canonical.ok && same(row.path, canonical.path)));
        if (!target) return rows.length === 0 ? PROJECT_FOLDER_TEXT.none : PROJECT_FOLDER_TEXT.notBound;
        await store.unbind(key, target.path, actor);
        return PROJECT_FOLDER_TEXT.removed(target.path);
      }
    }
  }

  private async notify(key: WritableConversationKey, text: string): Promise<void> {
    try {
      await this.options.sendSystemText({ runId: randomUUID(), principalId: PROJECT_FOLDER_AUDIT_PRINCIPAL,
        target: { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId }, text });
    } catch (error) { this.options.onError?.(error); }
  }
}
