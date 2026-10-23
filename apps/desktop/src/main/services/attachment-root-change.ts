import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BootstrapConfiguration } from './bootstrap-settings.js';

type Settings = { root: string; load(): Promise<BootstrapConfiguration | null>; save(value: BootstrapConfiguration): Promise<void> };
type Selection = { id: string; path: string; expiresAt: number };

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relation = relative(parent, child);
    return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
  };
  return contains(left, right) || contains(right, left);
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Attachment folder must be an absolute path.');
  let component = resolve(path);
  for (;;) {
    let info;
    try { info = await lstat(component); }
    catch (cause) { throw new Error('Attachment folder does not exist or is inaccessible.', { cause }); }
    if (info.isSymbolicLink()) throw new Error('Attachment folder paths cannot include symbolic links or reparse points.');
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (cause) { throw new Error('Attachment folder does not exist or is inaccessible.', { cause }); }
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Attachment folder must be a regular directory without links.');
  return canonical;
}

async function inspectTree(path: string): Promise<Array<{ relativePath: string; directory: boolean; size: number }>> {
  const entries: Array<{ relativePath: string; directory: boolean; size: number }> = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Attachment folder contains a link or unsupported file.');
      const relativePath = prefix ? join(prefix, item.name) : item.name;
      entries.push({ relativePath, directory: info.isDirectory(), size: info.size });
      if (info.isDirectory()) await walk(full, relativePath);
    }
  }
  await walk(path, '');
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return entries;
}

export function createAttachmentRootChange(options: { settings: Settings; runCutover<T>(work: () => Promise<T>): Promise<T>;
  getAgentWorkspace(): Promise<string | null>; getAdditionalProtectedPaths?(configuration: BootstrapConfiguration): Promise<string[]>;
  pick(): Promise<string | null>; open(path: string): Promise<void> }) {
  const selections = new Map<string, Selection>();
  let moving = false;
  async function validateOwnershipPaths(configuration: BootstrapConfiguration, sourcePath: string, targetPath?: string): Promise<void> {
    const source = await canonicalDirectory(sourcePath);
    const bootstrapRoot = await canonicalDirectory(options.settings.root);
    const contains = (parent: string, child: string) => {
      const relation = relative(parent, child);
      return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
    };
    if (contains(source, bootstrapRoot)) throw new Error('The current attachment folder contains the application settings folder and cannot be moved.');
    const workspacePath = await options.getAgentWorkspace();
    if (workspacePath) {
      const workspace = await canonicalDirectory(workspacePath);
      if (overlaps(source, workspace)) throw new Error('The current attachment folder overlaps the Agent workspace and cannot be moved.');
      if (targetPath && overlaps(await canonicalDirectory(targetPath), workspace)) throw new Error('The new attachment folder cannot overlap the Agent workspace.');
    }
    for (const protectedPath of await options.getAdditionalProtectedPaths?.(configuration) ?? []) {
      const protectedDirectory = await canonicalDirectory(protectedPath);
      if (overlaps(source, protectedDirectory)) throw new Error('The current attachment folder overlaps the embedded database data and cannot be moved.');
      if (targetPath && overlaps(await canonicalDirectory(targetPath), protectedDirectory)) throw new Error('The new attachment folder cannot overlap the embedded database data.');
    }
  }
  return {
    async prepare(): Promise<{ id: string; path: string } | null> {
      const path = await options.pick();
      if (!path) return null;
      const configuration = await options.settings.load();
      if (!configuration) throw new Error('Database settings are not configured.');
      const source = await canonicalDirectory(configuration.attachmentRoot);
      const target = await canonicalDirectory(path);
      await validateOwnershipPaths(configuration, source, target);
      if (overlaps(source, target)) throw new Error('The new attachment folder cannot contain or be inside the current folder.');
      if ((await readdir(target)).length) throw new Error('Choose an empty attachment folder.');
      const selection = { id: randomUUID(), path: target, expiresAt: Date.now() + 5 * 60_000 };
      selections.clear();
      selections.set(selection.id, selection);
      return { id: selection.id, path: selection.path };
    },
    async move(selectionId: string): Promise<string> {
      const selection = selections.get(selectionId);
      selections.delete(selectionId);
      if (!selection || selection.expiresAt <= Date.now()) throw new Error('Attachment folder selection expired. Choose the folder again.');
      if (moving) throw new Error('Attachment folder move is already in progress.');
      moving = true;
      try {
        const beforeFence = await options.settings.load();
        if (!beforeFence) throw new Error('Database settings are not configured.');
        const selectedTarget = await canonicalDirectory(selection.path);
        await validateOwnershipPaths(beforeFence, beforeFence.attachmentRoot, selectedTarget);
        return await options.runCutover(async () => {
          const configuration = await options.settings.load();
          if (!configuration) throw new Error('Database settings are not configured.');
          const source = await canonicalDirectory(configuration.attachmentRoot);
          const target = await canonicalDirectory(selection.path);
          await validateOwnershipPaths(configuration, source, target);
          if (overlaps(source, target)) throw new Error('The new attachment folder cannot contain or be inside the current folder.');
          if ((await readdir(target)).length) throw new Error('The selected attachment folder is no longer empty.');
          const sourceEntries = await inspectTree(source);
          for (const entry of sourceEntries) {
            const destination = join(target, entry.relativePath);
            try {
              if (entry.directory) await mkdir(destination);
              else {
                await mkdir(dirname(destination), { recursive: true });
                await copyFile(join(source, entry.relativePath), destination, constants.COPYFILE_EXCL);
              }
            } catch (cause) {
              throw new Error('Attachment copy failed. The selected folder may contain partial files; clean it up before trying again.', { cause });
            }
          }
          const copiedEntries = await inspectTree(target);
          if (sourceEntries.length !== copiedEntries.length || sourceEntries.some((entry, index) => {
            const copied = copiedEntries[index];
            return !copied || entry.relativePath !== copied.relativePath || entry.directory !== copied.directory
              || (!entry.directory && entry.size !== copied.size);
          })) throw new Error('Attachment folder copy verification failed.');
          for (const entry of sourceEntries) if (!entry.directory) {
            const sourceBytes = await readFile(join(source, entry.relativePath));
            const targetBytes = await readFile(join(target, entry.relativePath));
            if (!sourceBytes.equals(targetBytes)) throw new Error('Attachment folder copy verification failed.');
          }
          await options.settings.save({ ...configuration, attachmentRoot: target });
          return target;
        });
      } finally { moving = false; }
    },
    async openCurrent(): Promise<void> {
      const configuration = await options.settings.load();
      if (!configuration) throw new Error('Database settings are not configured.');
      await options.open(await canonicalDirectory(configuration.attachmentRoot));
    },
  };
}
