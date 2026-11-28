import { describe, expect, it } from 'vitest';
import { scanReplyPatterns } from './reply-audit-patterns.js';
import { parseReplyAuditVerdict, replyAuditDetail, ReplyAuditService, type ReplyAuditRecord, type ReplyRequester } from './reply-audit-service.js';

const MID = `u${'a1'.repeat(16)}`;
const CHAT = `c${'0f'.repeat(16)}`;

describe('reply pattern scan', () => {
  it('finds each category and leaves plain text alone', () => {
    expect(scanReplyPatterns('目前版本 1.0.413')).toEqual(['version']);
    expect(scanReplyPatterns('app 2.7.1 is running', { appVersion: '2.7.1' })).toEqual(['version']);
    expect(scanReplyPatterns('see C:\\Users\\x\\file.txt')).toEqual(['path']);
    expect(scanReplyPatterns('資料在 lineagentassistant 資料夾')).toEqual(['path']);
    expect(scanReplyPatterns('see https://example.com/a')).toEqual([]);
    expect(scanReplyPatterns('檔案在 App 資料夾 和 本聊天室的工作資料夾\\notes.txt')).toEqual([]);
    expect(scanReplyPatterns('I used query_target_messages and list_schedules')).toEqual(['tool']);
    expect(scanReplyPatterns('my_list_targets_x')).toEqual([]);
    expect(scanReplyPatterns(`mid ${MID}`)).toEqual(['mid']);
    expect(scanReplyPatterns(`chat ${CHAT} and r${'b2'.repeat(16)}`)).toEqual(['chat_id']);
    expect(scanReplyPatterns('今天天氣很好，版本 2.0 的功能不錯。')).toEqual([]);
    expect(scanReplyPatterns(`1.0.9 ${MID} list_targets C:\\a`)).toEqual(['version', 'path', 'tool', 'mid']);
  });
});

describe('reply audit verdict parse', () => {
  it('accepts one strict JSON object and clips the reason', () => {
    expect(parseReplyAuditVerdict('{"allow":true,"category":"none","reason":"ok"}')).toEqual({ allow: true, category: 'none', reason: 'ok' });
    expect(parseReplyAuditVerdict('```json\n{"allow":false,"category":"system_info","reason":"' + 'x'.repeat(200) + '"}\n```').reason).toHaveLength(80);
  });
  it('rejects anything else', () => {
    for (const text of ['', 'allow', 'yes {"allow":true}', '{"allow":"true","category":"none","reason":""}', '{"allow":true,"category":"bad","reason":""}',
      '{"allow":true,"category":"none"}', '[1]', 'null']) expect(() => parseReplyAuditVerdict(text), text).toThrow();
  });
});

