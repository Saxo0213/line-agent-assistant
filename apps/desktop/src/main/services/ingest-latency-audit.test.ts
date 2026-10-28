import { expect, it } from 'vitest';
import { createOperationalAudit, parseOperationalAuditEvent, type AuditEvent } from './operational-audit.js';
import { projectSystemActivity } from './system-records.js';

const latency = { lineToMainMs: 21_000, mainIngestMs: 80, queueLength: 1, messageCount: 2, reemitCount: 4 };

it('records the split slow-ingest timings with numbers only and shows them as distinct system activity', async () => {
  const stored: AuditEvent[] = [];
  const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
  audit.observed('line_ingest_slow_upstream', { initiator: 'worker', accountId: 'acct', workerInstanceId: 'w1', latency });
  audit.observed('line_ingest_slow_main', { initiator: 'worker', accountId: 'acct', workerInstanceId: 'w1', latency: { ...latency, mainIngestMs: 6_000 } });
  await audit.flush();
  expect(stored.map((event) => [event.action, event.phase, event.latency?.mainIngestMs])).toEqual([
    ['line_ingest_slow_upstream', 'observed', 80], ['line_ingest_slow_main', 'observed', 6_000]]);
  expect(parseOperationalAuditEvent(JSON.parse(JSON.stringify(stored[0])))?.latency).toEqual(latency);
  expect(parseOperationalAuditEvent({ ...stored[0], latency: { ...latency, text: 'hello' } })).toBeNull();
  const rows = projectSystemActivity(stored.map((event) => ({ ...event, createdAt: event.createdAt })), []);
  expect(rows.map((row) => row.kind === 'audit' && row.action).sort()).toEqual(['LINE 訊息延遲（LINE 至本機）', 'LINE 訊息延遲（本機佇列／寫入）']);
  expect(JSON.stringify(rows)).not.toContain('21000');
});
