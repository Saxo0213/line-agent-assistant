import { AGENT_PERSONA_MAX_LENGTH, AgentLivelinessSchema, type AgentLiveliness, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX,AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN, AgentStatusIconsSchema, DEFAULT_AGENT_STATUS_ICONS, type AgentProvider, type AgentStatusIcons, type ConversationKey, DEFAULT_DOWNLOAD_BRIDGE_INTERVALS, DownloadBridgeIntervalsSchema, type DownloadBridgeIntervals } from '@line-agent/contracts';
import type { Pool } from 'pg';

/** The Claude model aliases a chat may select with /model. */
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus';

/** App setting keys of the resident Claude runtime (CliTalkAgent config.rs). Read once at startup; there is no UI. */
export const AGENT_RUNTIME_SETTING_KEYS = ['agent_turn_timeout_seconds', 'agent_turn_stall_seconds', 'agent_idle_timeout_seconds',
  'agent_auto_slim_enabled', 'agent_auto_slim_max_turns', 'agent_auto_slim_max_transcript_bytes'] as const;

export interface AgentRuntimeSettings {
  turnTimeoutSeconds: number;
  /** 0 = stall check off. */
  turnStallSeconds: number;
  idleTimeoutSeconds: number;
  autoSlimEnabled: boolean;
  autoSlimMaxTurns: number;
  autoSlimMaxTranscriptBytes: number;
}
export const AGENT_RUNTIME_DEFAULTS: AgentRuntimeSettings = { turnTimeoutSeconds: 900, turnStallSeconds: 120, idleTimeoutSeconds: 600,
  autoSlimEnabled: true, autoSlimMaxTurns: 120, autoSlimMaxTranscriptBytes: 8_000_000 };

const finiteNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;

/** Applies defaults and clamps to raw setting values. A missing or malformed value gives the default. Pure function. */
export function resolveAgentRuntimeSettings(raw: Readonly<Record<string, unknown>>): AgentRuntimeSettings {
  const turnTimeout = finiteNumber(raw.agent_turn_timeout_seconds);
  const stall = finiteNumber(raw.agent_turn_stall_seconds);
  const idle = finiteNumber(raw.agent_idle_timeout_seconds);
  const maxTurns = finiteNumber(raw.agent_auto_slim_max_turns);
  const maxBytes = finiteNumber(raw.agent_auto_slim_max_transcript_bytes);
  const defaults = AGENT_RUNTIME_DEFAULTS;
  return {
    turnTimeoutSeconds: turnTimeout === undefined ? defaults.turnTimeoutSeconds : Math.min(7200, Math.max(30, turnTimeout)),
    turnStallSeconds: stall === undefined ? defaults.turnStallSeconds : stall <= 0 ? 0 : Math.max(30, stall),
    idleTimeoutSeconds: idle === undefined ? defaults.idleTimeoutSeconds : Math.max(60, idle),
    autoSlimEnabled: typeof raw.agent_auto_slim_enabled === 'boolean' ? raw.agent_auto_slim_enabled : defaults.autoSlimEnabled,
    autoSlimMaxTurns: maxTurns === undefined ? defaults.autoSlimMaxTurns : Math.max(1, maxTurns),
    autoSlimMaxTranscriptBytes: maxBytes === undefined ? defaults.autoSlimMaxTranscriptBytes : Math.max(1, maxBytes),
  };
}

/** Switch of the automatic provider and source failover (P5, plan D26). Stored as a raw boolean; a missing or malformed row means true. */
export const AGENT_AUTO_FAILOVER_KEY = 'agent_auto_failover_enabled';

const appSettingKeys = new Set(['default_provider', 'workspace_path', 'attachment_root', 'attachment_auto_attempt_limit', 'show_agent_status_markers', 'agent_status_icons', 'agent_status_rotation_interval_seconds', 'manual_unsend_window', 'agent_persona_description', 'agent_persona_liveliness', AGENT_AUTO_FAILOVER_KEY, ...AGENT_RUNTIME_SETTING_KEYS]);

export type ConversationSettings = { attachmentAutoAttemptLimit: number; showAgentStatusMarkers: boolean; agentStatusIcons: AgentStatusIcons; agentStatusRotationIntervalSeconds: number };

