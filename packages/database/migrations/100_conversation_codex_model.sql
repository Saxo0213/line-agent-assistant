-- A chat's Codex model set by the Primary Administrator's /model command (CliTalkAgent model.rs rule). NULL uses the Codex default.
ALTER TABLE conversations ADD COLUMN codex_model text NULL CHECK (codex_model IS NULL OR (char_length(codex_model) BETWEEN 1 AND 128 AND codex_model ~ '^[A-Za-z0-9._:/-]+$' AND lower(codex_model) NOT IN ('haiku','sonnet','opus')));
