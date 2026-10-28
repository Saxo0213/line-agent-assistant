-- The per-chat Agent choice becomes an optional override set by the Primary Administrator's /agent command.
-- NULL follows the global default (app_settings.default_provider). No UI ever set the old column, so every existing value is the column default.
ALTER TABLE conversations ALTER COLUMN default_provider DROP DEFAULT;
ALTER TABLE conversations ALTER COLUMN default_provider DROP NOT NULL;
UPDATE conversations SET default_provider = NULL;
