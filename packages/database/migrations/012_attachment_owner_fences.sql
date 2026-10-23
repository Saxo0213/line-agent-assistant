CREATE TABLE attachment_execution_owners (
  owner_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX attachment_execution_owners_revoked_idx
  ON attachment_execution_owners(revoked_at)
  WHERE revoked_at IS NOT NULL;
