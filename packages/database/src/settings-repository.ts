import { AGENT_PERSONA_MAX_LENGTH, AgentLivelinessSchema, type AgentLiveliness, AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MAX,AGENT_STATUS_ROTATION_INTERVAL_SECONDS_MIN, AgentStatusIconsSchema, DEFAULT_AGENT_STATUS_ICONS, type AgentProvider, type AgentStatusIcons, type ConversationKey } from '@line-agent/contracts';
import type { Pool } from 'pg';

const appSettingKeys = new Set(['default_provider', 'workspace_path', 'attachment_root', 'attachment_auto_attempt_limit', 'show_agent_status_markers', 'agent_status_icons', 'agent_status_rotation_interval_seconds', 'manual_unsend_window', 'agent_persona_description', 'agent_persona_liveliness']);

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

export const OFFICIAL_LINE_BUILD_TRUST_KEY = 'official_line_build_trust';

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

  async setAppSetting(key: string, value: string | boolean | number): Promise<void> {
    if (!appSettingKeys.has(key)) throw new Error(`App setting not allowed: ${key}`);
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value)],
    );
  }
}
