ALTER TABLE attachments ADD COLUMN download_lease_expires_at timestamptz;

CREATE INDEX attachments_download_recovery_idx
  ON attachments (account_id, status, download_lease_expires_at)
  WHERE status = 'downloading';
