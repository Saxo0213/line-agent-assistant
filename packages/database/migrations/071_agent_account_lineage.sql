-- Agent account lineage: the ordered list of LINE accounts that have served as the Agent.
-- Storage stays per account; this table is the single aggregation key for search, MCP reads and Agent memory.
CREATE TABLE agent_account_lineage (
  account_id text PRIMARY KEY REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  sequence integer NOT NULL UNIQUE CHECK (sequence > 0),
  became_agent_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (retired_at IS NULL OR retired_at >= became_agent_at)
);
CREATE UNIQUE INDEX agent_account_lineage_one_current_idx ON agent_account_lineage ((true)) WHERE retired_at IS NULL;

-- Backfill rule. Only Agent replacement clears product_role and increments role_revision (same provenance rule as
-- managed-mcp-scopes.ts): a former Agent is an account with product_role NULL, role_revision >= 1, a verified own_mid and
-- the retired offline shape written by replacement (MONITOR_ONLY, disconnected, OFFLINE, no worker, no selected source).
-- Unclassified legacy accounts keep role_revision 0 and never match. Former Agents are ordered by creation time;
-- the current AGENT account (if any) follows them with retired_at NULL.
WITH former AS (
  SELECT a.account_id, a.created_at,
         COALESCE((SELECT max(s.retired_at) FROM line_account_sources s WHERE s.account_id = a.account_id), a.updated_at) AS retired_at,
         row_number() OVER (ORDER BY a.created_at, a.account_id) AS rn
  FROM line_accounts a
  WHERE a.product_role IS NULL AND a.role_revision >= 1 AND a.own_mid IS NOT NULL
    AND a.mode = 'MONITOR_ONLY' AND a.status = 'disconnected' AND a.connection_mode = 'OFFLINE'
    AND a.worker_instance_id IS NULL AND a.worker_binding_epoch IS NULL
    AND a.selected_source_id IS NULL AND a.selected_source_generation IS NULL
)
INSERT INTO agent_account_lineage(account_id, sequence, became_agent_at, retired_at)
SELECT account_id, rn::integer, created_at, GREATEST(retired_at, created_at) FROM former;

INSERT INTO agent_account_lineage(account_id, sequence, became_agent_at, retired_at)
SELECT a.account_id, (SELECT COALESCE(max(sequence), 0) + 1 FROM agent_account_lineage), a.created_at, NULL
FROM line_accounts a WHERE a.product_role = 'AGENT';
