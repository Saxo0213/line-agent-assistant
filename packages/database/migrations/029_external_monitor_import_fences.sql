ALTER TABLE line_account_sources
  ADD COLUMN admin_binding_account_id text,
  ADD COLUMN admin_binding_mid text,
  ADD COLUMN admin_binding_version bigint,
  ADD CONSTRAINT line_account_sources_admin_binding_complete_check CHECK (
    (admin_binding_account_id IS NULL AND admin_binding_mid IS NULL AND admin_binding_version IS NULL)
    OR (admin_binding_account_id IS NOT NULL AND admin_binding_mid IS NOT NULL
      AND admin_binding_version IS NOT NULL AND admin_binding_version > 0)
  );
