import { describe, expect, it } from 'vitest';
import { AGENT_ATTACHMENT_LIMITS, AgentJobSummarySchema, AgentRunRequestSchema, IpcRequestSchema } from './index.js';

const MB = 1024 * 1024;
const file = (name: string, size = 4) => ({ name, bytes: new Uint8Array(size) });
const submit = (extra: Record<string, unknown>) => IpcRequestSchema.safeParse({ type: 'submitAgentRoomPrompt', requestId: 'r', provider: 'codex', prompt: 'hi', ...extra });

describe('Agent room attachment contract', () => {
  it('accepts a bounded list of named byte files and keeps the request strict', () => {
    expect(submit({ attachments: [file('a.png'), file('b.pdf')] }).success).toBe(true);
    expect(submit({}).success).toBe(true);
    expect(submit({ attachments: [{ name: 'a.png', bytes: new Uint8Array(1), path: 'C:\\x' }] }).success).toBe(false);
    expect(submit({ attachments: [{ name: 'a.png', path: 'C:\\secret.txt' }] }).success).toBe(false);
    expect(submit({ attachments: [{ name: 'a.png', bytes: 'AAAA' }] }).success).toBe(false);
    expect(submit({ attachmentPaths: ['C:\\x'] }).success).toBe(false);
  });

  it('enforces 10 files, 20 MiB each, 50 MiB in total and names of 1 to 255 characters', () => {
    expect(submit({ attachments: Array.from({ length: AGENT_ATTACHMENT_LIMITS.maxFiles }, (_, i) => file(`f${i}`)) }).success).toBe(true);
    expect(submit({ attachments: Array.from({ length: AGENT_ATTACHMENT_LIMITS.maxFiles + 1 }, (_, i) => file(`f${i}`)) }).success).toBe(false);
    expect(submit({ attachments: [file('big.bin', 20 * MB)] }).success).toBe(true);
    expect(submit({ attachments: [file('big.bin', 20 * MB + 1)] }).success).toBe(false);
    expect(submit({ attachments: [file('a', 20 * MB), file('b', 20 * MB), file('c', 10 * MB)] }).success).toBe(true);
    expect(submit({ attachments: [file('a', 20 * MB), file('b', 20 * MB), file('c', 10 * MB + 1)] }).success).toBe(false);
    expect(submit({ attachments: [file('')] }).success).toBe(false);
    expect(submit({ attachments: [file('n'.repeat(255))] }).success).toBe(true);
    expect(submit({ attachments: [file('n'.repeat(256))] }).success).toBe(false);
  });

  it('allows an empty prompt only when at least one file is attached', () => {
    expect(submit({ prompt: '', attachments: [file('a.png')] }).success).toBe(true);
    expect(submit({ prompt: '   ', attachments: [file('a.png')] }).success).toBe(true);
    expect(submit({ prompt: '' }).success).toBe(false);
    expect(submit({ prompt: '  ', attachments: [] }).success).toBe(false);
  });

  it('bounds the run request image paths and the display-only job summary', () => {
    const base = { jobId: 'j', provider: 'codex', source: { type: 'ui', requestId: 'r' }, prompt: 'p', workspacePath: 'C:\\w',
      tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval:false } };
    expect(AgentRunRequestSchema.safeParse({ ...base, imagePaths: ['C:\\w\\a.png'] }).success).toBe(true);
    expect(AgentRunRequestSchema.safeParse({ ...base, imagePaths: Array.from({ length: 11 }, (_, i) => `C:\\w\\${i}.png`) }).success).toBe(false);
    expect(AgentRunRequestSchema.safeParse({ ...base, imagePaths: [''] }).success).toBe(false);
    const summary = { jobId: 'j', accountId: null, chatType: null, chatId: null, provider: 'codex', prompt: 'p', status: 'queued', createdAt: '2026-10-20T00:00:00.000Z' };
    expect(AgentJobSummarySchema.safeParse({ ...summary, attachments: [{ name: 'a.png', size: 3, kind: 'image' }] }).success).toBe(true);
    expect(AgentJobSummarySchema.safeParse({ ...summary, attachments: [{ name: 'a.png', size: 3, kind: 'image', relativePath: '.agent-attachments/x/a.png' }] }).success).toBe(false);
  });
});
