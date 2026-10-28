ALTER TABLE room_activation_audit DROP CONSTRAINT IF EXISTS room_activation_audit_event_check;
ALTER TABLE room_activation_audit ADD CONSTRAINT room_activation_audit_event_check
  CHECK (event IN ('REQUESTED', 'CHALLENGE_MAY_HAVE_STARTED', 'CONFIRMED', 'CANCELLED', 'REVOKED', 'EXPIRED', 'EXHAUSTED', 'ADMIN_CHANGED', 'ADMIN_DIRECT_ENABLED'));
