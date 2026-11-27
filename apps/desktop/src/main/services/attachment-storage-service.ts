import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path, { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { Attachment, AttachmentStorageFolder, AttachmentStorageJob, AttachmentStorageRepository } from '@line-agent/database';
import { AttachmentStorageFolderError, singleCopyTarget } from '@line-agent/database';
import { CHAT_EXTRA_FOLDER_LIMIT, type ChatExtraFolderStatus, type WritableConversationKey } from '@line-agent/contracts';
import { buildAttachmentLocation, isUncRoot, sanitizeAttachmentFilename, storeAttachment, type AttachmentFilesystemSafetyBroker } from '@line-agent/line-worker/attachment-storage';
import { AttachmentClassifier, type ClassifierRunRequest } from './attachment-classifier.js';

type ActiveJob = { key: WritableConversationKey; controller: AbortController; promise: Promise<void> };
type ClaimRound = { excludedChatIds: ReadonlySet<string>; admission: Promise<void>; pending: boolean; resolveAdmission(): void };
const keyId = (key: WritableConversationKey) => JSON.stringify([key.accountId,key.chatType,key.chatId]);
const samePath = (a: string,b: string) => (process.platform === 'win32' ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b));
const inside = (parent: string, child: string) => { const rel=relative(parent,child); return rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const validRelative = (value: string) => !!value && !isAbsolute(value) && !value.includes('\\') && !value.includes(':') && value.split('/').every((part)=>!!part&&part!=='.'&&part!=='..');
const sourceError = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as {code:unknown}).code) : '';
  return /^[A-Z0-9_]{2,48}$/.test(code) ? code : 'COPY_FAILED';
};
/** The image types that the classifier can give to a model. */
const CLASSIFIER_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
/** A larger image is not given to the model. The classifier then uses the name and the text only. */
const CLASSIFIER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * `\\localhost\C$\dir` (also `127.0.0.1`, `::1` and this computer's name) is the local path `C:\dir`. Null for any other path.
 * Protected-folder and workspace checks use the local form, so an administrative share cannot reach a folder that a local path could not.
 */
export function localPathOfAdminShare(value: string): string | null {
  const match = /^\\\\([^\\]+)\\([A-Za-z])\$(?:\\(.*))?$/.exec(value.replaceAll('/', '\\'));
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== hostname().toLowerCase()) return null;
  return `${match[2]!.toUpperCase()}:\\${match[3] ?? ''}`;
}

export type SecondaryRootErrorCode = 'NOT_ABSOLUTE' | 'NOT_DIRECTORY' | 'REPARSE_POINT' | 'PROTECTED_FOLDER' | 'OTHER_CHAT_FOLDER' | 'ACCESS_DENIED' | 'UNREACHABLE' | 'FAILED';
export type FolderActionErrorCode = SecondaryRootErrorCode | 'DUPLICATE_FOLDER' | 'LIMIT_REACHED' | 'NOT_FOUND';
/** `count` is the number of classification folders after the change. `backfill` is true when the history copy started. */
export type FolderActionResult = { ok: true; count: number; root?: string; folderId?: string; backfill?: boolean } | { ok: false; code: FolderActionErrorCode };
export type SubfolderErrorCode = 'NO_DEFAULT_FOLDER' | 'INVALID_SUBFOLDER' | 'OUTSIDE_DEFAULT_FOLDER';
export type SubfolderActionResult = FolderActionResult | { ok: false; code: SubfolderErrorCode };
/** The parts of a relative subfolder path (`a` or `a/b`, `/` only), or null when one part is not a safe Windows folder name. */
function subfolderSegments(value: string): string[] | null {
  if (!value || value.length > 1024) return null;
  const parts = value.split('/');
  if (parts.length > 16) return null;
  for (const part of parts) {
    try { if (sanitizeAttachmentFilename(part) !== part) return null; } catch { return null; }
  }
  return parts;
}
/** A validation failure of an extra folder path. The code is stable; the message is for logs only. */
class SecondaryRootError extends Error {
  constructor(readonly code: Exclude<SecondaryRootErrorCode, 'FAILED'>, message: string) { super(message); }
}

