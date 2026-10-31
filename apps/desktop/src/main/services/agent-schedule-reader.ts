import type { AgentScheduleTarget, McpToolInputUnion, McpToolOutputUnion } from '@line-agent/contracts';
import { NEW_MESSAGES_RUN_MESSAGE_CAP, type ScheduleMessage } from './agent-schedule-rules.js';

export interface AgentScheduleMessageRead {
  messages: ScheduleMessage[];
  /** True when the read stopped at the cap of one run (NEW_MESSAGES_RUN_MESSAGE_CAP). */
  incomplete: boolean;
}
export type AgentScheduleMessageContext =
  | { sourceType: 'schedule'; accountScope: readonly string[] | null }
  | { sourceType: 'job'; jobId: string; generation: number; accountId: null };
export type AgentScheduleMessageReader = (input: { from: Date; to: Date; targets: readonly AgentScheduleTarget[]; context?: AgentScheduleMessageContext }) => Promise<AgentScheduleMessageRead>;

const PAGE_LIMIT = 200;

/**
 * Reads the messages of a window for a new_messages schedule through the same MCP tool, scope, redaction and audit as a scheduled
 * Agent run: query_target_messages_by_time, paged until hasMore is false. With no targets it makes one query without a selector
 * (every readable chat); with targets it queries each target. It stops at the run cap and then reports the result as incomplete.
 * `callTool` is McpService.callInternalTool with the schedule context.
 */
export function createScheduleMessageReader(callTool: (tool: McpToolInputUnion, context?: AgentScheduleMessageContext) => Promise<McpToolOutputUnion>): AgentScheduleMessageReader {
  return async ({ from, to, targets, context }) => {
    const messages: ScheduleMessage[] = [];
    const selectors: Array<Pick<AgentScheduleTarget, 'accountId' | 'chatType' | 'chatId'> | null> =
      targets.length > 0 ? targets.map((target) => ({ accountId: target.accountId, chatType: target.chatType, chatId: target.chatId })) : [null];
    for (const selector of selectors) {
      let cursor: string | undefined;
      for (;;) {
        const output = await callTool({ name: 'query_target_messages_by_time', arguments: {
          from: from.toISOString(), to: to.toISOString(), limit: PAGE_LIMIT, ...(selector ?? {}), ...(cursor ? { cursor } : {}),
        } }, context);
        if (output.toolName !== 'query_target_messages_by_time') throw new Error('Unexpected MCP output while reading schedule messages.');
        const room = NEW_MESSAGES_RUN_MESSAGE_CAP - messages.length;
        messages.push(...output.messages.slice(0, room));
        if (output.messages.length > room || (messages.length >= NEW_MESSAGES_RUN_MESSAGE_CAP && output.hasMore)) return { messages, incomplete: true };
        if (!output.hasMore || !output.nextCursor) break;
        cursor = output.nextCursor;
      }
    }
    return { messages, incomplete: false };
  };
}
