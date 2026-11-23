-- A chat's Claude model set by the Primary Administrator's /model command. NULL uses the bridge default.
ALTER TABLE conversations ADD COLUMN claude_model text NULL CHECK (claude_model IS NULL OR claude_model IN ('haiku','sonnet','opus'));