describe('reply audit decisions', () => {
  const job = { jobId: 'j1', accountId: 'acc', chatType: 'group', sourceType: 'line', prompt: 'hello' };
  function setup(options: { requester?: ReplyRequester; answers?: Array<string | Error | 'hang'>; timeoutMs?: number } = {}) {
    const records: ReplyAuditRecord[] = [];
    const drafts: string[] = [];
    const prompts: string[] = [];
    const answers = [...(options.answers ?? [])];
    const service = new ReplyAuditService({
      requester: async () => options.requester ?? 'member',
      judge: async ({ prompt }) => {
        prompts.push(prompt);
        const next = answers.shift();
        if (next === undefined) throw new Error('no answer');
        if (next === 'hang') return new Promise<string>(() => undefined);
        if (next instanceof Error) throw next;
        return next;
      },
      record: (entry) => { records.push(entry); },
      keepDraft: async (_jobId, draft) => { drafts.push(draft); },
      blockedText: '此項由管理者管理。',
      patterns: { appVersion: '1.0.413' },
      timeoutMs: options.timeoutMs ?? 200,
    });
    return { service, records, drafts, prompts };
  }
  const allow = '{"allow":true,"category":"none","reason":"ok"}';
  const deny = '{"allow":false,"category":"system_info","reason":"version"}';

  it('allow without a hit sends the text and writes nothing', async () => {
    const t = setup({ answers: [allow] });
    expect(await t.service.review(job, ['你好'])).toEqual({ kind: 'pass' });
    expect(t.records).toEqual([]);
  });
  it('allow with a hit sends the text and records allowed', async () => {
    const t = setup({ answers: [allow] });
    expect(await t.service.review(job, ['版本 1.0.413'])).toEqual({ kind: 'pass' });
    expect(t.records).toEqual([{ accountId: 'acc', jobId: 'j1', resultCode: 'allowed', detail: 'hits:version:category:none' }]);
    expect(JSON.stringify(t.records)).not.toContain('1.0.413 ');
  });
  it('block gives the fixed text, a record and the kept draft', async () => {
    const t = setup({ answers: [deny] });
    expect(await t.service.review(job, ['版本 1.0.413', 'C:\\x\\y'])).toEqual({ kind: 'block', text: '此項由管理者管理。' });
    expect(t.records).toEqual([{ accountId: 'acc', jobId: 'j1', resultCode: 'blocked', detail: 'hits:version.path:category:system_info' }]);
    expect(t.drafts).toEqual(['版本 1.0.413\n\nC:\\x\\y']);
  });
  it('a judge timeout with a hit blocks, within the limit', async () => {
    const t = setup({ answers: ['hang'], timeoutMs: 40 });
    const started = Date.now();
    expect(await t.service.review(job, [`mid ${MID}`])).toEqual({ kind: 'block', text: '此項由管理者管理。' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.records).toEqual([{ accountId: 'acc', jobId: 'j1', resultCode: 'blocked', detail: 'hits:mid:category:judge_unavailable' }]);
    expect(t.drafts).toHaveLength(1);
  });
  it('a judge timeout without a hit sends the text and records judge_unavailable', async () => {
    const t = setup({ answers: ['hang'], timeoutMs: 40 });
    expect(await t.service.review(job, ['你好'])).toEqual({ kind: 'pass' });
    expect(t.records).toEqual([{ accountId: 'acc', jobId: 'j1', resultCode: 'judge_unavailable', detail: 'hits:none:category:judge_unavailable' }]);
    expect(t.drafts).toEqual([]);
  });
  it('an unparsable answer is a judge failure; a second try can still decide', async () => {
    const failed = setup({ answers: ['not json', 'still not json'] });
    expect(await failed.service.review(job, ['你好'])).toEqual({ kind: 'pass' });
    expect(failed.records[0]?.resultCode).toBe('judge_unavailable');
    expect(failed.prompts).toHaveLength(2);
    const retried = setup({ answers: [new Error('session lost'), deny] });
    expect(await retried.service.review(job, ['你好'])).toEqual({ kind: 'block', text: '此項由管理者管理。' });
  });
  it('one audit covers a reply of many parts', async () => {
    const t = setup({ answers: [allow] });
    await t.service.review(job, ['part one', 'part two', 'part three']);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('part one\n\npart two\n\npart three');
    expect(t.prompts[0]).toContain('Requester: member');
  });
  it('sends the first 1000 characters of the trigger message only', async () => {
    const t = setup({ answers: [allow] });
    await t.service.review({ ...job, prompt: `${'a'.repeat(1000)}TAIL` }, ['ok']);
    expect(t.prompts[0]).toContain('a'.repeat(1000));
    expect(t.prompts[0]).not.toContain('TAIL');
  });
  it('does not audit an admin job, a job that is not from LINE, or empty text', async () => {
    const admin = setup({ requester: 'admin' });
    expect(await admin.service.review(job, ['版本 1.0.413'])).toEqual({ kind: 'pass' });
    const room = setup({ answers: [deny] });
    expect(await room.service.review({ ...job, sourceType: 'ui' }, ['版本 1.0.413'])).toEqual({ kind: 'pass' });
    expect(await room.service.review(job, ['  '])).toEqual({ kind: 'pass' });
    expect(admin.prompts.length + room.prompts.length).toBe(0);
    expect(admin.records.length + room.records.length).toBe(0);
  });
  it('writes details with the audit table characters only', () => {
    expect(replyAuditDetail(['version', 'chat_id'], 'private_data')).toMatch(/^[A-Za-z0-9_.:-]{1,160}$/);
    expect(replyAuditDetail([], 'judge_unavailable')).toBe('hits:none:category:judge_unavailable');
  });
});
