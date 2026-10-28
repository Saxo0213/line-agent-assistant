import { describe, expect, it } from 'vitest';
import { UpdateCheckRequestSchema, UpdateCheckStateSchema } from './update-check-protocol.js';

const state = { enabled: true, checking: false, lastCheckedAt: null, lastCheckFailed: false, latestVersion: '1.0.280', releaseUrl: null, available: true,
  ignoredVersion: null, download: { status: 'idle', percent: 0 }, canAutoInstall: true };

describe('update check protocol', () => {
  it('accepts a full state and rejects unknown, missing or out-of-range fields', () => {
    expect(UpdateCheckStateSchema.safeParse(state).success).toBe(true);
    expect(UpdateCheckStateSchema.safeParse({ ...state, extra: 1 }).success).toBe(false);
    const { canAutoInstall: _omitted, ...missing } = state;
    expect(UpdateCheckStateSchema.safeParse(missing).success).toBe(false);
    expect(UpdateCheckStateSchema.safeParse({ ...state, download: { status: 'paused', percent: 0 } }).success).toBe(false);
    expect(UpdateCheckStateSchema.safeParse({ ...state, download: { status: 'downloading', percent: 101 } }).success).toBe(false);
    expect(UpdateCheckStateSchema.safeParse({ ...state, download: { status: 'downloading', percent: 5, url: 'x' } }).success).toBe(false);
  });

  it('accepts ignore(version) and install() only in their strict shapes', () => {
    expect(UpdateCheckRequestSchema.safeParse({ type: 'ignore', version: '1.0.280' }).success).toBe(true);
    expect(UpdateCheckRequestSchema.safeParse({ type: 'install' }).success).toBe(true);
    expect(UpdateCheckRequestSchema.safeParse({ type: 'ignore' }).success).toBe(false);
    expect(UpdateCheckRequestSchema.safeParse({ type: 'ignore', version: '' }).success).toBe(false);
    expect(UpdateCheckRequestSchema.safeParse({ type: 'ignore', version: 'x'.repeat(33) }).success).toBe(false);
    expect(UpdateCheckRequestSchema.safeParse({ type: 'install', url: 'https://evil.example' }).success).toBe(false);
  });
});
