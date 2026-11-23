import { describe, expect, it } from 'vitest';
import {
  McpInternalToolNameSchema, McpReadMessageAttachmentInputSchema, McpReadMessageAttachmentOutputSchema, McpToolNameSchema, READ_MESSAGE_ATTACHMENT_TOOL_NAME,
} from './index.js';

describe('read_message_attachment contract', () => {
  it('is an internal tool and not an external token scope', () => {
    expect(McpInternalToolNameSchema.safeParse(READ_MESSAGE_ATTACHMENT_TOOL_NAME).success).toBe(true);
    expect(McpToolNameSchema.safeParse(READ_MESSAGE_ATTACHMENT_TOOL_NAME).success).toBe(false);
  });

  it('accepts only a bounded attachmentId', () => {
    expect(McpReadMessageAttachmentInputSchema.safeParse({ attachmentId: 'a'.repeat(128) }).success).toBe(true);
    for (const bad of [{}, { attachmentId: '' }, { attachmentId: 'a'.repeat(129) }, { attachmentId: 'x', extra: 1 }]) {
      expect(McpReadMessageAttachmentInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('keeps the output strict', () => {
    const base = { attachmentId: 'a', name: 'f.pdf', kind: 'file', mimeType: null, sizeBytes: 3, status: 'ready', available: true,
      relativePath: '.agent-attachments/j/f.pdf', absolutePath: 'C:\w\.agent-attachments\j\f.pdf', reason: null };
    expect(McpReadMessageAttachmentOutputSchema.safeParse(base).success).toBe(true);
    expect(McpReadMessageAttachmentOutputSchema.safeParse({ ...base, available: false, relativePath: null, absolutePath: null, status: 'expired', reason: 'Not here.' }).success).toBe(true);
    expect(McpReadMessageAttachmentOutputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
