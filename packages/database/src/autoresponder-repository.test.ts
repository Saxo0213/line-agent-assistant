import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AutoResponderRepository } from './autoresponder-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('account autoresponder settings', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: AutoResponderRepository;

  beforeEach(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new AutoResponderRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id) VALUES ('auto-a'), ('auto-b')");
  });
  afterEach(async () => { await close?.(); });

  it('migrates the legacy Agent config once, shares it app-wide, and rejects stale versions', async () => {
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='auto-a'");
    await pool.query("INSERT INTO account_autoresponder_settings(account_id,config_version,display_name,fallback) VALUES ('auto-a',3,'Legacy Helper','Legacy fallback')");
    await pool.query("INSERT INTO autoresponder_rules(account_id,normalized_trigger,reply,ordinal) VALUES ('auto-a','legacy','Old reply',0)");
    expect(await repository.get()).toEqual({ version: 1, displayName: 'Legacy Helper', fallback: 'Legacy fallback',
      rules: [{ trigger: 'legacy', reply: 'Old reply' }] });
    const saved = await repository.save(1, { displayName: 'Helper', fallback: 'Unknown', rules: [
      { trigger: '  hi   there ', reply: 'Hello' },
    ] });
    expect(saved).toBe(2);
    expect(await repository.get()).toEqual({ version: 2, displayName: 'Helper', fallback: 'Unknown',
      rules: [{ trigger: 'hi there', reply: 'Hello' }] });
    expect(await repository.get()).toEqual(await repository.get());
    expect(await repository.save(1, { displayName: 'Lost update', fallback: 'No', rules: [] })).toBeNull();
    expect(await pool.query("SELECT display_name FROM account_autoresponder_settings WHERE account_id='auto-a'")).toMatchObject({ rows: [{ display_name: 'Legacy Helper' }] });
  });

  it('initializes one shared default when no legacy Agent config exists', async () => {
    const initial = { version: 0, displayName: 'Agent', fallback: '我不知道你在說甚麼', rules: [] };
    expect(await repository.get()).toEqual(initial);
    expect(await repository.get()).toEqual(initial);
    expect(await pool.query("SELECT key FROM app_settings WHERE key='auto_responder_settings'")).toMatchObject({ rowCount: 1 });
  });

  it('rejects reserved command triggers instead of storing an overlapping route', async () => {
    await expect(repository.save(0, { displayName: 'Agent', fallback: 'fallback', rules: [
      { trigger: 'monitor', reply: 'unsafe' },
    ] })).rejects.toThrow('reserved');
  });

  it('claims one reply intent per source message and applies room rate limits durably', async () => {
    const key = { accountId: 'auto-a', chatType: 'room' as const, chatId: 'reply-room' };
    expect(await repository.beginReplyEffect(key, 'reply-source', 'fixed reply')).toBe('created');
    expect(await repository.beginReplyEffect(key, 'reply-source', 'fixed reply')).toBe('duplicate');
    expect(await repository.beginReplyEffect(key, 'reply-source-2', 'another reply')).toBe('rate_limited');
    expect(await repository.finishReplyEffect(key, 'reply-source', 'SENT')).toBe(true);
    expect(await repository.finishReplyEffect(key, 'reply-source', 'UNKNOWN')).toBe(false);
  });
});