function validateConversationSettings(settings: ConversationSettings): void {
  if (!Number.isInteger(settings.attachmentAutoAttemptLimit) || settings.attachmentAutoAttemptLimit < 3 || settings.attachmentAutoAttemptLimit > 10) {
    throw new Error('Attachment automatic attempt limit must be an integer from 3 to 10');
  }
  if (typeof settings.showAgentStatusMarkers !== 'boolean') throw new Error('Agent status marker preference must be a boolean');
  AgentStatusIconsSchema.parse(settings.agentStatusIcons);
  if (!Number.isInteger(settings.agentStatusRotationIntervalSeconds)
    || settings.agentStatusRotationIntervalSeconds < AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN
    || settings.agentStatusRotationIntervalSeconds > AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX) {
    throw new Error('Agent status icon rotation interval must be an integer from 5 to 86400 seconds');
  }
}

/** Switch of the LEGY encrypted transport for the Agent (DESKTOPWIN) worker. Value: {"enabled": boolean}. A missing row means false (plain transport). */
export const LINE_LEGY_ENCRYPTED_KEY = 'line_legy_encrypted';

/** Switch of community (Square) message receive for the Agent (DESKTOPWIN) worker. Value: {"enabled": boolean}. A missing row means false. */
export const LINE_SQUARE_RECEIVE_KEY = 'line_square_receive';

export const OFFICIAL_LINE_BUILD_TRUST_KEY = 'official_line_build_trust';
/** Toggle of the automatic download of new External Monitor attachments through the download bridge. Value: {"enabled": boolean}. */
export const EXTERNAL_BRIDGE_AUTO_DOWNLOAD_KEY = 'external_bridge_auto_download';

/** Intervals between two non-live bridge downloads, in seconds, for each kind. Value: {image:{minSeconds,maxSeconds},file:{minSeconds,maxSeconds}}. A missing or invalid row means the defaults. */
export const EXTERNAL_BRIDGE_DOWNLOAD_INTERVALS_KEY = 'external_bridge_download_intervals';

/** Switch that allows every Chrome extension download of the bridge. Value: {"enabled": boolean}. A missing row means false. */
export const EXTERNAL_BRIDGE_DOWNLOAD_ENABLED_KEY = 'external_bridge_download_enabled';

export class SettingsRepository {
  constructor(private readonly pool: Pool) {}

