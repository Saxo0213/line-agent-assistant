-- Extra Agent tools (docs/architecture/agent-mcp-extensions.md).
-- agent_mcp_servers: user-configured MCP servers for eligible Agent jobs. Env and header values are never stored in the
-- clear: secrets_cipher holds the sealed JSON {"env":{...},"headers":{...}}; env_keys/header_keys keep only the key names.
-- The built-in tool additions live in app_settings under the key agent_extension_tools.

CREATE TABLE agent_mcp_servers (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE
    CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$' AND name <> 'linejs' AND name NOT LIKE 'claude\_ai%'),
  transport text NOT NULL CHECK (transport IN ('stdio', 'http')),
  command text,
  args jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(args) = 'array'),
  url text,
  env_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(env_keys) = 'array'),
  header_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(header_keys) = 'array'),
  secrets_cipher text,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL CHECK (source IN ('manual', 'claude-code', 'claude-desktop', 'codex')),
  providers jsonb NOT NULL CHECK (jsonb_typeof(providers) = 'array' AND jsonb_array_length(providers) BETWEEN 1 AND 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((transport = 'stdio' AND command IS NOT NULL AND url IS NULL) OR (transport = 'http' AND url IS NOT NULL AND command IS NULL))
);
