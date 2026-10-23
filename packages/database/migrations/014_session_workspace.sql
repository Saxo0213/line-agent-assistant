-- Legacy provider sessions deliberately remain unbound and cannot be resumed.
ALTER TABLE agent_sessions ADD COLUMN workspace_path text;
