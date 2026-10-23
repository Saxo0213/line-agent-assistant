ALTER TABLE attachments ADD COLUMN download_attempt_token uuid;
ALTER TABLE attachments ADD COLUMN download_owner_id uuid;
ALTER TABLE attachments ADD COLUMN download_worker_binding_epoch bigint;

-- Any pre-fence lease has no attempt identity and cannot safely publish a result.
UPDATE attachments
SET status = 'failed', download_worker_instance_id = NULL, download_lease_expires_at = NULL,
    download_attempt_token = NULL, download_owner_id = NULL, download_worker_binding_epoch = NULL, retry_after = now(),
    error = 'Attachment attempt requires recovery', updated_at = now()
WHERE status = 'downloading';

CREATE INDEX attachments_download_owner_idx
  ON attachments (download_owner_id, download_attempt_token)
  WHERE status = 'downloading';
