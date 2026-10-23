import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ChatFolderRow } from '@line-agent/database';

export const GROUPS_DIRECTORY = 'groups';
export const CHATS_DIRECTORY = 'chats';
export const CHAT_METADATA_FILE = '_chat.json';
const MAX_STAT_ENTRIES = 10_000;

export class ChatFolderError extends Error {
  readonly code = 'CHAT_FOLDER_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'ChatFolderError'; }
}

export interface ChatFolderStore {
  ensureChatFolder(accountId: string, chatType: string, chatId: string, createdBy: string): Promise<ChatFolderRow>;
}

/** `child` is strictly inside `parent` (never equal), compared on canonical paths. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The layer directory a chat folder lives in under the configured workspace. */
export function chatLayerDirectory(chatType: string): string {
  return chatType === 'direct' ? CHATS_DIRECTORY : GROUPS_DIRECTORY;
}

/**
 * Owns the per-chat Agent working directories: `<workspace>\groups\<folder_id>` (group/room) and
 * `<workspace>\chats\<folder_id>` (friend 1:1). The directory name is the folder_id, never a chat id or title.
 */
export class ChatFolderService {
  constructor(
    private readonly store: ChatFolderStore,
    private readonly workspace: { current(): Promise<string> },
  ) {}

  /**
   * Idempotently ensures the row and directory and returns the canonical path. The canonical path must stay under the
   * layer directory, which itself must stay under the workspace; any junction/symlink escape throws before a CLI starts.
   */
  async resolve(accountId: string, chatType: string, chatId: string, createdBy: string): Promise<{ folder: ChatFolderRow; path: string }> {
    const folder = await this.store.ensureChatFolder(accountId, chatType, chatId, createdBy);
    const root = await realpath(await this.workspace.current());
    const layer = join(root, chatLayerDirectory(chatType));
    let layerReal: string;
    let folderReal: string;
    try {
      await mkdir(layer, { recursive: true });
      layerReal = await realpath(layer);
      if (!isStrictlyInside(root, layerReal)) throw new ChatFolderError('The chat folder layer escapes the workspace.');
      const directory = join(layerReal, folder.folderId);
      await mkdir(directory, { recursive: true });
      folderReal = await realpath(directory);
      // Equality (not just containment) so groups\A can never be a junction to groups\B.
      if (!isStrictlyInside(layerReal, folderReal) || folderReal !== join(layerReal, folder.folderId)) {
        throw new ChatFolderError('The chat folder escapes its layer.');
      }
      if (!(await lstat(folderReal)).isDirectory()) throw new ChatFolderError('The chat folder is not a directory.');
    } catch (error) {
      throw error instanceof ChatFolderError ? error : new ChatFolderError('The chat folder could not be prepared.');
    }
    await this.writeMetadata(folderReal, folder).catch(() => undefined);
    return { folder, path: folderReal };
  }

  /** Read-only lookup for Settings: the validated path and usage, or nulls when the folder does not exist (yet). */
  async inspect(folder: Pick<ChatFolderRow, 'folderId' | 'chatType'>): Promise<{ path: string | null; fileCount: number; bytes: number }> {
    try {
      const root = await realpath(await this.workspace.current());
      const layer = await realpath(join(root, chatLayerDirectory(folder.chatType)));
      const directory = await realpath(join(layer, folder.folderId));
      if (!isStrictlyInside(root, layer) || !isStrictlyInside(layer, directory)) return { path: null, fileCount: 0, bytes: 0 };
      return { path: directory, ...await this.stats(directory) };
    } catch { return { path: null, fileCount: 0, bytes: 0 }; }
  }

  /** Metadata so the admin can tell folders apart; written via temp file + rename so a planted link is replaced, never followed. */
  private async writeMetadata(directory: string, folder: ChatFolderRow): Promise<void> {
    const body = `${JSON.stringify({
      accountId: folder.accountId,
      chatType: folder.chatType,
      chatIdHash: createHash('sha256').update(folder.chatId, 'utf8').digest('hex').slice(0, 16),
      title: folder.title,
    }, null, 2)}\n`;
    const target = join(directory, CHAT_METADATA_FILE);
    try { if ((await readFile(target, 'utf8')) === body) return; } catch { /* missing or unreadable: rewrite */ }
    const temporary = join(directory, `${CHAT_METADATA_FILE}.${process.pid}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'w' });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** Bounded, symlink-skipping size scan for the Settings list. */
  async stats(path: string): Promise<{ fileCount: number; bytes: number }> {
    let fileCount = 0;
    let bytes = 0;
    let visited = 0;
    const pending = [path];
    while (pending.length > 0 && visited < MAX_STAT_ENTRIES) {
      const directory = pending.pop()!;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited > MAX_STAT_ENTRIES) break;
        if (entry.isSymbolicLink()) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile()) {
          if (entry.name === CHAT_METADATA_FILE) continue;
          fileCount += 1;
          bytes += (await lstat(full).catch(() => undefined))?.size ?? 0;
        }
      }
    }
    return { fileCount, bytes };
  }
}
