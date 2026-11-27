import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_RUNTIME_DEFAULTS, resolveAgentRuntimeSettings, SettingsRepository } from './settings-repository.js';
import { createTestDatabase } from './test-database.js';
import { DEFAULT_AGENT_STATUS_ICONS, DEFAULT_DOWNLOAD_BRIDGE_INTERVALS } from '@line-agent/contracts';

describe('agent runtime settings', () => {
  it('gives the defaults when no value is set', () => {
    expect(resolveAgentRuntimeSettings({})).toEqual(AGENT_RUNTIME_DEFAULTS);
    expect(AGENT_RUNTIME_DEFAULTS).toEqual({ turnTimeoutSeconds: 900, turnStallSeconds: 120, idleTimeoutSeconds: 600,
      autoSlimEnabled: true, autoSlimMaxTurns: 120, autoSlimMaxTranscriptBytes: 8_000_000 });
  });
  it('clamps the values and ignores malformed values', () => {
    expect(resolveAgentRuntimeSettings({ agent_turn_timeout_seconds: 5 }).turnTimeoutSeconds).toBe(30);
    expect(resolveAgentRuntimeSettings({ agent_turn_timeout_seconds: 99999 }).turnTimeoutSeconds).toBe(7200);
    expect(resolveAgentRuntimeSettings({ agent_turn_stall_seconds: 0 }).turnStallSeconds).toBe(0);
    expect(resolveAgentRuntimeSettings({ agent_turn_stall_seconds: 10 }).turnStallSeconds).toBe(30);
    expect(resolveAgentRuntimeSettings({ agent_idle_timeout_seconds: 10 }).idleTimeoutSeconds).toBe(60);
    expect(resolveAgentRuntimeSettings({ agent_auto_slim_enabled: false }).autoSlimEnabled).toBe(false);
    expect(resolveAgentRuntimeSettings({ agent_auto_slim_enabled: 'no', agent_idle_timeout_seconds: 'x' })).toEqual(AGENT_RUNTIME_DEFAULTS);
  });
});

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
    expect(await repository.getConversationSettings()).toEqual({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true,
      agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS, agentStatusRotationIntervalSeconds: 10 });
    const customIcons = { ...DEFAULT_AGENT_STATUS_ICONS, running: '🤖', completed: '🏁' };
    await repository.setConversationSettings({ attachmentAutoAttemptLimit: 7, showAgentStatusMarkers: false, agentStatusIcons: customIcons,
      agentStatusRotationIntervalSeconds: 5 });
    expect(await repository.getConversationSettings()).toEqual({ attachmentAutoAttemptLimit: 7, showAgentStatusMarkers: false,
      agentStatusIcons: customIcons, agentStatusRotationIntervalSeconds: 5 });
    expect((await pool.query('SELECT key FROM app_settings ORDER BY key')).rows).toEqual([
      { key: 'agent_status_icons' }, { key: 'agent_status_rotation_interval_seconds' }, { key: 'attachment_auto_attempt_limit' }, { key: 'show_agent_status_markers' },
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

  it.each([4, 5.5, '6', null, 86_401])('rejects an invalid status icon rotation interval: %s', async (seconds) => {
    await expect(repository.setConversationSettings({
      ...(await repository.getConversationSettings()), agentStatusRotationIntervalSeconds: seconds as number,
    })).rejects.toThrow();
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

  it('gives the default download bridge intervals, saves valid ones and falls back to the defaults for an invalid row', async () => {
    expect(await repository.getExternalBridgeDownloadIntervals()).toEqual(DEFAULT_DOWNLOAD_BRIDGE_INTERVALS);
    const custom = { image: { minSeconds: 0, maxSeconds: 0 }, file: { minSeconds: 5, maxSeconds: 600 } };
    await repository.setExternalBridgeDownloadIntervals(custom);
    expect(await repository.getExternalBridgeDownloadIntervals()).toEqual(custom);
    await expect(repository.setExternalBridgeDownloadIntervals({ ...custom, image: { minSeconds: 9, maxSeconds: 3 } })).rejects.toThrow();
    await expect(repository.setExternalBridgeDownloadIntervals({ ...custom, file: { minSeconds: 0, maxSeconds: 601 } })).rejects.toThrow();
    expect(await repository.getExternalBridgeDownloadIntervals()).toEqual(custom);
    for (const bad of [{ image: { minSeconds: 9, maxSeconds: 3 }, file: custom.file }, 'text', { image: custom.image }]) {
      await pool.query("UPDATE app_settings SET value = $1::jsonb WHERE key = 'external_bridge_download_intervals'", [JSON.stringify(bad)]);
      expect(await repository.getExternalBridgeDownloadIntervals()).toEqual(DEFAULT_DOWNLOAD_BRIDGE_INTERVALS);
    }
  });

  it('keeps the community receive setting off by default and stores only a boolean', async () => {
    expect(await repository.getLineSquareReceive()).toBe(false);
    await repository.setLineSquareReceive(true);
    expect(await repository.getLineSquareReceive()).toBe(true);
    await expect(repository.setLineSquareReceive('yes' as never)).rejects.toThrow();
    await pool.query("UPDATE app_settings SET value = '\"text\"'::jsonb WHERE key = 'line_square_receive'");
    expect(await repository.getLineSquareReceive()).toBe(false);
    await repository.setLineSquareReceive(false);
    expect(await repository.getLineSquareReceive()).toBe(false);
  });
});
