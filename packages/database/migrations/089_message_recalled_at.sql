ALTER TABLE messages ADD COLUMN recalled_at timestamptz;

-- recalled_at is the time the system first stored the recall over the row (detection time), not a LINE server time.
-- A row that is first stored already recalled has no time (INSERT is not covered), and existing rows are not backfilled.
CREATE FUNCTION set_message_recalled_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content->>'type' = 'unsent' THEN
    IF OLD.content->>'type' IS DISTINCT FROM 'unsent' THEN
      NEW.recalled_at := now();
    ELSE
      NEW.recalled_at := OLD.recalled_at;
    END IF;
  ELSE
    NEW.recalled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_set_recalled_at
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION set_message_recalled_at();
