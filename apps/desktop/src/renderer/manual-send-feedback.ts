import type { ConversationKey } from '@line-agent/contracts';

export type ManualSendFeedback = {
  id: string;
  key: ConversationKey;
  routeKey: string;
  text: string;
  replyToMessageId: string | null;
  createdAt: string;
  status: 'pending' | 'failed' | 'unknown';
};

export const MANUAL_SEND_FEEDBACK_LIMIT = 100;

export function addManualSendFeedback(entries: ManualSendFeedback[], entry: ManualSendFeedback): ManualSendFeedback[] | null {
  if (entries.length >= MANUAL_SEND_FEEDBACK_LIMIT) {
    const oldestSettled = entries.findIndex((candidate) => candidate.status !== 'pending');
    if (oldestSettled === -1) return null;
    return [...entries.slice(0, oldestSettled), ...entries.slice(oldestSettled + 1), entry];
  }
  return [...entries, entry];
}
