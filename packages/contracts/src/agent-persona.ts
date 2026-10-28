import { z } from 'zod';

/** Longest persona description (characters). */
export const AGENT_PERSONA_MAX_LENGTH = 500;

/** How readily the Agent speaks in a group free-mode chat (docs/architecture/agent-persona.md). */
export const AGENT_LIVELINESS_VALUES = ['quiet', 'normal', 'lively'] as const;
export const AgentLivelinessSchema = z.enum(AGENT_LIVELINESS_VALUES);
export type AgentLiveliness = z.infer<typeof AgentLivelinessSchema>;
export const DEFAULT_AGENT_LIVELINESS: AgentLiveliness = 'normal';

export const AgentPersonaSchema = z.strictObject({
  description: z.string().max(AGENT_PERSONA_MAX_LENGTH),
  liveliness: AgentLivelinessSchema,
});
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;
