ALTER TABLE external_source_conflicts
  DROP CONSTRAINT external_source_conflicts_conflict_reason_check,
  ADD CONSTRAINT external_source_conflicts_conflict_reason_check
    CHECK (conflict_reason IN ('SOURCE_ID_REUSED_WITH_CHANGED_DIGEST', 'CANONICAL_ARCHIVE_MISMATCH'));
