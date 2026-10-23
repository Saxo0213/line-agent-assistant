import { AutoResponderSettingsSchema, DEFAULT_AUTORESPONDER_FALLBACK, normalizeAutoresponderTrigger, validateAutoresponderConfig,
  type AutoResponderRule, type AutoResponderSettings } from '@line-agent/contracts';
import type { ConversationKey } from '@line-agent/contracts';
import type { Pool, PoolClient } from 'pg';

type AutoResponderInput = Pick<AutoResponderSettings, 'displayName' | 'fallback' | 'rules'>;
const APP_AUTORESPONDER_SETTING_KEY = 'auto_responder_settings';

export class AutoResponderRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<AutoResponderSettings> {
    const existing = await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [APP_AUTORESPONDER_SETTING_KEY]);
    if (existing.rows[0]) return AutoResponderSettingsSchema.parse(existing.rows[0].value);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('autoresponder:global-settings', 0))");
      const current = await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [APP_AUTORESPONDER_SETTING_KEY]);
      if (current.rows[0]) {
        const settings = AutoResponderSettingsSchema.parse(current.rows[0].value);
        await client.query('COMMIT');
        return settings;
      }

      // One-time cutover: retain the prior Agent-role config, even while that account is offline.
      const legacy = await client.query<{ account_id: string; display_name: string; fallback: string }>(
        `SELECT old.account_id, old.display_name, old.fallback
           FROM account_autoresponder_settings old
           JOIN line_accounts account ON account.account_id = old.account_id
          WHERE account.product_role = 'AGENT'
          ORDER BY account.created_at, account.account_id
          LIMIT 1`);
      const row = legacy.rows[0];
      const rules = row ? await client.query<{ normalized_trigger: string; reply: string }>(
        'SELECT normalized_trigger, reply FROM autoresponder_rules WHERE account_id = $1 ORDER BY ordinal', [row.account_id]) : null;
      const settings = AutoResponderSettingsSchema.parse({ version: row ? 1 : 0,
        displayName: row?.display_name ?? 'Agent', fallback: row?.fallback ?? DEFAULT_AUTORESPONDER_FALLBACK,
        rules: rules?.rows.map((item): AutoResponderRule => ({ trigger: item.normalized_trigger, reply: item.reply })) ?? [] });
      await client.query('INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
        [APP_AUTORESPONDER_SETTING_KEY, JSON.stringify(settings)]);
      await client.query('COMMIT');
      return settings;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async save(expectedVersion: number, input: AutoResponderInput): Promise<number | null> {
    const validationError = validateAutoresponderConfig(input);
    if (validationError) throw new Error(validationError);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid expected autoresponder version');
    const normalizedRules = input.rules.map((rule) => ({ trigger: normalizeAutoresponderTrigger(rule.trigger), reply: rule.reply }));
    await this.get();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('autoresponder:global-settings', 0))");
      const current = await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [APP_AUTORESPONDER_SETTING_KEY]);
      const saved = AutoResponderSettingsSchema.parse(current.rows[0]?.value);
      if (saved.version !== expectedVersion) {
        await client.query('ROLLBACK');
        return null;
      }
      const nextVersion = expectedVersion + 1;
      const next = AutoResponderSettingsSchema.parse({ version: nextVersion, ...input, rules: normalizedRules });
      await client.query('UPDATE app_settings SET value = $2::jsonb, updated_at = clock_timestamp() WHERE key = $1',
        [APP_AUTORESPONDER_SETTING_KEY, JSON.stringify(next)]);
      await client.query('COMMIT');
      return nextVersion;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async beginReplyEffect(key: ConversationKey & { chatType: 'group' | 'room' }, sourceMessageId: string, replyText: string): Promise<'created' | 'duplicate' | 'rate_limited'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('autoresponder:global', 0))");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`autoresponder:account:${key.accountId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`autoresponder:room:${key.accountId}:${key.chatType}:${key.chatId}`]);
      const existing = await client.query('SELECT 1 FROM autoresponder_reply_effects WHERE account_id=$1 AND source_message_id=$2 AND chat_type=$3 AND chat_id=$4',
        [key.accountId, sourceMessageId, key.chatType, key.chatId]);
      if (existing.rowCount) { await client.query('COMMIT'); return 'duplicate'; }
      const rate = await client.query<{ room_count: string; account_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND created_at > clock_timestamp() - interval '1 second')::text AS room_count,
          count(*) FILTER (WHERE account_id=$1 AND created_at > clock_timestamp() - interval '1 minute')::text AS account_count,
          count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 minute')::text AS global_count
         FROM autoresponder_reply_effects`, [key.accountId, key.chatType, key.chatId]);
      if (Number(rate.rows[0]?.room_count) >= 1 || Number(rate.rows[0]?.account_count) >= 30 || Number(rate.rows[0]?.global_count) >= 120) {
        await client.query('COMMIT');
        return 'rate_limited';
      }
      await client.query(`INSERT INTO autoresponder_reply_effects(account_id,source_message_id,chat_type,chat_id,reply_text)
        VALUES ($1,$2,$3,$4,$5)`, [key.accountId, sourceMessageId, key.chatType, key.chatId, replyText]);
      await client.query('COMMIT');
      return 'created';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async finishReplyEffect(key: ConversationKey & { chatType: 'group' | 'room' }, sourceMessageId: string, outcome: 'SENT' | 'UNKNOWN'): Promise<boolean> {
    const result = await this.pool.query(`UPDATE autoresponder_reply_effects SET state=$5, completed_at=clock_timestamp()
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND source_message_id=$4 AND state='MAY_HAVE_STARTED'`,
    [key.accountId, key.chatType, key.chatId, sourceMessageId, outcome]);
    return result.rowCount === 1;
  }

}
