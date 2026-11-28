import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-chat Agent rules (model: CliTalkAgent agent_workspace.rs).
 * Files of one chat folder: `AGENTS.md` (admin text, then one app-owned marker block), `CLAUDE.md` (one import line) and
 * `rules/<name>.md` (split rule files, copied into the marker block). The app rewrites only the block.
 */
export const RULES_BEGIN = '<!-- linejs:rules:begin -->';
export const RULES_END = '<!-- linejs:rules:end -->';
export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';
export const RULES_DIRECTORY = 'rules';
export const CLAUDE_IMPORT_LINE = '@AGENTS.md';
/** The Codex project-doc default. A write above this size is refused. */
export const AGENTS_MAX_BYTES = 32 * 1024;
export const RULE_NAME_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;
export const isValidRuleName = (name: string): boolean => RULE_NAME_PATTERN.test(name);

export type RulesFailure = 'marker' | 'too_large' | 'unsafe' | 'io';
export interface RuleFile { name: string; text: string; bytes: number }
export interface RulesState { agents: string | null; rules: RuleFile[]; rulesDirectory: boolean }
type Kind = 'none' | 'file' | 'dir' | 'other';

async function kindOf(path: string): Promise<Kind> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? 'other' : info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
}

const count = (text: string, part: string): number => text.split(part).length - 1;

export interface AgentsSplit { base: string; tail: string; hadBlock: boolean }

/**
 * Splits AGENTS.md into the admin text and the app block. A marker look-alike is refused (null): a marker that is not exactly one
 * ordered pair at the end of the file, because a pair in the middle is most likely an example the admin wrote.
 */
export function splitAgents(text: string): AgentsSplit | null {
  const begins = count(text, RULES_BEGIN);
  const ends = count(text, RULES_END);
  if (begins === 0 && ends === 0) return { base: text, tail: '', hadBlock: false };
  if (begins !== 1 || ends !== 1) return null;
  const start = text.indexOf(RULES_BEGIN);
  const end = text.indexOf(RULES_END);
  if (end < start) return null;
  const after = end + RULES_END.length;
  if (text.slice(after).trim() !== '') return null;
  return { base: text.slice(0, start), tail: text.slice(after), hadBlock: true };
}

export const hasMarker = (text: string): boolean => text.includes(RULES_BEGIN) || text.includes(RULES_END);

export function buildBlock(rules: readonly RuleFile[]): string {
  const sections = rules.map((rule) => `## ${rule.name}\n\n${rule.text.trim()}`);
  return `${RULES_BEGIN}\n${sections.join('\n\n')}\n${RULES_END}`;
}

/**
 * The new AGENTS.md text, or null when no file is needed. `newBase` replaces the admin text; undefined keeps it byte for byte.
 * `original` is returned unchanged when nothing has to change.
 */
export function composeAgents(original: string | null, split: AgentsSplit, newBase: string | undefined, rules: readonly RuleFile[]): string | null {
  const replaced = newBase !== undefined;
  const prefix = replaced ? (newBase.trim() === '' ? '' : `${newBase.trim()}\n`) : split.base;
  const hasBase = prefix.trim() !== '';
  if (rules.length === 0) {
    if (!split.hadBlock && !replaced) return original;
    return hasBase ? `${prefix.replace(/\s+$/, '')}\n` : null;
  }
  let head = prefix;
  if (!(split.hadBlock && !replaced)) {
    if (!hasBase) head = '';
    else if (!head.endsWith('\n\n')) head += head.endsWith('\n') ? '\n' : '\n\n';
  }
  return `${head}${buildBlock(rules)}${split.hadBlock ? split.tail : '\n'}`;
}

export const agentsTooLarge = (content: string | null): boolean => content !== null && Buffer.byteLength(content, 'utf8') > AGENTS_MAX_BYTES;

