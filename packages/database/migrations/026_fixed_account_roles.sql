-- Conservatively identify the existing pair from verified account IDs only.
-- Any incomplete, conflicting, or ambiguous legacy state stays unclassified.
DO $$
BEGIN
  IF (SELECT count(*) FROM line_accounts WHERE own_mid IS NOT NULL) = 2
    AND (SELECT count(*) FROM account_administrators WHERE role = 'PRIMARY_ADMIN') = 1
    AND NOT EXISTS (SELECT 1 FROM line_accounts WHERE product_role IS NOT NULL)
    AND EXISTS (
      SELECT 1
      FROM account_administrators admin
      JOIN line_accounts admin_account ON admin_account.account_id = admin.account_id
      JOIN line_accounts agent ON agent.account_id <> admin.account_id AND agent.own_mid = admin.user_id
      WHERE admin.role = 'PRIMARY_ADMIN' AND admin_account.own_mid IS NOT NULL
        AND (SELECT count(*) FROM line_accounts WHERE own_mid IS NOT NULL) = 2
    ) THEN
    UPDATE line_accounts agent SET product_role = 'AGENT', role_revision = role_revision + 1
    WHERE agent.account_id = (SELECT account_id FROM account_administrators WHERE role = 'PRIMARY_ADMIN');
    UPDATE line_accounts admin SET product_role = 'PRIMARY_ADMIN', role_revision = role_revision + 1
    WHERE admin.account_id <> (SELECT account_id FROM account_administrators WHERE role = 'PRIMARY_ADMIN')
      AND admin.own_mid = (SELECT user_id FROM account_administrators WHERE role = 'PRIMARY_ADMIN');
  END IF;
END;
$$;

CREATE UNIQUE INDEX line_accounts_one_product_role_idx
  ON line_accounts (product_role) WHERE product_role IS NOT NULL;
