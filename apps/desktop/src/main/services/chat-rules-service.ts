import type { ConversationKey } from '@line-agent/contracts';
import type { ChatFolderService } from './chat-folders.js';
import {
  AGENTS_MAX_BYTES, agentsTooLarge, commitRulesState, composeAgents, hasMarker, loadRulesState, restoreChatRules,
  snapshotChatRules, splitAgents, syncChatRules, type RestoreCounts, type RulesFailure, type RulesSnapshot,
} from './chat-rules-files.js';
import { linePrompt, type LinePromptKey } from './line-prompts.js';
import type { RulesCommand } from './trigger-router.js';

const BASE_PREVIEW_CHARS = 500;
const MAX_LISTED_FILES = 30;

export interface ChatRulesRestored extends RestoreCounts { jobId: string; accountId?: string }

export interface ChatRulesDependencies {
  folders: Pick<ChatFolderService, 'resolve'>;
  /** The Git executable found next to the Git Bash of the app, or undefined (then no Git boundary is made). */
  gitExecutable?: () => string | undefined;
  /** Called once per job whose protected files had to be restored. */
  onRestored?: (info: ChatRulesRestored) => void;
}

const FAILURE_TEXT: Record<RulesFailure, LinePromptKey> = {
  marker: 'rulesMarker', too_large: 'rulesTooLarge', unsafe: 'rulesUnsafe', io: 'rulesFailed',
};

/**
 * Per-chat Agent rules: the `/rules` command, the start-of-job sync of the rule files and the end-of-job protection of them.
 * One instance serves the LINE command path and the Agent job environment, so a /rules write and a job never undo each other.
 */
export class ChatRulesService {
  private readonly jobs = new Map<string, { directory: string; snapshot: RulesSnapshot; generation: number; accountId?: string }>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly dependencies: ChatRulesDependencies) {}

  private serialized<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(directory) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tails.set(directory, run.catch(() => undefined));
    return run;
  }

  /**
   * Start of a job in a chat folder: sync the files (CLAUDE.md, the marker block, the Git boundary) and, for a protected job,
   * keep the bytes of the rule files. A failed sync leaves the files as they are and never fails the job.
   */
  async begin(jobId: string, directory: string, options: { protect: boolean; accountId?: string }): Promise<void> {
    await this.serialized(directory, async () => {
      try { await syncChatRules(directory, this.dependencies.gitExecutable?.()); } catch { /* the job runs with the files as they are */ }
      if (!options.protect) return;
      try {
        this.jobs.set(jobId, { directory, snapshot: await snapshotChatRules(directory), generation: this.generations.get(directory) ?? 0,
          ...(options.accountId ? { accountId: options.accountId } : {}) });
      } catch { /* no snapshot: the Claude deny rules still apply */ }
    });
  }

  /** End of a job: undo every change a protected job made to AGENTS.md, CLAUDE.md or rules/**, then report it once. */
  async end(jobId: string): Promise<void> {
    const kept = this.jobs.get(jobId);
    if (!kept) return;
    this.jobs.delete(jobId);
    await this.serialized(kept.directory, async () => {
      // A /rules write during the job is the admin's change: it stays.
      if ((this.generations.get(kept.directory) ?? 0) !== kept.generation) return;
      const counts = await restoreChatRules(kept.directory, kept.snapshot);
      if (counts.changed + counts.added + counts.removed === 0) return;
      try { this.dependencies.onRestored?.({ jobId, ...(kept.accountId ? { accountId: kept.accountId } : {}), ...counts }); } catch { /* audit is best effort */ }
    });
  }

  /** The Primary Administrator's `/rules` in a group/room. Returns the reply text. */
  async execute(key: ConversationKey, command: RulesCommand, locale: string): Promise<string> {
    const text = (promptKey: LinePromptKey, params: { name?: string; text?: string } = {}) => linePrompt(locale, promptKey, params);
    if (command.action === 'usage') return text('rulesUsage');
    if (command.action === 'bad_name') return text('rulesBadName');
    const { path: directory } = await this.dependencies.folders.resolve(key.accountId, key.chatType, key.chatId, 'system:chat-rules');
    return this.serialized(directory, async () => {
      const loaded = await loadRulesState(directory);
      if (!loaded.ok) return text(FAILURE_TEXT[loaded.reason], { name: String(AGENTS_MAX_BYTES / 1024) });
      const { state } = loaded;
      const split = splitAgents(state.agents ?? '');
      if (command.action === 'show') {
        const base = (split ? split.base : state.agents ?? '').trim();
        const listed = state.rules.slice(0, MAX_LISTED_FILES).map((rule) => text('rulesFileItem', { name: rule.name, text: String(rule.bytes) }));
        const more = state.rules.length - listed.length;
        return text('rulesStatus', {
          text: base ? Array.from(base).slice(0, BASE_PREVIEW_CHARS).join('') + (Array.from(base).length > BASE_PREVIEW_CHARS ? '…' : '') : text('rulesBaseEmpty'),
          name: listed.length ? [...listed, ...(more > 0 ? [`+${more}`] : [])].join('\n') : text('rulesNone') });
      }
      if (!split) return text('rulesMarker');
      let rules = state.rules;
      let newBase: string | undefined;
      let rule: { name: string; text: string } | { name: string; remove: true } | undefined;
      let done = text('rulesFailed');
      if (command.action === 'set') {
        if (hasMarker(command.text)) return text('rulesMarker');
        newBase = command.text;
        done = text('rulesSet');
      } else if (command.action === 'clear') {
        newBase = '';
        done = text('rulesCleared');
      } else if (command.action === 'add') {
        if (hasMarker(command.text)) return text('rulesMarker');
        rule = { name: command.name, text: command.text };
        rules = [...rules.filter((item) => item.name.toLowerCase() !== command.name.toLowerCase()),
          { name: command.name, text: command.text, bytes: Buffer.byteLength(`${command.text.trim()}\n`, 'utf8') }]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        done = text('rulesAdded', { name: command.name });
      } else if (command.action === 'remove') {
        const existing = rules.find((item) => item.name.toLowerCase() === command.name.toLowerCase());
        if (!existing) return text('rulesRemoveMissing', { name: command.name });
        rule = { name: existing.name, remove: true };
        rules = rules.filter((item) => item !== existing);
        done = text('rulesRemoved', { name: existing.name });
      }
      const content = composeAgents(state.agents, split, newBase, rules);
      if (agentsTooLarge(content)) return text('rulesTooLarge', { name: String(AGENTS_MAX_BYTES / 1024) });
      const ok = await commitRulesState(directory, { agents: content, original: state.agents, ...(rule ? { rule } : {}) },
        rules.length > 0, this.dependencies.gitExecutable?.());
      // A running protected job must not undo this write.
      this.generations.set(directory, (this.generations.get(directory) ?? 0) + 1);
      return ok ? done : text('rulesFailed');
    });
  }
}
