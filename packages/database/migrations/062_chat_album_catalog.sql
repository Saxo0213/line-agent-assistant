CREATE TABLE chat_album_scans (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  scan_generation bigint NOT NULL DEFAULT 0 CHECK (scan_generation >= 0),
  line_cursor text,
  previous_line_cursor text,
  previous_page_hash text,
  next_ordinal bigint NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id)
);

CREATE TABLE chat_albums (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  album_id text NOT NULL,
  title text,
  photo_count integer CHECK (photo_count IS NULL OR photo_count >= 0),
  create_time timestamptz,
  update_time timestamptz,
  list_generation bigint NOT NULL,
  list_ordinal bigint NOT NULL DEFAULT 0 CHECK (list_ordinal >= 0),
  photo_scan_generation bigint NOT NULL DEFAULT 0 CHECK (photo_scan_generation >= 0),
  photo_scan_cursor text,
  photo_scan_previous_cursor text,
  photo_scan_previous_page_hash text,
  photo_scan_next_ordinal bigint NOT NULL DEFAULT 0 CHECK (photo_scan_next_ordinal >= 0),
  photo_list_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id, album_id),
  FOREIGN KEY (account_id, chat_type, chat_id) REFERENCES chat_album_scans(account_id, chat_type, chat_id) ON DELETE CASCADE
);

CREATE TABLE chat_album_photos (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  album_id text NOT NULL,
  photo_id text NOT NULL,
  oid text NOT NULL,
  prefix text NOT NULL CHECK (prefix IN ('album/a', 'album/v')),
  shot_time timestamptz,
  width integer CHECK (width IS NULL OR width >= 0),
  height integer CHECK (height IS NULL OR height >= 0),
  photo_scan_generation bigint NOT NULL,
  photo_scan_ordinal bigint NOT NULL DEFAULT 0 CHECK (photo_scan_ordinal >= 0),
  archive_folder text,
  archive_file_name text,
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  byte_count bigint CHECK (byte_count IS NULL OR byte_count >= 0),
  archive_revision bigint CHECK (archive_revision IS NULL OR archive_revision > 0),
  saved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id, album_id, photo_id),
  FOREIGN KEY (account_id, chat_type, chat_id, album_id) REFERENCES chat_albums(account_id, chat_type, chat_id, album_id) ON DELETE CASCADE,
  CHECK ((archive_folder IS NULL AND archive_file_name IS NULL AND content_hash IS NULL AND byte_count IS NULL AND archive_revision IS NULL AND saved_at IS NULL)
      OR (archive_folder IS NOT NULL AND archive_file_name IS NOT NULL AND content_hash IS NOT NULL AND byte_count IS NOT NULL AND archive_revision IS NOT NULL AND saved_at IS NOT NULL))
);

CREATE INDEX chat_albums_page_idx ON chat_albums(account_id, chat_type, chat_id, list_generation, list_ordinal);
CREATE INDEX chat_album_photos_page_idx ON chat_album_photos(account_id, chat_type, chat_id, album_id, photo_scan_generation, photo_scan_ordinal);
