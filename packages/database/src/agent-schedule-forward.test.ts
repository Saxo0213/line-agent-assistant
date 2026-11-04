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
    expect(parts).toEqual([{kind:'text',text:'u-alice: hello original',state:'pending'},{kind:'image',text:null,state:'waiting'}]);
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
  it('prefixes the first forwarded text part with the sender name and keeps the name rules', async () => {
    await pool.query('DELETE FROM agent_schedules');
    const messages=new MessageRepository(pool);
    const cursor=(revision:string)=>({version:1 as const,revision,globalRev:'0',individualRev:'0'});
    const current=Number((await pool.query("SELECT cursor FROM external_source_checkpoints WHERE account_id='agent'")).rows[0]?.cursor?.revision ?? '0');
    let revision=current;
    const send=async (id:string,senderId:string,text:string,attachments:Array<{id:string;kind:'image';name:string;mimeType:string;sizeBytes:number}>=[])=>{
      const next=++revision;
      const batch={type:'batch' as const,accountId:'agent',workerInstanceId:'w1',controlEpoch:1,batchId:`n${next}`,
        cursorBefore:cursor(String(next-1)),cursorAfter:cursor(String(next)),
        envelopes:[{accountId:'agent',eventId:id,chatType:'group' as const,chatId:'source',senderId,messageId:id,
          kind:(attachments.length?'image':'text') as 'image'|'text',text,mentionIds:[],mentionRanges:[],replyToMessageId:null,
          ingestion:{source:'live' as const,cursor:null},occurredAt:new Date(Date.now()+1000).toISOString(),raw:{},attachments}]};
      await messages.prepareBatchConversations(batch);
      await messages.ingestBatchSource(batch,new Set(),true);
      const work=(await pool.query('SELECT work_id,sender_name FROM agent_schedule_forward_work WHERE message_id=$1',[id])).rows[0];
      const parts=(await pool.query('SELECT kind,text FROM agent_schedule_forward_parts WHERE work_id=$1 ORDER BY part_index',[work.work_id])).rows;
      return {senderName:work.sender_name as string,parts};
    };
    const rule=async (label?:string,mid?:string,mode:'contains'|'sender'='contains')=>repo.create(AgentScheduleCreateInputSchema.parse({ title: 'Forward', provider: 'claude', recurrence: { kind: 'message' },
      targets: [{ accountId: 'agent', chatType: 'group', chatId: 'source', title: 'Source' }],
      task: { type: 'message_forward', match: mode==='sender'?{ mode: 'sender' }:{ mode: 'contains', keywords: ['go'] }, ...(mid?{sender:{accountId:'agent',mid,label}}:{}) },
      delivery: { mode: 'line_target', target: { accountId: 'agent', chatType: 'group', chatId: 'destination', title: 'Destination' } } })).then((created)=>created.scheduleId);
    const clear=async ()=>{ await pool.query('DELETE FROM agent_schedules'); };

    await rule();
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('agent','u-nick','Profile Nick','Saved Nick'),('agent','u-disp','Profile Only',NULL)");
    expect(await send('m-nick','u-nick','go 你好')).toEqual({senderName:'Saved Nick',parts:[{kind:'text',text:'Saved Nick: go 你好'}]});
    expect(await send('m-disp','u-disp','go 你好')).toEqual({senderName:'Profile Only',parts:[{kind:'text',text:'Profile Only: go 你好'}]});
    expect(await send('m-id','u-nobody','go')).toEqual({senderName:'u-nobody',parts:[{kind:'text',text:'u-nobody: go'}]});
    await clear();

    await rule('Rule Label','u-nobody');
    expect(await send('m-label','u-nobody','go')).toEqual({senderName:'Rule Label',parts:[{kind:'text',text:'Rule Label: go'}]});
    await clear();

    await rule();
    const name='A',limit=4900,prefix=`${name}: `;
    const body='go'+'x'.repeat(limit-prefix.length-2)+'y'.repeat(10);
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ('agent','u-a','A')");
    const long=await send('m-long','u-a',body);
    expect(long.parts.map((part)=>part.text)).toEqual([(prefix+body).slice(0,limit),(prefix+body).slice(limit)]);
    expect(long.parts[0]!.text).toHaveLength(limit);
    expect(long.parts.map((part)=>part.text).join('')).toBe(prefix+body);
    const pairBody='go'+'x'.repeat(limit-prefix.length-3)+'😀tail';
    const pair=await send('m-pair','u-a',pairBody);
    expect(pair.parts.map((part)=>part.text)).toEqual([(prefix+pairBody).slice(0,limit-1),(prefix+pairBody).slice(limit-1)]);
    expect(pair.parts.map((part)=>part.text).join('')).toBe(prefix+pairBody);
    await clear();

    await rule('','u-a','sender');
    const media=await send('m-media','u-a','',[{id:'a-m-media',kind:'image',name:'p.png',mimeType:'image/png',sizeBytes:4}]);
    expect(media.parts).toEqual([{kind:'text',text:'A:'},{kind:'image',text:null}]);
    await clear();

    await rule();
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ('agent','u-nl',E'Line\r\nBreak\t\tName'),('agent','u-big',$1)",['長'.repeat(150)]);
    const nl=await send('m-nl','u-nl','go');
    expect(nl).toEqual({senderName:'Line Break Name',parts:[{kind:'text',text:'Line Break Name: go'}]});
    const big=await send('m-big','u-big','go');
    expect(big.senderName).toBe('長'.repeat(100));
    expect(big.parts).toEqual([{kind:'text',text:`${'長'.repeat(100)}: go`}]);
    await clear();
  });
});
