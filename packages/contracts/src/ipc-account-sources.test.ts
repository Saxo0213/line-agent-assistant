import { describe, expect, it } from 'vitest';
import { IpcRequestSchema, IpcResultSchema } from './ipc.js';

const parse = (value: Record<string, unknown>) => IpcRequestSchema.safeParse({ requestId: 'r', ...value }).success;

describe('CLI account source requests', () => {
  it('accepts the ten requests with valid ids and labels', () => {
    expect(parse({ type: 'agentSourceAdd', provider: 'claude', label: ' Work ' })).toBe(true);
    expect(parse({ type: 'agentSourceRename', id: 'acct-0123456789', label: 'x'.repeat(80) })).toBe(true);
    expect(parse({ type: 'agentSourceRemove', id: 'acct-0123456789' })).toBe(true);
    expect(parse({ type: 'agentSourceSetDefault', provider: 'codex', id: 'codex' })).toBe(true);
    expect(parse({ type: 'agentSourceMove', id: 'claude', direction: 'up' })).toBe(true);
    expect(parse({ type: 'agentSourceSetFallback', id: 'claude', enabled: false })).toBe(true);
    expect(parse({ type: 'agentSourceLogin', id: 'claude' })).toBe(true);
    expect(parse({ type: 'agentSourceLogout', id: 'claude' })).toBe(true);
    expect(parse({ type: 'agentSourceRefresh', id: 'claude' })).toBe(true);
    expect(parse({ type: 'agentSourceUsage', id: 'claude', force: true })).toBe(true);
    expect(parse({ type: 'agentSourceSetAutoFailover', enabled: false })).toBe(true);
    expect(parse({ type: 'agentSourceSetAutoFailover' })).toBe(false);
  });

  it('rejects bad ids, labels, directions and missing fields', () => {
    expect(parse({ type: 'agentSourceRemove', id: '../escape' })).toBe(false);
    expect(parse({ type: 'agentSourceRemove', id: 'a'.repeat(65) })).toBe(false);
    expect(parse({ type: 'agentSourceRemove', id: '' })).toBe(false);
    expect(parse({ type: 'agentSourceAdd', provider: 'claude', label: '   ' })).toBe(false);
    expect(parse({ type: 'agentSourceAdd', provider: 'claude', label: 'x'.repeat(81) })).toBe(false);
    expect(parse({ type: 'agentSourceAdd', provider: 'gemini', label: 'x' })).toBe(false);
    expect(parse({ type: 'agentSourceMove', id: 'claude', direction: 'left' })).toBe(false);
    expect(parse({ type: 'agentSourceUsage', id: 'claude' })).toBe(false);
  });

  it('trims the label and parses a list result', () => {
    const request = IpcRequestSchema.parse({ type: 'agentSourceAdd', requestId: 'r', provider: 'claude', label: ' Work ' });
    expect(request).toMatchObject({ label: 'Work' });
    const source = { id: 'claude', provider: 'claude', kind: 'system', label: 'Claude', isDefault: true, fallbackEnabled: true, order: 0,
      status: 'logged_in', detail: null, inUse: false };
    expect(IpcResultSchema.safeParse({ type: 'agentSourceAdd', requestId: 'r', ok: true, sources: [source] }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'agentSourceAdd', requestId: 'r', ok: true, sources: [{ ...source, email: 'a@b.c' }] }).success).toBe(false);
  });
});
