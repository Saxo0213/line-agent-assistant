ALTER TABLE line_accounts DROP CONSTRAINT line_accounts_status_check;
ALTER TABLE line_accounts ADD CONSTRAINT line_accounts_status_check
  CHECK (status IN ('connected', 'disconnected', 'degraded', 'reauth_required'));
