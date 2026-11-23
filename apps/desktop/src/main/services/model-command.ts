import { isValidCodexModel } from '@line-agent/agent-bridge';

/** `/model` (CliTalkAgent discord_model_command_reply, model.rs normalize_model_for_provider): a chat's model for its Agent provider. */
export type ModelProvider = 'claude' | 'codex';
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus';

export type ModelCommand =
  | { action: 'show' }
  | { action: 'clear' }
  | { action: 'argument'; value: string };

/** Normalizes the text after `/model`: empty shows, default/reset/預設 clears, anything else is the trimmed argument. */
export function normalizeModelArgument(argument: string): ModelCommand {
  const trimmed = argument.trim();
  if (trimmed === '') return { action: 'show' };
  const lower = trimmed.toLowerCase();
  if (lower === 'default' || lower === 'reset' || trimmed === '預設') return { action: 'clear' };
  return { action: 'argument', value: trimmed };
}

/** Parses a trimmed chat text that is `/model` or `/model <argument>`; null for any other text. */
export function parseModelCommand(text: string): ModelCommand | null {
  const match = /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? normalizeModelArgument(match[1] ?? '') : null;
}

export type ModelNormalization = { ok: true; model: string } | { ok: false; error: string };

/** CliTalkAgent normalize_model_for_provider: Claude takes haiku/sonnet/opus (stored lowercase); Codex takes a model ID (isValidCodexModel is the model.rs rule). */
export function normalizeModelForProvider(provider: ModelProvider, value: string): ModelNormalization {
  const trimmed = value.trim();
  if (provider === 'claude') {
    const lower = trimmed.toLowerCase();
    return lower === 'haiku' || lower === 'sonnet' || lower === 'opus'
      ? { ok: true, model: lower } : { ok: false, error: 'unknown Claude model (use haiku / sonnet / opus / default)' };
  }
  return isValidCodexModel(trimmed) ? { ok: true, model: trimmed }
    : { ok: false, error: 'invalid Codex model ID (use letters, numbers, . _ : / -; max 128 characters)' };
}

/** Plain-text reply for LINE (no Markdown). `current` is the stored model before the command; `result` is the normalization of a set argument. */
export function modelReply(provider: ModelProvider, command: ModelCommand, current: string | null, result?: ModelNormalization): string {
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  switch (command.action) {
    case 'show': {
      const choices = provider === 'codex' ? 'Codex model ID（例如 gpt-5.2-codex）' : 'haiku / sonnet / opus';
      return `🧠 你目前的 ${name} 模型：${current ?? '預設'}\n切換：/model <${choices}>；回預設：/model default`;
    }
    case 'clear': return `🧠 已回到 ${name} 預設模型。下一則訊息起生效。`;
    case 'argument': {
      const normalized = result ?? normalizeModelForProvider(provider, command.value);
      return normalized.ok ? `🧠 已切換到 ${normalized.model}。下一則訊息起生效。` : `⚠️ ${name} 模型無效：${normalized.error}`;
    }
  }
}
