ALTER TABLE chat_albums ADD COLUMN readable_folder_name text;
ALTER TABLE chat_albums ADD COLUMN readable_export_cursor bigint NOT NULL DEFAULT -1;
ALTER TABLE chat_albums ADD CONSTRAINT chat_albums_readable_export_cursor_valid CHECK (readable_export_cursor >= -1);
ALTER TABLE chat_albums ADD CONSTRAINT chat_albums_readable_folder_name_safe
  CHECK (readable_folder_name IS NULL OR (length(readable_folder_name) BETWEEN 1 AND 96 AND readable_folder_name !~ '[\\/:*?"<>|]' AND readable_folder_name !~ '[. ]$'));
ALTER TABLE chat_album_photos ADD COLUMN readable_file_name text;
ALTER TABLE chat_album_photos ADD CONSTRAINT chat_album_photos_readable_file_name_safe
  CHECK (readable_file_name IS NULL OR (length(readable_file_name) BETWEEN 1 AND 240 AND readable_file_name !~ '[\\/:*?"<>|]' AND readable_file_name !~ '[. ]$'));
