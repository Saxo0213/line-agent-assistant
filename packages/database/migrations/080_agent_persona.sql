-- Agent persona (docs/architecture/agent-persona.md): per-chat overrides set by the Primary Administrator's /persona command.
-- NULL follows the global value (app_settings agent_persona_description / agent_persona_liveliness).
ALTER TABLE conversations ADD COLUMN persona_description text
  CHECK (persona_description IS NULL OR length(persona_description) <= 500);
ALTER TABLE conversations ADD COLUMN persona_liveliness text
  CHECK (persona_liveliness IS NULL OR persona_liveliness IN ('quiet', 'normal', 'lively'));