/** Reads AGENTS.md and rules/*.md. A link or a non-UTF-8 file is unsafe: nothing is read through it. */
export async function loadRulesState(directory: string): Promise<{ ok: true; state: RulesState } | { ok: false; reason: RulesFailure }> {
  try {
    const agentsPath = join(directory, AGENTS_FILE);
    const rulesPath = join(directory, RULES_DIRECTORY);
    const [agentsKind, rulesKind] = [await kindOf(agentsPath), await kindOf(rulesPath)];
    if (agentsKind === 'other' || agentsKind === 'dir' || rulesKind === 'other' || rulesKind === 'file') return { ok: false, reason: 'unsafe' };
    let agents: string | null = null;
    if (agentsKind === 'file') {
      const raw = await readFile(agentsPath);
      agents = raw.toString('utf8');
      if (!Buffer.from(agents, 'utf8').equals(raw)) return { ok: false, reason: 'unsafe' };
    }
    const rules: RuleFile[] = [];
    if (rulesKind === 'dir') {
      const names = (await readdir(rulesPath)).filter((entry) => entry.toLowerCase().endsWith('.md') && isValidRuleName(entry.slice(0, -3))).sort();
      for (const entry of names) {
        const path = join(rulesPath, entry);
        if (await kindOf(path) !== 'file') continue;
        const raw = await readFile(path);
        if (raw.byteLength > AGENTS_MAX_BYTES) return { ok: false, reason: 'too_large' };
        const text = raw.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(raw)) return { ok: false, reason: 'unsafe' };
        rules.push({ name: entry.slice(0, -3), text, bytes: raw.byteLength });
      }
    }
    return { ok: true, state: { agents, rules, rulesDirectory: rulesKind === 'dir' } };
  } catch { return { ok: false, reason: 'io' }; }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, data, 'utf8');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

/** Writes CLAUDE.md when it is absent or different. A link at that path is replaced, never followed. */
async function ensureClaudeFile(directory: string): Promise<void> {
  const path = join(directory, CLAUDE_FILE);
  const kind = await kindOf(path);
  if (kind === 'file') {
    try { if ((await readFile(path, 'utf8')).trim() === CLAUDE_IMPORT_LINE) return; } catch { /* rewrite */ }
  } else if (kind !== 'none') await rm(path, { recursive: true, force: true });
  await writeAtomic(path, `${CLAUDE_IMPORT_LINE}\n`);
}

async function removeClaudeFileIfOurs(directory: string): Promise<void> {
  const path = join(directory, CLAUDE_FILE);
  try { if (await kindOf(path) === 'file' && (await readFile(path, 'utf8')).trim() === CLAUDE_IMPORT_LINE) await rm(path, { force: true }); } catch { /* keep */ }
}

/** Best effort and never fatal: `git init -q` makes the chat folder its own Git root, like CliTalkAgent ensure_project_boundary. */
export async function ensureGitBoundary(directory: string, gitExecutable: string | undefined): Promise<void> {
  if (!gitExecutable) return;
  try {
    if (await kindOf(join(directory, '.git')) !== 'none') return;
    await new Promise<void>((resolve) => {
      execFile(gitExecutable, ['init', '-q'], { cwd: directory, windowsHide: true, timeout: 15_000 }, () => resolve());
    });
  } catch { /* the boundary is optional */ }
}

export type CommitInput = { rule?: { name: string; text: string } | { name: string; remove: true }; agents: string | null; original: string | null };

/** Writes the rule file change, AGENTS.md and CLAUDE.md. Callers have checked markers and the size already. */
export async function commitRulesState(directory: string, input: CommitInput, hasRules: boolean, gitExecutable: string | undefined): Promise<boolean> {
  try {
    const rulesPath = join(directory, RULES_DIRECTORY);
    if (input.rule && 'remove' in input.rule) {
      await rm(join(rulesPath, `${input.rule.name}.md`), { force: true });
      if (!hasRules) await rmdir(rulesPath).catch(() => undefined);
    } else if (input.rule) {
      await mkdir(rulesPath, { recursive: true });
      await writeAtomic(join(rulesPath, `${input.rule.name}.md`), `${input.rule.text.trim()}\n`);
    }
    const agentsPath = join(directory, AGENTS_FILE);
    if (input.agents === null) { if (input.original !== null) await rm(agentsPath, { force: true }); }
    else if (input.agents !== input.original) await writeAtomic(agentsPath, input.agents);
    if (input.agents !== null || hasRules) { await ensureClaudeFile(directory); await ensureGitBoundary(directory, gitExecutable); }
    else await removeClaudeFileIfOurs(directory);
    return true;
  } catch { return false; }
}

export type SyncResult = { ok: true; active: boolean; changed: boolean } | { ok: false; reason: RulesFailure };

/**
 * The start-of-job sync: CLAUDE.md, the marker block rebuilt from rules/*.md (sorted by name) and the Git boundary.
 * A folder without AGENTS.md and rules/ gets no file.
 */