  /** The single persisted official-LINE build trust document (validated by the desktop main process). */
  async getOfficialBuildTrust(): Promise<unknown | null> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [OFFICIAL_LINE_BUILD_TRUST_KEY]);
    return result.rows[0]?.value ?? null;
  }

  async setOfficialBuildTrust(value: object): Promise<void> {
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [OFFICIAL_LINE_BUILD_TRUST_KEY, JSON.stringify(value)],
    );
  }

  /** A missing or malformed row means false. */
  async getExternalBridgeAutoDownload(): Promise<boolean> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [EXTERNAL_BRIDGE_AUTO_DOWNLOAD_KEY]);
    const value = result.rows[0]?.value;
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  }

  async setExternalBridgeAutoDownload(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('External bridge auto download must be a boolean');
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [EXTERNAL_BRIDGE_AUTO_DOWNLOAD_KEY, JSON.stringify({ enabled })],
    );
  }

  /** A missing or invalid row means the defaults. */
  async getExternalBridgeDownloadIntervals(): Promise<DownloadBridgeIntervals> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [EXTERNAL_BRIDGE_DOWNLOAD_INTERVALS_KEY]);
    const parsed = DownloadBridgeIntervalsSchema.safeParse(result.rows[0]?.value);
    return parsed.success ? parsed.data : DEFAULT_DOWNLOAD_BRIDGE_INTERVALS;
  }

  async setExternalBridgeDownloadIntervals(intervals: DownloadBridgeIntervals): Promise<void> {
    const parsed = DownloadBridgeIntervalsSchema.parse(intervals);
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [EXTERNAL_BRIDGE_DOWNLOAD_INTERVALS_KEY, JSON.stringify(parsed)],
    );
  }

  /** A missing or malformed row means false. */
  async getLineLegyEncrypted(): Promise<boolean> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [LINE_LEGY_ENCRYPTED_KEY]);
    const value = result.rows[0]?.value;
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  }

  async setLineLegyEncrypted(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('LEGY encrypted transport must be a boolean');
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [LINE_LEGY_ENCRYPTED_KEY, JSON.stringify({ enabled })],
    );
  }

  /** A missing or malformed row means false. */
  async getLineSquareReceive(): Promise<boolean> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [LINE_SQUARE_RECEIVE_KEY]);
    const value = result.rows[0]?.value;
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  }

  async setLineSquareReceive(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Community message receive must be a boolean');
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [LINE_SQUARE_RECEIVE_KEY, JSON.stringify({ enabled })],
    );
  }

  /** A missing or malformed row means false. */
  async getExternalBridgeDownloadEnabled(): Promise<boolean> {
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [EXTERNAL_BRIDGE_DOWNLOAD_ENABLED_KEY]);
    const value = result.rows[0]?.value;
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  }

  async setExternalBridgeDownloadEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('External bridge download enabled must be a boolean');
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [EXTERNAL_BRIDGE_DOWNLOAD_ENABLED_KEY, JSON.stringify({ enabled })],
    );
  }

  /** The resident Claude runtime settings with defaults and clamps applied. */
  async getAgentRuntimeSettings(): Promise<AgentRuntimeSettings> {
    const result = await this.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [[...AGENT_RUNTIME_SETTING_KEYS]]);
    return resolveAgentRuntimeSettings(Object.fromEntries(result.rows.map((row) => [row.key, row.value])));
  }

  async getConversationSettings(): Promise<ConversationSettings> {
    const result = await this.pool.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
      [['attachment_auto_attempt_limit', 'show_agent_status_markers', 'agent_status_icons', 'agent_status_rotation_interval_seconds']],
    );
    const values = new Map(result.rows.map((row) => [row.key, row.value]));
    const limit = values.has('attachment_auto_attempt_limit') ? values.get('attachment_auto_attempt_limit') : 3;
    const markers = values.has('show_agent_status_markers') ? values.get('show_agent_status_markers') : true;
    const icons = values.has('agent_status_icons') ? values.get('agent_status_icons') : DEFAULT_AGENT_STATUS_ICONS;
    const rotationInterval = values.has('agent_status_rotation_interval_seconds') ? values.get('agent_status_rotation_interval_seconds') : 10;
    const settings = { attachmentAutoAttemptLimit: limit, showAgentStatusMarkers: markers, agentStatusIcons: icons,
      agentStatusRotationIntervalSeconds: rotationInterval } as ConversationSettings;
    validateConversationSettings(settings);
    return settings;
  }

  async setConversationSettings(settings: ConversationSettings): Promise<void> {
    validateConversationSettings(settings);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb), ($3, $4::jsonb), ($5, $6::jsonb), ($7, $8::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        ['attachment_auto_attempt_limit', JSON.stringify(settings.attachmentAutoAttemptLimit),
          'show_agent_status_markers', JSON.stringify(settings.showAgentStatusMarkers),
          'agent_status_icons', JSON.stringify(settings.agentStatusIcons),
          'agent_status_rotation_interval_seconds', JSON.stringify(settings.agentStatusRotationIntervalSeconds)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** `provider` is the chat's override set by the Primary Administrator's /agent command; null follows the global default. */
  async getConversationAgent(key: ConversationKey): Promise<{ enabled: boolean; provider: AgentProvider | null } | null> {
    const result = await this.pool.query<{ agent_enabled: boolean; default_provider: AgentProvider | null }>(
      'SELECT agent_enabled, default_provider FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId],
    );
    const row = result.rows[0];
    return row ? { enabled: row.agent_enabled, provider: row.default_provider } : null;
  }

  async setConversationAgent(settings: ConversationKey & { enabled: boolean; provider: AgentProvider | null }): Promise<void> {
    const result = await this.pool.query(
      'UPDATE conversations SET agent_enabled = $4, default_provider = $5, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [settings.accountId, settings.chatType, settings.chatId, settings.enabled, settings.provider],
    );
    if (result.rowCount !== 1) throw new Error(`Conversation not found: ${settings.accountId}/${settings.chatId}`);
  }

  /** Sets (or with null clears) the chat's Agent override. Resolves false when the conversation row does not exist. */
  async setConversationProvider(key: ConversationKey, provider: AgentProvider | null): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE conversations SET default_provider = $4, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId, provider]);
    return result.rowCount === 1;
  }

  /** The chat's Claude model set by the Primary Administrator's /model command; null follows the bridge default (or the conversation is unknown). */
  async getConversationClaudeModel(key: ConversationKey): Promise<ClaudeModelAlias | null> {
    const result = await this.pool.query<{ claude_model: ClaudeModelAlias | null }>(
      'SELECT claude_model FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId]);
    return result.rows[0]?.claude_model ?? null;
  }

  /** Sets (or with null clears) the chat's Claude model. Resolves false when the conversation row does not exist. */
  async setConversationClaudeModel(key: ConversationKey, model: ClaudeModelAlias | null): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE conversations SET claude_model = $4, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId, model]);
    return result.rowCount === 1;
  }

  /** The chat's Codex model set by the Primary Administrator's /model command; null follows the Codex default (or the conversation is unknown). */
  async getConversationCodexModel(key: ConversationKey): Promise<string | null> {
    const result = await this.pool.query<{ codex_model: string | null }>(
      'SELECT codex_model FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId]);
    return result.rows[0]?.codex_model ?? null;
  }

  /** Sets (or with null clears) the chat's Codex model. Resolves false when the conversation row does not exist. */
  async setConversationCodexModel(key: ConversationKey, model: string | null): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE conversations SET codex_model = $4, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId, model]);
    return result.rowCount === 1;
  }

  /** The chat's persona overrides set by the Primary Administrator's /persona; a null field follows the global value. Null when the conversation is unknown. */
  async getConversationPersona(key: ConversationKey): Promise<{ description: string | null; liveliness: AgentLiveliness | null } | null> {
    const result = await this.pool.query<{ persona_description: string | null; persona_liveliness: AgentLiveliness | null }>(
      'SELECT persona_description, persona_liveliness FROM conversations WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3',
      [key.accountId, key.chatType, key.chatId]);
    const row = result.rows[0];
    return row ? { description: row.persona_description, liveliness: row.persona_liveliness } : null;
  }

  /** Sets (or with null clears) the given override fields only. Resolves false when the conversation row does not exist. */
  async setConversationPersona(key: ConversationKey, override: { description?: string | null; liveliness?: AgentLiveliness | null }): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [key.accountId, key.chatType, key.chatId];
    if (override.description !== undefined) {
      if (override.description !== null && override.description.length > AGENT_PERSONA_MAX_LENGTH) throw new Error('Persona description is too long');
      values.push(override.description); sets.push(`persona_description = $${values.length}`);
    }
    if (override.liveliness !== undefined) {
      if (override.liveliness !== null) AgentLivelinessSchema.parse(override.liveliness);
      values.push(override.liveliness); sets.push(`persona_liveliness = $${values.length}`);
    }
    if (sets.length === 0) return (await this.getConversationPersona(key)) !== null;
    const result = await this.pool.query(
      `UPDATE conversations SET ${sets.join(', ')}, updated_at = now() WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3`, values);
    return result.rowCount === 1;
  }

  async getAppSetting(key: string): Promise<unknown | null> {
    if (!appSettingKeys.has(key)) throw new Error(`App setting not allowed: ${key}`);
    const result = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
    return result.rows[0]?.value ?? null;
  }

  /** Automatic provider and source failover (D26). A missing or non-boolean row means true. */
  async getAgentAutoFailoverEnabled(): Promise<boolean> {
    const value = await this.getAppSetting(AGENT_AUTO_FAILOVER_KEY);
    return typeof value === 'boolean' ? value : true;
  }

  async setAgentAutoFailoverEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Agent auto failover must be a boolean');
    await this.setAppSetting(AGENT_AUTO_FAILOVER_KEY, enabled);
  }

  async setAppSetting(key: string, value: string | boolean | number): Promise<void> {
    if (!appSettingKeys.has(key)) throw new Error(`App setting not allowed: ${key}`);
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value)],
    );
  }
}
