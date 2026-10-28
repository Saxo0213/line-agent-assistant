-- Schedules may start a random 0..5 minutes after the nominal time. next_fire_at is the delayed due time;
-- next_nominal_at is the undelayed occurrence it belongs to (the run's scheduled_for).
ALTER TABLE agent_schedules
  ADD COLUMN jitter_minutes smallint NOT NULL DEFAULT 0 CHECK (jitter_minutes BETWEEN 0 AND 5),
  ADD COLUMN next_nominal_at timestamptz;
UPDATE agent_schedules SET next_nominal_at = next_fire_at WHERE next_fire_at IS NOT NULL;