export async function syncChatRules(directory: string, gitExecutable: string | undefined): Promise<SyncResult> {
  const loaded = await loadRulesState(directory);
  if (!loaded.ok) return loaded;
  const { state } = loaded;
  if (state.agents === null && !state.rulesDirectory) return { ok: true, active: false, changed: false };
  const split = splitAgents(state.agents ?? '');
  if (!split) return { ok: false, reason: 'marker' };
  const content = composeAgents(state.agents, split, undefined, state.rules);
  if (agentsTooLarge(content)) return { ok: false, reason: 'too_large' };
  const ok = await commitRulesState(directory, { agents: content, original: state.agents }, state.rules.length > 0, gitExecutable);
  return ok ? { ok: true, active: true, changed: content !== state.agents } : { ok: false, reason: 'io' };
}

// ---- Snapshot and restore of the protected files ----

type Entry = { t: 'file'; size: number; data?: Buffer } | { t: 'dir' } | { t: 'other' };
export type RulesSnapshot = Map<string, Entry>;
const MAX_SCAN_ENTRIES = 2000;
const MAX_KEPT_FILE_BYTES = 4 * 1024 * 1024;

async function scanEntry(directory: string, relative: string, into: RulesSnapshot, budget: { left: number }): Promise<void> {
  if (budget.left-- <= 0) return;
  const full = join(directory, ...relative.split('/'));
  let info;
  try { info = await lstat(full); } catch { return; }
  if (info.isSymbolicLink()) { into.set(relative, { t: 'other' }); return; }
  if (info.isDirectory()) {
    into.set(relative, { t: 'dir' });
    let names: string[] = [];
    try { names = (await readdir(full)).sort(); } catch { /* unreadable: kept as an empty directory */ }
    for (const name of names) await scanEntry(directory, `${relative}/${name}`, into, budget);
    return;
  }
  if (!info.isFile()) { into.set(relative, { t: 'other' }); return; }
  if (info.size > MAX_KEPT_FILE_BYTES) { into.set(relative, { t: 'file', size: info.size }); return; }
  try { into.set(relative, { t: 'file', size: info.size, data: await readFile(full) }); } catch { /* vanished */ }
}

/** Keeps the bytes of AGENTS.md, CLAUDE.md and rules/** in memory. */
export async function snapshotChatRules(directory: string): Promise<RulesSnapshot> {
  const snapshot: RulesSnapshot = new Map();
  const budget = { left: MAX_SCAN_ENTRIES };
  for (const relative of [AGENTS_FILE, CLAUDE_FILE, RULES_DIRECTORY]) await scanEntry(directory, relative, snapshot, budget);
  return snapshot;
}

export interface RestoreCounts { changed: number; added: number; removed: number }

const sameEntry = (before: Entry, now: Entry): boolean => {
  if (before.t !== now.t) return false;
  if (before.t === 'file' && now.t === 'file') return before.data && now.data ? before.data.equals(now.data) : before.size === now.size;
  return true;
};

/** Compares the current files with the snapshot and restores the kept state. Returns what it had to undo. */
export async function restoreChatRules(directory: string, snapshot: RulesSnapshot): Promise<RestoreCounts> {
  const now = await snapshotChatRules(directory);
  const counts: RestoreCounts = { changed: 0, added: 0, removed: 0 };
  const absolute = (relative: string) => join(directory, ...relative.split('/'));
  // Remove what the job added (parents first: a removed directory takes its children).
  for (const relative of [...now.keys()].sort()) {
    if (snapshot.has(relative)) continue;
    if (!(await kindOf(absolute(relative)).then((kind) => kind !== 'none', () => false))) continue;
    await rm(absolute(relative), { recursive: true, force: true }).catch(() => undefined);
    counts.added += 1;
  }
  // Recreate or rewrite what the job removed or changed (parents first).
  for (const relative of [...snapshot.keys()].sort()) {
    const before = snapshot.get(relative)!;
    const current = now.get(relative);
    if (before.t === 'other') continue;
    if (current && sameEntry(before, current)) continue;
    if (before.t === 'file' && !before.data) continue;
    const path = absolute(relative);
    if (current && current.t !== before.t) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    if (before.t === 'dir') await mkdir(path, { recursive: true }).catch(() => undefined);
    else {
      await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
      await writeFile(path, before.data!).catch(() => undefined);
    }
    if (current) counts.changed += 1; else counts.removed += 1;
  }
  return counts;
}
