-- Scheduled Agent triggers: delivery mode primary_admin (the new default). Read targets may be any readable chat type;
-- 069 put no CHECK on target chat types, so only the delivery mode CHECK changes. Existing rows stay valid.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'agent_schedules'::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%delivery%' AND pg_get_constraintdef(con.oid) LIKE '%agent_room%'
  LOOP
    EXECUTE format('ALTER TABLE agent_schedules DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE agent_schedules
  ADD CONSTRAINT agent_schedules_delivery_mode_check
  CHECK (jsonb_typeof(delivery) = 'object' AND delivery->>'mode' IN ('primary_admin', 'agent_room', 'line_target'));

ALTER TABLE agent_schedules ALTER COLUMN delivery SET DEFAULT '{"mode":"primary_admin"}'::jsonb;
