ALTER TABLE album_notification_tasks
  DROP CONSTRAINT album_notification_tasks_error_stage_check,
  ADD CONSTRAINT album_notification_tasks_error_stage_check
    CHECK (error_stage IN ('archive_scan', 'album_list', 'album_list_pagination', 'album_photos', 'photo_download',
      'photo_pagination', 'archive_contains', 'archive_write', 'source_validation', 'unknown'));
