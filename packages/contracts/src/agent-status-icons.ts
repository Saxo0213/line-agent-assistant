import { z } from 'zod';

const AgentStatusIconSchema = z.string().max(16).refine(
  (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'Agent status icons must be nonblank, control-character-free text of at most 16 UTF-16 code units',
);

export const AgentStatusIconsSchema = z.strictObject({
  queued: AgentStatusIconSchema,
  running: AgentStatusIconSchema,
  completed: AgentStatusIconSchema,
  failed: AgentStatusIconSchema,
  cancelled: AgentStatusIconSchema,
  interrupted: AgentStatusIconSchema,
});
export type AgentStatusIcons = z.infer<typeof AgentStatusIconsSchema>;

export const DEFAULT_AGENT_STATUS_ICONS: AgentStatusIcons = {
  queued: '◷',
  running: '▶',
  completed: '✓',
  failed: '!',
  cancelled: '■',
  interrupted: 'Ⅱ',
};
