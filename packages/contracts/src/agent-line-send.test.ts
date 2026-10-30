import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_NAMES, McpInternalToolNameSchema, McpListSendTargetsInputSchema, McpListSendTargetsOutputSchema, McpSendToTargetInputSchema,
  McpSendToTargetOutputSchema, McpToolNameSchema, SendErrorCodeSchema, LineWorkerEventSchema, lineResultErrorMessage,
} from './index.js';

const text = { type: 'text', text: 'hi' };

describe('Agent LINE send contract', () => {
  it('keeps both tools out of the external token scope', () => {
    for (const tool of ['list_send_targets', 'send_to_target']) {
      expect(McpToolNameSchema.safeParse(tool).success).toBe(false);
      expect(MCP_TOOL_NAMES as readonly string[]).not.toContain(tool);
      expect(McpInternalToolNameSchema.safeParse(tool).success).toBe(true);
    }
  });

  it('validates list_send_targets input strictly', () => {
    expect(McpListSendTargetsInputSchema.safeParse({ query: 'x'.repeat(100) }).success).toBe(true);
    for (const bad of [{}, { query: '' }, { query: 'x'.repeat(101) }, { query: 'a', extra: 1 }]) {
      expect(McpListSendTargetsInputSchema.safeParse(bad).success).toBe(false);
    }
    expect(McpListSendTargetsOutputSchema.safeParse({ targets: [{ no: 1, chatType: 'group', chatId: 'g', title: null, members: ['a'], memberCount: 1 }] }).success).toBe(true);
    expect(McpListSendTargetsOutputSchema.safeParse({ targets: [{ no: 1, chatType: 'community', chatId: 'g', title: null, members: [], memberCount: 0 }] }).success).toBe(false);
  });

  it('accepts all four item types and bounds', () => {
    const items = [
      text,
      { type: 'message', accountId: 'a', chatType: 'community', chatId: 'c', messageId: 'm' },
      { type: 'attachment', attachmentId: 'x' },
      { type: 'file', path: 'p'.repeat(1024) },
    ];
    expect(McpSendToTargetInputSchema.safeParse({ chatType: 'direct', chatId: 'u', items }).success).toBe(true);
    expect(McpSendToTargetInputSchema.safeParse({ chatType: 'room', chatId: 'r', items: [{ type: 'text', text: 'x'.repeat(5000) }] }).success).toBe(true);
    expect(McpSendToTargetInputSchema.safeParse({ chatType: 'group', chatId: 'g', items: Array.from({ length: 10 }, () => text) }).success).toBe(true);
  });

  it('rejects unknown keys, 11 items, empty text, a bad type and a non-writable target', () => {
    const input = (overrides: Record<string, unknown>) => McpSendToTargetInputSchema.safeParse({ chatType: 'group', chatId: 'g', items: [text], ...overrides }).success;
    expect(input({ extra: 1 })).toBe(false);
    expect(input({ items: Array.from({ length: 11 }, () => text) })).toBe(false);
    expect(input({ items: [] })).toBe(false);
    expect(input({ items: [{ type: 'text', text: '' }] })).toBe(false);
    expect(input({ items: [{ type: 'text', text: 'x'.repeat(5001) }] })).toBe(false);
    expect(input({ items: [{ type: 'text', text: 'a', extra: 1 }] })).toBe(false);
    expect(input({ items: [{ type: 'sticker', stickerId: '1' }] })).toBe(false);
    expect(input({ items: [{ type: 'file', path: '' }] })).toBe(false);
    expect(input({ items: [{ type: 'file', path: 'p'.repeat(1025) }] })).toBe(false);
    expect(input({ chatType: 'community' })).toBe(false);
    expect(input({ chatType: 'thread' })).toBe(false);
  });

  it('validates the output and error codes', () => {
    expect(McpSendToTargetOutputSchema.safeParse({ results: [{ index: 0, status: 'sent' }, { index: 1, status: 'failed', code: 'send_failed' }, { index: 2, status: 'skipped' }] }).success).toBe(true);
    expect(McpSendToTargetOutputSchema.safeParse({ results: [{ index: 0, status: 'denied' }] }).success).toBe(false);
    expect(McpSendToTargetOutputSchema.safeParse({ results: [{ index: 0, status: 'failed', code: 'nope' }] }).success).toBe(false);
    expect(SendErrorCodeSchema.options).toHaveLength(12);
  });

  it('accepts an optional bounded detail on a result and refuses an unsafe or long one', () => {
    const output = (detail: unknown) => McpSendToTargetOutputSchema.safeParse({ results: [{ index: 0, status: 'failed', code: 'send_failed', detail }] }).success;
    expect(output('UPLOAD_FAILED:obs_upload:ObsHttpError:403')).toBe(true);
    expect(output('gateway:queue_full')).toBe(true);
    expect(output('LINE_TALK_ABUSE_BLOCK')).toBe(true);
    expect(output('a'.repeat(120))).toBe(true);
    expect(output('a'.repeat(121))).toBe(false);
    expect(output('')).toBe(false);
    for (const unsafe of ['has space', '/etc/passwd', 'C:\\Users\\x', 'u0123456789abcdef', 'token=abc', 'line\nbreak', '日本語']) {
      if (/^[A-Za-z0-9_:.-]+$/.test(unsafe)) continue;
      expect(output(unsafe)).toBe(false);
    }
    expect(McpSendToTargetOutputSchema.safeParse({ results: [{ index: 0, status: 'sent' }] }).success).toBe(true);
  });

  it('carries the bounded detail on the worker sendResult event and refuses an unsafe one', () => {
    const base = { type: 'sendResult', accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, requestId: 'r', status: 'failed', messageId: null, error: 'UPLOAD_FAILED' };
    expect(LineWorkerEventSchema.safeParse({ ...base, detail: 'obs_upload:ObsHttpError:403' }).success).toBe(true);
    expect(LineWorkerEventSchema.safeParse(base).success).toBe(true);
    expect(LineWorkerEventSchema.safeParse({ ...base, detail: '/private/path' }).success).toBe(false);
    expect(LineWorkerEventSchema.safeParse({ ...base, detail: 'x'.repeat(121) }).success).toBe(false);
  });

  it('appends a safe detail to a local result failure text and keeps the old text without one', () => {
    expect(lineResultErrorMessage('UPLOAD_FAILED', 'fallback')).toBe('UPLOAD_FAILED');
    expect(lineResultErrorMessage('UPLOAD_FAILED', 'fallback', 'obs_upload:ObsHttpError:403')).toBe('UPLOAD_FAILED:obs_upload:ObsHttpError:403');
    expect(lineResultErrorMessage('UPLOAD_FAILED', 'fallback', '/private/path')).toBe('UPLOAD_FAILED');
    expect(lineResultErrorMessage('SOMETHING_ELSE', 'fallback', 'obs_upload')).toBe('fallback');
    expect(lineResultErrorMessage(null, 'fallback', 'obs_upload')).toBe('fallback');
  });
});
