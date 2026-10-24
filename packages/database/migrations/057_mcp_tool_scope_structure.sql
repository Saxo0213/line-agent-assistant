CREATE FUNCTION mcp_tool_scopes_structurally_valid(scopes text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(cardinality(scopes) BETWEEN 1 AND 64, false)
    AND COALESCE(array_ndims(scopes) = 1, false)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(scopes) AS item(value)
      WHERE value IS NULL OR char_length(value) NOT BETWEEN 1 AND 128
    );
$$;

ALTER TABLE mcp_agent_tokens
  DROP CONSTRAINT mcp_agent_tokens_tool_scopes_check;
ALTER TABLE mcp_agent_tokens
  ADD CONSTRAINT mcp_agent_tokens_tool_scopes_check
  CHECK (mcp_tool_scopes_structurally_valid(tool_scopes));

ALTER TABLE mcp_agent_audit
  DROP CONSTRAINT mcp_agent_audit_tool_name_check;
ALTER TABLE mcp_agent_audit
  ADD CONSTRAINT mcp_agent_audit_tool_name_check
  CHECK (tool_name IS NULL OR char_length(tool_name) BETWEEN 1 AND 128);
