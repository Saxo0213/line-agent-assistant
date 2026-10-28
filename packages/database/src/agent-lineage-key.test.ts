import { describe, expect, it } from 'vitest';
import { resolveCurrentAgentKey } from './agent-lineage.js';

describe('resolveCurrentAgentKey', () => {
  const lineage = { currentAccountId: 'cur', accountIds: ['cur', 'mid', 'old'] };
  const key = (accountId: string) => ({ accountId, chatType: 'group', chatId: 'g1', title: 'T' });

  it('maps a former Agent account to the current one and keeps the chat', () => {
    expect(resolveCurrentAgentKey(lineage, key('old'))).toEqual(key('cur'));
    expect(resolveCurrentAgentKey(lineage, key('mid'))).toEqual(key('cur'));
  });
  it('keeps the current account key', () => {
    const current = key('cur');
    expect(resolveCurrentAgentKey(lineage, current)).toBe(current);
  });
  it('leaves an account outside the lineage unchanged', () => {
    const other = key('other');
    expect(resolveCurrentAgentKey(lineage, other)).toBe(other);
  });
  it('leaves every key unchanged when no Agent exists', () => {
    const none = { currentAccountId: null, accountIds: [] };
    const old = key('old');
    expect(resolveCurrentAgentKey(none, old)).toBe(old);
  });
});
