import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentScheduleCreateInputSchema } from '@line-agent/contracts';
import { AgentScheduleRepository } from './agent-schedule-repository.js';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { ScheduleForwardRepository } from './schedule-forward-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('durable message forwarding schedule lifecycle', () => {
  let pool: Pool, close: () => Promise<void>, repo: AgentScheduleRepository;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); repo = new AgentScheduleRepository(pool); });
  afterAll(async () => { await close?.(); });
  const input = () => AgentScheduleCreateInputSchema.parse({ title: 'Forward', provider: 'claude', recurrence: { kind: 'message' },
    targets: [{ accountId: 'admin', chatType: 'group', chatId: 'source', title: 'Source' }],
    task: { type: 'message_forward', match: { mode: 'contains', keywords: ['hello'] } },
    delivery: { mode: 'line_target', target: { accountId: 'agent', chatType: 'group', chatId: 'destination', title: 'Destination' } } });
  it('keeps an event rule enabled without any due time through updates and toggles', async () => {
    const rule = await repo.create(input());
    expect(rule).toMatchObject({ enabled: true, nextFireAt: null, execution: 'program', mayUseLlm: false });
    expect((await repo.claimDue(new Date(Date.now() + 86400000))).claims).toEqual([]);
    await repo.update(rule.scheduleId, { enabled: false });
    expect(await repo.update(rule.scheduleId, { enabled: true })).toMatchObject({ enabled: true, nextFireAt: null });
    expect(await repo.update(rule.scheduleId, { title: 'Renamed' })).toMatchObject({ title: 'Renamed', enabled: true, nextFireAt: null });
    await expect(repo.update(rule.scheduleId, { recurrence: { kind: 'daily', time: '09:00' } })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
  });
  it('captures fresh original text and media atomically, suppresses archive and duplicates, and recovers only in-flight parts as unknown', async () => {
    await pool.query('DELETE FROM agent_schedules');
    const accounts=new AccountRepository(pool);
    await accounts.ensureAccount('agent');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='agent'");
    await accounts.activateControl('agent',1);
    await accounts.bindWorker({accountId:'agent',workerInstanceId:'w1',controlEpoch:1});
    await accounts.applyWorkerLogin({accountId:'agent',workerInstanceId:'w1',controlEpoch:1},'u-agent','Agent');
    const messages=new MessageRepository(pool), forwards=new ScheduleForwardRepository(pool);
    const rule=await repo.create({...input(),targets:[{accountId:'agent',chatType:'group',chatId:'source',title:'Source'}]});
    const cursor=(revision:string)=>({version:1 as const,revision,globalRev:'0',individualRev:'0'});
    const batch=(id:string,revision:number)=>({type:'batch' as const,accountId:'agent',workerInstanceId:'w1',controlEpoch:1,
      batchId:`b${revision}`,cursorBefore:cursor(String(revision-1)),cursorAfter:cursor(String(revision)),
      envelopes:[{accountId:'agent',eventId:id,chatType:'group' as const,chatId:'source',senderId:'u-alice',messageId:id,kind:'image' as const,
        text:'hello original',mentionIds:[],mentionRanges:[],replyToMessageId:null,ingestion:{source:'live' as const,cursor:null},
        occurredAt:new Date(Date.now()+1000).toISOString(),raw:{},attachments:[{id:`a-${id}`,kind:'image' as const,name:'原圖.png',mimeType:'image/png',sizeBytes:4}]}]});
    const startup=batch('startup',1);
    await messages.prepareBatchConversations(startup);
    await messages.ingestBatchSource(startup,new Set(),false);
    expect(await forwards.pending()).toEqual([]);
    const fresh=batch('fresh',2);
    await messages.prepareBatchConversations(fresh);
    await messages.ingestBatchSource(fresh,new Set(),true);
    await messages.ingestBatchSource(fresh,new Set(),true);
    const parts=(await pool.query('SELECT kind,text,state FROM agent_schedule_forward_parts ORDER BY part_index')).rows;
    expect(parts).toEqual([{kind:'text',text:'hello original',state:'pending'},{kind:'image',text:null,state:'waiting'}]);
    expect((await pool.query('SELECT count(*) FROM agent_schedule_forward_work')).rows[0].count).toBe('1');
    const first=(await forwards.pending())[0]!;
    expect(await forwards.valid(first)).toBe(true);
    await forwards.mark(first,'sending');
    await repo.recoverStale();
    expect((await repo.listRuns(rule.scheduleId))[0]!.outcome).toBe('submitting');
    await forwards.recover();
    expect((await repo.listRuns(rule.scheduleId))[0]!.outcome).toBe('send_unknown');
    expect((await pool.query('SELECT state FROM agent_schedule_forward_parts ORDER BY part_index')).rows).toEqual([{state:'unknown'},{state:'cancelled'}]);
    const queued=batch('disable-queued',3);
    await messages.prepareBatchConversations(queued);await messages.ingestBatchSource(queued,new Set(),true);
    const pending=(await forwards.pending())[0]!;expect(await forwards.valid(pending)).toBe(true);
    await repo.update(rule.scheduleId,{enabled:false});
    expect(await forwards.valid(pending)).toBe(false);await forwards.settle();
    expect((await pool.query('SELECT state FROM agent_schedule_forward_parts WHERE work_id=$1',[pending.workId])).rows).toEqual([{state:'cancelled'},{state:'cancelled'}]);
    await repo.delete(rule.scheduleId);
    const noRule=batch('normal-no-rule',4);
    await messages.prepareBatchConversations(noRule);
    expect(await messages.ingestBatchSource(noRule,new Set(),true)).toMatchObject({inserted:1});
    expect((await pool.query('SELECT count(*) FROM agent_schedule_forward_work')).rows[0].count).toBe('0');
  });
});
