import { describe, expect, it } from 'vitest';
import {
  AGENT_ROOM_HISTORY_TOOL_NAME, MCP_TOOL_NAMES, McpAgentRoomHistoryInputSchema, McpAgentRoomHistoryItemSchema,
  McpAgentRoomHistoryOutputSchema, McpInternalToolNameSchema, McpToolNameSchema, decodeAgentRoomHistoryCursor,
  encodeAgentRoomHistoryCursor,
} from './index.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const cursor = encodeAgentRoomHistoryCursor({ createdAt: '2026-10-20T10:00:00.123456Z', jobId });

describe('Agent room history contract', () => {
  it('keeps the tool out of the external token scope schema', () => {
    expect(McpToolNameSchema.safeParse(AGENT_ROOM_HISTORY_TOOL_NAME).success).toBe(false);
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain(AGENT_ROOM_HISTORY_TOOL_NAME);
    expect(McpInternalToolNameSchema.safeParse(AGENT_ROOM_HISTORY_TOOL_NAME).success).toBe(true);
  });

  it('accepts valid input and applies strict bounds', () => {
    expect(McpAgentRoomHistoryInputSchema.safeParse({}).success).toBe(true);
    expect(McpAgentRoomHistoryInputSchema.safeParse({
      query: 'x'.repeat(200), provider: 'claude', from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00+08:00', cursor, limit: 50,
    }).success).toBe(true);
    for (const bad of [{ extra: 1 }, { limit: 0 }, { limit: 51 }, { query: '' }, { query: 'x'.repeat(201) }, { provider: 'gemini' },
      { from: '2026-10-21T00:00:00Z', to: '2026-10-20T00:00:00Z' }, { cursor: 'nope' }, { from: 'tomorrow' }]) {
      expect(McpAgentRoomHistoryInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('round-trips the cursor and rejects anything non-canonical', () => {
    expect(decodeAgentRoomHistoryCursor(cursor)).toEqual({ createdAt: '2026-10-20T10:00:00.123456Z', jobId });
    expect(decodeAgentRoomHistoryCursor(`${cursor}=`)).toBeNull();
    expect(decodeAgentRoomHistoryCursor('')).toBeNull();
    expect(decodeAgentRoomHistoryCursor('a'.repeat(300))).toBeNull();
    expect(decodeAgentRoomHistoryCursor(btoa('{"i":"x","t":"y"}'))).toBeNull();
  });

  it('has strict item and output schemas', () => {
    const item = { origin: 'agent_room', jobId, provider: 'codex', createdAt: '2026-10-20T10:00:00.123Z', status: 'completed',
      prompt: 'p', reply: null, promptTruncated: false, replyTruncated: false };
    expect(McpAgentRoomHistoryItemSchema.safeParse(item).success).toBe(true);
    expect(McpAgentRoomHistoryItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
    expect(McpAgentRoomHistoryItemSchema.safeParse({ ...item, origin: 'line' }).success).toBe(false);
    expect(McpAgentRoomHistoryOutputSchema.safeParse({ toolName: AGENT_ROOM_HISTORY_TOOL_NAME, items: [item], nextCursor: null }).success).toBe(true);
    expect(McpAgentRoomHistoryOutputSchema.safeParse({ toolName: AGENT_ROOM_HISTORY_TOOL_NAME, items: [item] }).success).toBe(false);
  });
});