export interface AttachmentStorageServiceOptions {
  repository: AttachmentStorageRepository;
  messages: Pick<import('@line-agent/database').MessageRepository, 'getAttachment'>;
  attachmentRoot: string;
  windowsSafetyBroker?: AttachmentFilesystemSafetyBroker;
  protectedPaths?: readonly string[];
  workspaceRoot?(): Promise<string | null>;
  ownChatWorkspaceFolder?(key: WritableConversationKey): Promise<string | null>;
  onError?(error: unknown): void;
  /**
   * The Agent classifier for a chat with 2 or more extra folders. Absent: a waiting attachment stays in the queue.
   * `run` makes one model run and resolves with the raw answer text.
   */
  classifier?: { run(request: ClassifierRunRequest): Promise<string>; onFailure?(error: unknown, info: { attempt: number; final: boolean }): void };
  /** App-managed directory for the image copies that the classifier gives to a model. Each copy is deleted after its run. */
  classifierDirectory?: string;
}

/** Durable, bounded secondary-copy and primary reclassification queue. */
export class AttachmentStorageService {
  private readonly active = new Set<ActiveJob>();
  private readonly admissions = new Set<Promise<unknown>>();
  private readonly pausedChats = new Map<string, WritableConversationKey>();
  private readonly claimRounds = new Set<ClaimRound>();
  private readonly lanes = new Map<string, Promise<string>>();
  private readonly classifier: AttachmentClassifier | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: AttachmentStorageServiceOptions) {
    this.classifier = options.classifier ? new AttachmentClassifier({ repository: options.repository, run: options.classifier.run,
      ...(options.classifier.onFailure ? { onFailure: options.classifier.onFailure } : {}),
      onCopyQueued: () => { void this.pump(); }, onError: (error) => this.options.onError?.(error) }) : null;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.pump(); void this.classifier?.tick(); }, 1_000);
    this.timer.unref?.();
    void this.trackAdmission(this.recoverQueues()).catch((error: unknown) => this.options.onError?.(error));
    void this.sweepClassifierDirectory();
    void this.pump();
  }

  /**
   * A ready attachment. Only a default folder, or only one classification folder: copy it there. No folder: nothing.
   * Otherwise (2 or more classification folders, or classification folders and a default folder): the classifier decides.
   */
  onPrimaryReady(key: WritableConversationKey, attachmentId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.trackAdmission((async () => {
      const folders = await this.options.repository.listFolders(key);
      if (folders.length === 0 || this.closed) return;
      const single = singleCopyTarget(folders);
      if (single) await this.options.repository.admitReadyAttachment(key, attachmentId, single.folderId);
      else {
        const earlier = await this.options.repository.getClassification(attachmentId);
        // A new file of an attachment that was decided before goes to the same folder again. A waiting one keeps its place.
        if (earlier?.status === 'decided' && earlier.folderId) await this.options.repository.admitReadyAttachment(key, attachmentId, earlier.folderId);
        else if (!earlier) await this.options.repository.enqueueClassification(key, attachmentId);
      }
      void this.pump();
      void this.classifier?.tick();
    })());
  }

  async executeFolderCommand(key: WritableConversationKey, _actor: string, command: import('./trigger-router.js').FolderCommand): Promise<string> {
    try {
      if (command.action === 'temp_show') {
        const status = await this.getStatus(key);
        if (status.folders.length === 0 && !status.defaultFolder) return '本聊天室尚未設定第二儲存位置';
        const progress = (entry: { queued: number; claimed: number; completed: number; failed: number }) =>
          `複製進度：佇列 ${entry.queued}、處理中 ${entry.claimed}、完成 ${entry.completed}、失敗 ${entry.failed}`;
        const lines = [`本聊天室第二儲存位置（分類資料夾 ${status.folders.length} 個）：`];
        if (status.defaultFolder) lines.push(`預設資料夾：${status.defaultFolder.root}`, progress(status.defaultFolder));
        status.folders.forEach((folder, index) => {
          lines.push(`${index + 1}. ${folder.root}${folder.description ? `：${folder.description}` : ''}`, progress(folder));
        });
        if (status.waitingClassification > 0) lines.push(`等待分類：${status.waitingClassification}`);
        return lines.join('\n');
      }
      if (command.action === 'temp_retry') {
        const count = await this.retryFailed(key);
        return count ? `已排入 ${count} 個失敗附件重試` : '目前沒有失敗的第二份附件';
      }
      if (command.action === 'temp_off') {
        const result = await this.removeAllFolders(key);
        return result.ok ? '已停用本聊天室第二儲存位置；既有檔案會保留' : '第二儲存位置設定失敗，請檢查資料夾後重試';
      }
      if (command.action !== 'temp_set') throw new Error('Invalid secondary folder command');
      const result = await this.addFolder(key, command.path);
      if (!result.ok) return result.code === 'LIMIT_REACHED' ? '第二儲存位置最多 10 個，請先移除一個' : result.code === 'DUPLICATE_FOLDER' ? '這個資料夾已經設定為第二儲存位置'
        : '第二儲存位置設定失敗，請檢查資料夾後重試';
      return result.backfill
        ? `已新增本聊天室第二儲存位置：${result.root}；歷史附件正在背景補複製`
        : `已新增本聊天室第二儲存位置：${result.root}（目前共 ${result.count} 個分類資料夾，新附件由 Agent 判斷放哪個資料夾）`;
    } catch (error) { this.options.onError?.(error); return '第二儲存位置設定失敗，請檢查資料夾後重試'; }
  }

  /** The extra folders of one chat, the progress of each copy queue, the attachments that wait for the classifier and the last decisions. */
  async getStatus(key: WritableConversationKey): Promise<ChatExtraFolderStatus> {
    const [folders, progress, waitingClassification, decisions] = await Promise.all([this.options.repository.listFolders(key),
      this.options.repository.getFolderProgress(key), this.options.repository.countWaitingClassifications(key), this.options.repository.listRecentClassifications(key, 10)]);
    const counts = (folderId: string) => { const entry = progress.get(folderId);
      return { queued: entry?.queued ?? 0, claimed: entry?.claimed ?? 0, completed: entry?.completed ?? 0, failed: entry?.failed ?? 0 }; };
    const fallback = folders.find((folder) => folder.kind === 'default');
    return {
      defaultFolder: fallback ? { folderId: fallback.folderId, root: fallback.root, ...counts(fallback.folderId) } : null,
      folders: folders.filter((folder) => folder.kind === 'classified').map((folder) => ({ folderId: folder.folderId, root: folder.root,
        description: folder.description, ...counts(folder.folderId) })),
      waitingClassification, decisions,
    };
  }

  /** The path of one extra folder of a chat, or null. */
  async getFolderRoot(key: WritableConversationKey, folderId: string): Promise<string | null> {
    return (await this.options.repository.listFolders(key)).find((folder) => folder.folderId === folderId)?.root ?? null;
  }

  /** Start the history copy when the single-folder rule applies to these folders. */
  private backfill(key: WritableConversationKey, folders: readonly AttachmentStorageFolder[]): boolean {
    const target = singleCopyTarget(folders);
    if (target) void this.trackAdmission(this.admitPages(key, target.folderId, 'secondary')).catch((error: unknown) => this.options.onError?.(error));
    return target !== null;
  }

  /** Check the path, then save it with `save`. Folder-rule refusals and path errors become result codes. */
  private saveFolder(key: WritableConversationKey, candidate: string,
    save: (root: string) => Promise<AttachmentStorageFolder[]>): Promise<FolderActionResult> {
    return this.inLane(key, () => this.saveFolderLocked(key, candidate, save));
  }

  /** `saveFolder` without the lane; the caller already holds the lane of this chat. */
  private async saveFolderLocked(key: WritableConversationKey, candidate: string,
    save: (root: string) => Promise<AttachmentStorageFolder[]>): Promise<FolderActionResult> {
    let root: string;
    try { root = await this.validateSecondaryRoot(candidate, key); }
    catch (error) {
      if (!(error instanceof SecondaryRootError)) this.options.onError?.(error);
      return { ok: false, code: error instanceof SecondaryRootError ? error.code : 'FAILED' };
    }
    try {
      const folders = await save(root);
      const saved = folders.find((folder) => samePath(folder.root, root));
      return { ok: true, count: folders.filter((folder) => folder.kind === 'classified').length, root, ...(saved ? { folderId: saved.folderId } : {}),
        backfill: this.backfill(key, folders) };
    } catch (error) {
      if (error instanceof AttachmentStorageFolderError) return { ok: false, code: error.code };
      this.options.onError?.(error);
      return { ok: false, code: 'FAILED' };
    }
  }

  /**
   * Add a classification folder that is a subfolder of the default folder of the chat (a whitelisted user's request). `relativePath` is
   * one name or `a/b` with `/` only; every part follows the attachment file name rules (no `..`, drive letter, reserved name, trailing dot
   * or space, invalid character). Missing parts are created one by one, and a part that is a link or junction is refused before anything
   * is created below it, so nothing is made outside the default folder. The result then passes the normal root checks and the same
   * limit and duplicate rules as `addFolder`.
   */
  addSubfolder(key: WritableConversationKey, relativePath: string, description = ''): Promise<SubfolderActionResult> {
    const text = description.trim();
    return this.inLane(key, async (): Promise<SubfolderActionResult> => {
      const segments = subfolderSegments(relativePath);
      if (!segments) return { ok: false, code: 'INVALID_SUBFOLDER' };
      try {
        const folders = await this.options.repository.listFolders(key);
        const base = folders.find((folder) => folder.kind === 'default');
        if (!base) return { ok: false, code: 'NO_DEFAULT_FOLDER' };
        if (folders.filter((folder) => folder.kind === 'classified').length >= CHAT_EXTRA_FOLDER_LIMIT) return { ok: false, code: 'LIMIT_REACHED' };
        let current = base.root;
        for (const segment of segments) {
          const next = path.join(current, segment);
          let info = await lstat(next).catch((error: unknown) => {
            if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'ENOENT') return null;
            throw this.rootFailure(error);
          });
          if (!info) {
            await mkdir(next).catch((error: unknown) => { throw this.rootFailure(error); });
            info = await lstat(next).catch((error: unknown) => { throw this.rootFailure(error); });
          }
          if (info.isSymbolicLink()) return { ok: false, code: 'OUTSIDE_DEFAULT_FOLDER' };
          if (!info.isDirectory()) return { ok: false, code: 'NOT_DIRECTORY' };
          current = next;
        }
        const [realBase, realTarget] = await Promise.all([realpath(base.root), realpath(current)]).catch((error: unknown) => { throw this.rootFailure(error); });
        if (!inside(realBase, realTarget) || samePath(realBase, realTarget)) return { ok: false, code: 'OUTSIDE_DEFAULT_FOLDER' };
        return await this.saveFolderLocked(key, current, async (root) => (await (text ? this.options.repository.addFolder(key, root, text) : this.options.repository.addFolder(key, root))).folders);
      } catch (error) {
        if (error instanceof SecondaryRootError) return { ok: false, code: error.code };
        this.options.onError?.(error);
        return { ok: false, code: 'FAILED' };
      }
    });
  }

  /** Add a classification folder (at most 10). When the single-folder rule applies after the change, the history is copied in the background. */
  addFolder(key: WritableConversationKey, candidate: string, description = ''): Promise<FolderActionResult> {
    const text = description.trim();
    return this.saveFolder(key, candidate, async (root) => (await (text ? this.options.repository.addFolder(key, root, text) : this.options.repository.addFolder(key, root))).folders);
  }

  /** The fixed attachment location (the primary root). It never changes with the extra folders. */
  get fixedLocation(): string { return this.options.attachmentRoot; }

  /** Set or replace the default folder. A replaced default folder stops receiving copies; its files stay. */
  setDefaultFolder(key: WritableConversationKey, candidate: string): Promise<FolderActionResult> {
    return this.saveFolder(key, candidate, async (root) => (await this.options.repository.setDefaultRoot(key, root)).folders);
  }

  /** Remove one folder of either kind. Its waiting copies stop; the files on disk stay. */
  removeFolder(key: WritableConversationKey, folderId: string): Promise<FolderActionResult> {
    return this.inLane(key, () => this.removeFoldersLocked(key, [folderId]));
  }

  /** Remove every extra folder of a chat (the LINE command `/folder temp off`). */
  removeAllFolders(key: WritableConversationKey): Promise<FolderActionResult> {
    return this.inLane(key, async () => this.removeFoldersLocked(key, (await this.options.repository.listFolders(key)).map((folder) => folder.folderId)));
  }

  private async removeFoldersLocked(key: WritableConversationKey, folderIds: readonly string[]): Promise<FolderActionResult> {
    const id = keyId(key);
    this.pausedChats.set(id, key);
    try {
      await this.cancelAndDrain(key);
      let remaining: AttachmentStorageFolder[] = [];
      for (const folderId of folderIds) remaining = (await this.options.repository.removeFolder(key, folderId)).remaining;
      return { ok: true, count: remaining.filter((folder) => folder.kind === 'classified').length, backfill: this.backfill(key, remaining) };
    } catch (error) {
      if (error instanceof AttachmentStorageFolderError) return { ok: false, code: error.code };
      this.options.onError?.(error);
      return { ok: false, code: 'FAILED' };
    } finally {
      this.pausedChats.delete(id);
      void this.pump();
    }
  }

  /** Save the description (0 to 200 characters, white space at both ends removed). */
  setFolderDescription(key: WritableConversationKey, folderId: string, description: string): Promise<FolderActionResult> {
    return this.inLane(key, async (): Promise<FolderActionResult> => {
      try {
        const saved = await this.options.repository.setFolderDescription(key, folderId, description.trim());
        return saved ? { ok: true, count: 0 } : { ok: false, code: 'NOT_FOUND' };
      } catch (error) { this.options.onError?.(error); return { ok: false, code: 'FAILED' }; }
    });
  }

  /** Queue the failed secondary copies of one chat again. Returns the count. */
  retryFailed(key: WritableConversationKey): Promise<number> {
    return this.inLane(key, async () => {
      const count = await this.options.repository.retryFailed(key);
      void this.pump();
      return count;
    });
  }

  /**
   * A private copy of an image for one classifier run, inside the classifier directory. The source is opened with the same
   * checks as a copy job. Null: no directory, a type that models cannot read, or an image over 20 MB. The caller deletes the copy.
   */
  async prepareClassifierImage(relativePath: string): Promise<{ path: string; cleanup(): Promise<void> } | null> {
    const directory = this.options.classifierDirectory;
    const extension = path.extname(relativePath).toLowerCase();
    if (!directory || !CLASSIFIER_IMAGE_EXTENSIONS.has(extension)) return null;
    const source = await this.openManagedSource(relativePath);
    try {
      if (source.size > CLASSIFIER_IMAGE_MAX_BYTES) return null;
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, `${randomUUID()}${extension}`);
      await writeFile(target, await source.handle.readFile(), { flag: 'wx' });
      return { path: target, cleanup: async () => { await unlink(target).catch(() => undefined); } };
    } finally { await source.handle.close().catch(() => undefined); }
  }

  /** Delete the image copies that a stopped app left. No run is active when the service starts. */
  private async sweepClassifierDirectory(): Promise<void> {
    const directory = this.options.classifierDirectory;
    if (!directory) return;
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) await unlink(path.join(directory, entry.name)).catch(() => undefined);
    } catch { /* The directory does not exist before the first image. */ }
  }

  private inLane<T>(key: WritableConversationKey, work: () => Promise<T>): Promise<T> {
    const id = keyId(key);
    const prior = this.lanes.get(id) ?? Promise.resolve('');
    const run = prior.then(work);
    const tail = run.then(() => '', () => '');
    this.lanes.set(id, tail);
    void tail.finally(() => { if (this.lanes.get(id) === tail) this.lanes.delete(id); });
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const job of this.active) job.controller.abort(new Error('Storage service stopping'));
    await Promise.allSettled([...this.active].map((job)=>job.promise));
    await this.pumping?.catch(()=>undefined);
    await this.classifier?.shutdown();
    while(this.admissions.size)await Promise.allSettled([...this.admissions]);
  }

  private trackAdmission<T>(task: Promise<T>): Promise<T> {
    this.admissions.add(task);
    void task.finally(()=>this.admissions.delete(task)).catch(()=>undefined);
    return task;
  }

  /**
   * A local absolute path or a network path `\\server\share\...`. A device path (`\\?\`, `\\.\`) and a network path without a share are refused.
   * A mapped drive letter is accepted here; the stored value is the real path (a network path when the drive is a network drive).
   */
  private assertRootShape(value: string): void {
    const normalized = value.replaceAll('/', '\\');
    if (!isAbsolute(value) || value.includes('\0') || (normalized.startsWith('\\\\') && !isUncRoot(value)))
      throw new SecondaryRootError('NOT_ABSOLUTE', 'Secondary root must be an absolute local or network directory');
  }

  /** Map a failed file system call to a result code: a missing path, no access, or a share that cannot be reached. */
  private rootFailure(error: unknown): unknown {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return new SecondaryRootError('NOT_DIRECTORY', 'Secondary root does not exist');
    if (code === 'EACCES' || code === 'EPERM') return new SecondaryRootError('ACCESS_DENIED', 'Secondary root cannot be accessed');
    if (['UNKNOWN', 'EIO', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EBUSY'].includes(code))
      return new SecondaryRootError('UNREACHABLE', 'Secondary root cannot be reached');
    return error;
  }

  /** Each part of the path, from the volume or share root down, must be a real directory (no link or junction). */
  private async assertPlainDirectories(target: string): Promise<void> {
    const statEntry = (value: string) => lstat(value).catch((error: unknown) => { throw this.rootFailure(error); });
    const rootInfo = await statEntry(target);
    if (rootInfo.isSymbolicLink()) throw new SecondaryRootError('REPARSE_POINT', 'Secondary root cannot be a link');
    if (!rootInfo.isDirectory()) throw new SecondaryRootError('NOT_DIRECTORY', 'Secondary root must be an existing real directory');
    let current = path.parse(target).root;
    for (const segment of target.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
      current = path.join(current,segment);
      const entry = await statEntry(current);
      if (entry.isSymbolicLink()) throw new SecondaryRootError('REPARSE_POINT', 'Secondary root cannot contain reparse points');
      if (!entry.isDirectory()) throw new SecondaryRootError('NOT_DIRECTORY', 'Secondary root path must contain only directories');
    }
  }

  private async validateSecondaryRoot(candidate: string,key: WritableConversationKey): Promise<string> {
    this.assertRootShape(candidate);
    const configured = resolve(candidate);
    await this.assertPlainDirectories(configured);
    const canonical = await realpath(configured).catch((error: unknown) => { throw this.rootFailure(error); });
    // The stored value is the real path. A mapped drive then becomes `\\server\share\...`, which does not depend on the drive letter being mapped.
    this.assertRootShape(canonical);
    if (!samePath(canonical,configured)) await this.assertPlainDirectories(canonical);
    // The administrative share of this computer (`\\localhost\C$\...`) is checked as the local path that it points to.
    const comparable = localPathOfAdminShare(canonical) ?? canonical;
    const protectedPaths = await Promise.all([this.options.attachmentRoot,...(this.options.protectedPaths ?? []),
      process.env.SystemRoot,process.env.WINDIR,process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.ProgramData,
      process.env.CommonProgramFiles,process.env['CommonProgramFiles(x86)']].filter((value): value is string => Boolean(value))
      .map(async (value)=>realpath(resolve(value)).catch(()=>resolve(value))));
    for (const protectedPath of protectedPaths) if (inside(protectedPath,comparable) || inside(comparable,protectedPath)) throw new SecondaryRootError('PROTECTED_FOLDER', 'Secondary root overlaps a protected system folder');
    const workspace = await this.options.workspaceRoot?.();
    if (workspace) {
      const canonicalWorkspace = await realpath(workspace).catch(()=>resolve(workspace));
      if (inside(canonicalWorkspace,comparable)) {
        const own = await this.options.ownChatWorkspaceFolder?.(key);
        if (!own) throw new SecondaryRootError('OTHER_CHAT_FOLDER', 'Secondary root cannot use another chat workspace folder');
        const ownCanonical = await realpath(own);
        if (!inside(ownCanonical,comparable)) throw new SecondaryRootError('OTHER_CHAT_FOLDER', 'Secondary root must stay in this chat workspace folder');
      }
    }
    return canonical;
  }

  private async cancelAndDrain(key: WritableConversationKey): Promise<void> {
    const id=keyId(key);
    for (;;) {
      // A claim request that started before this chat was paused may still
      // return one of its jobs. Wait until that result has been classified and
      // dispatched, but do not wait for copies belonging to other chats.
      const rounds=[...this.claimRounds].filter((round)=>round.pending&&!round.excludedChatIds.has(id));
      await Promise.all(rounds.map((round)=>round.admission));
      const jobs=[...this.active].filter((job)=>keyId(job.key)===id);
      for(const job of jobs)job.controller.abort(new Error('Extra storage folder removed'));
      await Promise.allSettled(jobs.map((job)=>job.promise));
      const hasRelevantRound=[...this.claimRounds].some((round)=>round.pending&&!round.excludedChatIds.has(id));
      if(!hasRelevantRound&&![...this.active].some((job)=>keyId(job.key)===id))return;
    }
  }

  private async recoverQueues(): Promise<void> {
    const chats=await this.options.repository.listRecoveryChats();
    for(const chat of chats){
      if(this.closed)return;
      const key=chat as WritableConversationKey;
      // The single-folder rule copies the history to its folder. With the classifier only new attachments are sorted, and they are already queued.
      const single=singleCopyTarget(await this.options.repository.listFolders(key));
      if(single)await this.admitPages(key,single.folderId,'secondary');
      if(key.chatType!=='direct')await this.admitPages(key,null,'reclassify');
    }
    await this.pump();
  }

  private async admitPages(key: WritableConversationKey,folderId: string|null,target: 'secondary'|'reclassify'): Promise<void> {
    let after: string|null=null;
    for(let page=0;page<100_000&&!this.closed;page+=1){
      const result=await this.options.repository.admitReadyPage(key,folderId,target,after,200);
      if(!result.selected||!result.lastAttachmentId||result.lastAttachmentId===after)break;
      after=result.lastAttachmentId;
      if(result.selected<200)break;
    }
  }

  private pump(): Promise<void> {
    if(this.closed)return Promise.resolve();
    if(this.pumping)return this.pumping;
    const run=(async()=>{
      while(!this.closed){
        const excluded=[...this.pausedChats.values()];
        let settleAdmission!:()=>void;
        const admission=new Promise<void>((resolve)=>{settleAdmission=resolve;});
        const round:ClaimRound={excludedChatIds:new Set(excluded.map(keyId)),admission,pending:true,resolveAdmission:()=>{
          if(!round.pending)return;
          round.pending=false;
          settleAdmission();
        }};
        this.claimRounds.add(round);
        try{
          const jobs=await this.options.repository.claimJobs(4,excluded);
          let pendingAdmissions=jobs.length;
          if(!pendingAdmissions)round.resolveAdmission();
          const admitted=()=>{pendingAdmissions-=1;if(pendingAdmissions===0)round.resolveAdmission();};
          const dispatched=jobs.map((job)=>this.runClaim(job,admitted));
          if(!jobs.length)break;
          await Promise.all(dispatched);
        }finally{
          round.resolveAdmission();
          this.claimRounds.delete(round);
        }
      }
    })().catch((error:unknown)=>this.options.onError?.(error)).finally(()=>{if(this.pumping===run)this.pumping=null;});
    this.pumping=run;
    return run;
  }

  private async runClaim(job: AttachmentStorageJob,onAdmission:()=>void=()=>undefined): Promise<void> {
    const key: WritableConversationKey={accountId:job.accountId,chatType:job.chatType,chatId:job.chatId};
    if(this.closed||this.pausedChats.has(keyId(key))){try{await this.options.repository.releaseClaim(job);}finally{onAdmission();}return;}
    const controller=new AbortController();
    const active: ActiveJob={key,controller,promise:Promise.resolve()};
    active.promise=this.copyClaim(job,controller.signal).catch(async(error:unknown)=>{
      await this.options.repository.failClaim(job,sourceError(error)).catch((writeError:unknown)=>this.options.onError?.(writeError));
    }).finally(()=>this.active.delete(active));
    this.active.add(active);
    onAdmission();
    await active.promise;
  }

  private async copyClaim(job: AttachmentStorageJob,signal: AbortSignal): Promise<void> {
    const key: WritableConversationKey={accountId:job.accountId,chatType:job.chatType,chatId:job.chatId};
    const attachment=await this.options.messages.getAttachment(job.attachmentId);
    if(signal.aborted)throw new Error('COPY_CANCELLED');
    if(!attachment||attachment.status!=='ready'||!attachment.relativePath||!attachment.sha256||attachment.sizeBytes===null)throw new Error('SOURCE_NOT_READY');
    // A secondary job copies to the folder it carries. A folder that no longer exists makes the job stale.
    const folder=job.targetKind==='secondary'?(await this.options.repository.listFolders(key)).find((entry)=>entry.folderId===job.folderId):undefined;
    if(job.targetKind==='secondary'&&!folder)throw new Error('FOLDER_STALE');
    const root=job.targetKind==='secondary'?folder!.root:this.options.attachmentRoot;
    const identity={accountId:attachment.accountId,chatType:job.chatType,chatId:attachment.chatId,messageId:attachment.messageId,externalAttachmentId:attachment.externalAttachmentId};
    const sender={id:attachment.senderId??'unknown',displayName:attachment.senderDisplayName??null};
    // An unnamed attachment keeps the file name it already has, so a copy keeps the extension chosen from its bytes.
    const storedName=attachment.relativePath.split('/').at(-1)??'';
    const originalFileName=attachment.name??(/^attachment\.(?:jpg|png|gif|webp)$/.test(storedName)?storedName:'attachment.bin');
    const target=buildAttachmentLocation({root,identity,occurredAt:attachment.occurredAt,originalFileName,sender,
      ...(job.targetKind==='secondary'?{layout:'secondary' as const}:{layout:'primary' as const})});
    const source=await this.openManagedSource(attachment.relativePath);
    try{
      const copied=await storeAttachment({root,identity,occurredAt:attachment.occurredAt,originalFileName,sender,
        ...(job.targetKind==='secondary'?{layout:'secondary' as const}:{layout:'primary' as const}),source:this.verifiedSource(source,attachment,signal),
        maxBytes:Math.max(attachment.sizeBytes,1),timeoutMs:120_000,signal},
        this.options.windowsSafetyBroker?{windowsSafetyBroker:this.options.windowsSafetyBroker}:{});
      if(copied.sha256!==attachment.sha256||copied.size!==attachment.sizeBytes)throw new Error('COPY_VERIFY_FAILED');
      if(signal.aborted)throw new Error('COPY_CANCELLED');
      const committed=await this.options.repository.completeClaim(job,attachment.relativePath,copied.managedRelativePath);
      if(!committed)throw new Error('FOLDER_STALE');
      if(job.targetKind==='reclassify'&&!samePath(source.path,target.absolutePath)){
        await source.handle.close();
        await this.removeExactOldPath(source,attachment.relativePath);
      }
    }finally{await source.handle.close().catch(()=>undefined);}
  }

  private async openManagedSource(relativePath: string): Promise<{handle:FileHandle;path:string;dev:number;ino:number;size:number;mtimeMs:number}> {
    if(!validRelative(relativePath))throw new Error('SOURCE_PATH_INVALID');
    const root=resolve(this.options.attachmentRoot),rootStat=await lstat(root),rootReal=await realpath(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('SOURCE_ROOT_INVALID');
    let current=rootReal;
    for(const segment of relativePath.split('/')){
      current=path.join(current,segment);
      const named=await lstat(current),canonical=await realpath(current),rel=relative(rootReal,canonical);
      if(named.isSymbolicLink()||!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('SOURCE_PATH_UNSAFE');
    }
    const handle=await open(current,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const held=await handle.stat(),named=await lstat(current);
      if(!held.isFile()||named.isSymbolicLink()||!named.isFile()||held.dev!==named.dev||held.ino!==named.ino||held.size!==named.size)throw new Error('SOURCE_IDENTITY_CHANGED');
      return{handle,path:current,dev:held.dev,ino:held.ino,size:held.size,mtimeMs:held.mtimeMs};
    }catch(error){await handle.close();throw error;}
  }

  private async *verifiedSource(source:{handle:FileHandle;path:string;dev:number;ino:number;size:number;mtimeMs:number},attachment:Attachment,signal:AbortSignal):AsyncIterable<Uint8Array>{
    if(source.size!==attachment.sizeBytes)throw new Error('SOURCE_SIZE_MISMATCH');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let position=0;
    while(position<source.size){
      if(signal.aborted)throw new Error('COPY_CANCELLED');
      const read=await source.handle.read(buffer,0,Math.min(buffer.length,source.size-position),position);
      if(read.bytesRead<=0)throw new Error('SOURCE_TRUNCATED');
      const chunk=Buffer.from(buffer.subarray(0,read.bytesRead));hash.update(chunk);position+=read.bytesRead;yield chunk;
    }
    const final=await source.handle.stat(),named=await lstat(source.path);
    if(!final.isFile()||final.dev!==source.dev||final.ino!==source.ino||final.size!==source.size||final.mtimeMs!==source.mtimeMs
      ||named.isSymbolicLink()||!named.isFile()||named.dev!==source.dev||named.ino!==source.ino||named.size!==source.size)throw new Error('SOURCE_IDENTITY_CHANGED');
    if(hash.digest('hex')!==attachment.sha256)throw new Error('SOURCE_HASH_MISMATCH');
  }

  private async removeExactOldPath(source:{path:string;dev:number;ino:number},relativePath:string):Promise<void>{
    if(!validRelative(relativePath))return;
    try{
      const stat=await lstat(source.path);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.dev===source.dev&&stat.ino===source.ino)await unlink(source.path);
      let directory=path.dirname(source.path);const root=resolve(this.options.attachmentRoot);
      while(directory!==root&&inside(root,directory)){
        await rmdir(directory).catch(()=>undefined);
        const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
      }
    }catch{/* A failed exact cleanup leaves the committed file readable at its new canonical path. */}
  }
}
