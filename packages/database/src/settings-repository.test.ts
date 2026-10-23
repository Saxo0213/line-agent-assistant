import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsRepository } from './settings-repository.js';
import { createTestDatabase } from './test-database.js';
import { DEFAULT_AGENT_STATUS_ICONS } from '@line-agent/contracts';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('conversation settings repository', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;
  let repository: SettingsRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new SettingsRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('uses defaults when keys are absent and commits both validated values together', async () => {
    expect(await repository.getConversationSettings()).toEqual({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS });
    const customIcons = { ...DEFAULT_AGENT_STATUS_ICONS, running: '🤖', completed: '🏁' };
    await repository.setConversationSettings({ attachmentAutoAttemptLimit: 7, showAgentStatusMarkers: false, agentStatusIcons: customIcons });
    expect(await repository.getConversationSettings()).toEqual({ attachmentAutoAttemptLimit: 7, showAgentStatusMarkers: false, agentStatusIcons: customIcons });
    expect((await pool.query('SELECT key FROM app_settings ORDER BY key')).rows).toEqual([
      { key: 'agent_status_icons' }, { key: 'attachment_auto_attempt_limit' }, { key: 'show_agent_status_markers' },
    ]);
  });

  it.each([2, 11, 3.5, '5', null])('rejects an invalid automatic attempt limit: %s', async (limit) => {
    await expect(repository.setConversationSettings({
      attachmentAutoAttemptLimit: limit as number,
      showAgentStatusMarkers: true,
      agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS,
    })).rejects.toThrow();
  });

  it('rejects invalid icons without partially saving other conversation settings', async () => {
    const before = await repository.getConversationSettings();
    await expect(repository.setConversationSettings({
      ...before,
      attachmentAutoAttemptLimit: 9,
      agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS, failed: '\n' },
    })).rejects.toThrow();
    expect(await repository.getConversationSettings()).toEqual(before);
  });

  it('stores the official LINE build trust document under its single app_settings key', async () => {
    expect(await repository.getOfficialBuildTrust()).toBeNull();
    const trust = { acceptedBuilds: [{ version: '26.5.0.3975', bytes: 30700001, sha256: 'c'.repeat(64), acceptedAt: '2026-10-20T00:00:00.000Z' }],
      pinnedThumbprints: ['A'.repeat(40)], lastObserved: { version: '26.5.0.3975', verdict: 'accepted', reason: null, at: '2026-10-20T00:00:00.000Z' } };
    await repository.setOfficialBuildTrust(trust);
    expect(await repository.getOfficialBuildTrust()).toEqual(trust);
    await repository.setOfficialBuildTrust({ ...trust, pinnedThumbprints: [] });
    expect(await repository.getOfficialBuildTrust()).toEqual({ ...trust, pinnedThumbprints: [] });
    expect((await pool.query("SELECT count(*)::int AS count FROM app_settings WHERE key = 'official_line_build_trust'")).rows).toEqual([{ count: 1 }]);
    await expect(repository.getAppSetting('official_line_build_trust')).rejects.toThrow('App setting not allowed');
  });
});
