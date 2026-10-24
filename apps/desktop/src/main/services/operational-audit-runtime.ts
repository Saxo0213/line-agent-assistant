import type { Pool } from 'pg';
import { AuditRepository } from '@line-agent/database';
import type { SafeAuditRecord } from '@line-agent/database';
import { createOperationalAudit } from './operational-audit.js';
import { OperationalAuditFallback } from './operational-audit-fallback.js';

export function createOperationalAuditRuntime(pool: Pool, directory: string) {
  const database = new AuditRepository(pool);
  const fallback = new OperationalAuditFallback(directory);
  const audit = createOperationalAudit({
    append: (event) => database.append(event),
    appendFallback: (event) => fallback.append(event),
    logSinkState(state, errorCode, droppedCount) {
      console.warn(JSON.stringify({ event: `operational_audit_sink_${state}`, errorCode, droppedCount }));
    },
  });
  return {
    ...audit,
    waitForReadDrain: () => database.waitForReadDrain(),
    async listEvents(limit = 500, onUpdate?: (result: AuditEventsReadResult) => void): Promise<AuditEventsReadResult> {
      const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      let db: { events: SafeAuditRecord[]; failed: boolean } | undefined;
      let file: { events: SafeAuditRecord[]; failed: boolean } | undefined;
      const publish = () => {
        const values = [db, file].filter((value): value is NonNullable<typeof value> => value !== undefined);
        const merged = new Map<string, SafeAuditRecord>();
        for (const source of [...values, { events: audit.sinkEvents() }]) for (const event of source.events) {
          merged.set(`${event.correlationId}:${event.action}:${event.phase}:${event.createdAt}`, event);
        }
        onUpdate?.({ events: [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, boundedLimit),
          available: values.some((value) => !value.failed), partial: values.length < 2 || values.some((value) => value.failed)
            || audit.health().databaseFailed || audit.health().fallbackFailed || audit.health().droppedCount > 0 });
      };
      const dbRead = database.list(boundedLimit).then((events) => { db = { events, failed: false }; publish(); }, () => { db = { events: [], failed: true }; publish(); });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fallbackRead = fallback.listStrict(boundedLimit, controller.signal)
        .then((events) => { file = { events, failed: false }; publish(); }, () => { file = { events: [], failed: true }; publish(); });
      timer = setTimeout(() => controller.abort(new Error('AUDIT_FALLBACK_TIMEOUT')), 5000);
      try { await Promise.all([dbRead, fallbackRead]); }
      finally { if (timer) clearTimeout(timer); }
      const merged = new Map<string, SafeAuditRecord>();
      for (const source of [db, file, { events: audit.sinkEvents() }]) for (const event of source?.events ?? []) {
        merged.set(`${event.correlationId}:${event.action}:${event.phase}:${event.createdAt}`, event);
      }
      const available = Boolean(db && !db.failed || file && !file.failed);
      return { events: [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, boundedLimit),
        available, partial: !db || !file || Boolean(db?.failed || file?.failed) || audit.health().databaseFailed
          || audit.health().fallbackFailed || audit.health().droppedCount > 0 };
    },
  };
}

export type AuditEventsReadResult = { events: SafeAuditRecord[]; available: boolean; partial: boolean };
