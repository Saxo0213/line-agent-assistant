import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentScheduleCreateInputSchema } from '@line-agent/contracts';
import { AgentScheduleRepository } from './agent-schedule-repository.js';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { randomUUID } from 'node:crypto';
import { AgentRepository } from './agent-repository.js';
import { ScheduleForwardRepository, captureScheduleForward } from './schedule-forward-repository.js';

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
  it('invalidates queued forwarding work when the source message is recalled or source-deleted', async () => {
    await pool.query('DELETE FROM agent_schedules');
    const messages=new MessageRepository(pool), forwards=new ScheduleForwardRepository(pool);
    const cursor=(revision:string)=>({version:1 as const,revision,globalRev:'0',individualRev:'0'});
    let revision=Number((await pool.query("SELECT cursor FROM external_source_checkpoints WHERE account_id='agent'")).rows[0]?.cursor?.revision ?? '0');
    const ingest=async (id:string)=>{
      const next=++revision;
      const batch={type:'batch' as const,accountId:'agent',workerInstanceId:'w1',controlEpoch:1,batchId:`r${next}`,
        cursorBefore:cursor(String(next-1)),cursorAfter:cursor(String(next)),
        envelopes:[{accountId:'agent',eventId:id,chatType:'group' as const,chatId:'source',senderId:'u-alice',messageId:id,kind:'text' as const,
          text:'hello recalled',mentionIds:[],mentionRanges:[],replyToMessageId:null,ingestion:{source:'live' as const,cursor:null},
          occurredAt:new Date(Date.now()+1000).toISOString(),raw:{},attachments:[]}]};
      await messages.prepareBatchConversations(batch);
      await messages.ingestBatchSource(batch,new Set(),true);
    };
    const created=await repo.create({...input(),targets:[{accountId:'agent',chatType:'group',chatId:'source',title:'Source'}]});
    await ingest('fwd-live');
    const pending=(await forwards.pending()).find((part)=>part.workId!==undefined);
    expect(pending).toBeDefined();
    expect(await forwards.valid(pending!)).toBe(true);
    await pool.query("UPDATE messages SET content='{\"format\":1,\"type\":\"unsent\"}'::jsonb WHERE account_id='agent' AND message_id='fwd-live'");
    expect(await forwards.valid(pending!)).toBe(false);
    await pool.query("UPDATE messages SET content='{}'::jsonb WHERE account_id='agent' AND message_id='fwd-live'");
    expect(await forwards.valid(pending!)).toBe(true);
    await pool.query(`UPDATE messages SET raw=raw || '{"sourceDeleted":{"detectedAt":"2026-10-22T00:00:00.000Z"}}'::jsonb WHERE account_id='agent' AND message_id='fwd-live'`);
    expect(await forwards.valid(pending!)).toBe(false);
    await repo.delete(created.scheduleId);
  });
  describe('attachments of External Monitor messages', () => {
    const CODE='EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE';
    let revision=0, generation=100;
    const cursor=(value:string)=>({version:1 as const,revision:value,globalRev:'0',individualRev:'0'});
    const image=(id:string)=>({id,kind:'image' as const,name:id+'.png',mimeType:'image/png',sizeBytes:4});
    /** Store a message without any rule, so nothing is captured yet. */
    const store=async (id:string,text:string,attachments:ReturnType<typeof image>[])=>{
      await pool.query('DELETE FROM agent_schedules');
      revision=Number((await pool.query("SELECT cursor FROM external_source_checkpoints WHERE account_id='agent'")).rows[0]?.cursor?.revision ?? '0')+1;
      const batch={type:'batch' as const,accountId:'agent',workerInstanceId:'w1',controlEpoch:1,batchId:'x'+id,
        cursorBefore:cursor(String(revision-1)),cursorAfter:cursor(String(revision)),
        envelopes:[{accountId:'agent',eventId:id,chatType:'group' as const,chatId:'source',senderId:'u-ext',messageId:id,kind:'image' as const,text,mentionIds:[],mentionRanges:[],
          replyToMessageId:null,ingestion:{source:'live' as const,cursor:null},occurredAt:new Date(Date.now()+1000).toISOString(),raw:{},attachments}]};
      const messages=new MessageRepository(pool);
      await messages.prepareBatchConversations(batch);
      await messages.ingestBatchSource(batch,new Set(),false);
    };
    const markExternal=async (id:string)=>{
      const sourceId=randomUUID(), gen=generation++;
      await pool.query(`INSERT INTO line_account_sources(account_id,source_id,generation,source_type,state,identity_digest,verified_account_mid)
        VALUES ('agent',$1,$2,'EXTERNAL_MONITOR','RETIRED',repeat('a',64),'own-ext')`,[sourceId,gen]);
      await pool.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
        VALUES ($1,'agent',$2,'ext-batch',repeat('b',64),'{}'::jsonb)`,[sourceId,gen]);
      await pool.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
        VALUES ($1,'agent',$2,$3,'ext-batch',$4,repeat('c',64),'{}'::jsonb,'PROJECTED')`,[sourceId,gen,'obs-'+id,id]);
      await pool.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
        VALUES ('agent',$1,$2,$3,$4,'EXTERNAL_MONITOR',true)`,[id,sourceId,gen,'obs-'+id]);
    };
    const capture=async (id:string,text:string,order:string[],externalMonitor?:boolean,anyText=false)=>{
      await repo.create({...input(),...(anyText?{task:{type:'message_forward' as const,match:{mode:'sender' as const},sender:{accountId:'agent',mid:'u-ext'}}}:{}),targets:[{accountId:'agent',chatType:'group',chatId:'source',title:'Source'}]});
      expect(await captureScheduleForward(pool,{accountId:'agent',chatType:'group',chatId:'source',messageId:id,attachmentOrder:order,
        ...(externalMonitor?{externalMonitor}:{})},text)).toBe(1);
      const work=(await pool.query('SELECT work_id,run_id FROM agent_schedule_forward_work WHERE message_id=$1',[id])).rows[0];
      return {workId:work.work_id as string,runId:work.run_id as string};
    };
    const parts=async (workId:string)=>(await pool.query('SELECT kind,text,state,error_code,filename FROM agent_schedule_forward_parts WHERE work_id=$1 ORDER BY part_index',[workId])).rows;

    it('replaces the waiting image part by a notice and a failed part, and keeps the notice text pending after settle',async()=>{
      await store('e-img','hello',[image('e1')]);
      await markExternal('e-img');
      const {workId}=await capture('e-img','hello',['e1']);
      const rows=await parts(workId);
      expect(rows).toEqual([
        {kind:'text',text:'u-ext: hello\n[圖片]',state:'pending',error_code:null,filename:null},
        {kind:'image',text:null,state:'failed',error_code:CODE,filename:'e1.png'}]);
      await new ScheduleForwardRepository(pool).settle();
      expect((await parts(workId)).map((part)=>part.state)).toEqual(['pending','failed']);
    });
    it('uses a name and notice only text for an image-only message',async()=>{
      await store('e-only','',[image('e4')]);
      const {workId}=await capture('e-only','',['e4'],true,true);
      expect(await parts(workId)).toEqual([
        {kind:'text',text:'u-ext: [圖片]',state:'pending',error_code:null,filename:null},
        {kind:'image',text:null,state:'failed',error_code:CODE,filename:'e4.png'}]);
    });
    it('puts the notice on a new line after the text and counts repeated kinds',async()=>{
      await store('e-two','hello text',[image('e2'),image('e3')]);
      const {workId}=await capture('e-two','hello text',['e2','e3'],true);
      const rows=await parts(workId);
      expect(rows[0]).toMatchObject({kind:'text',text:'u-ext: hello text\n[圖片×2]',state:'pending'});
      expect(rows.slice(1)).toMatchObject([{kind:'image',state:'failed',error_code:CODE},{kind:'image',state:'failed',error_code:CODE}]);
      expect(rows.some((part)=>part.state==='waiting')).toBe(false);
    });
    it('keeps the waiting image part for a message that is not from an External Monitor',async()=>{
      await store('s-img','hello',[image('s1')]);
      const {workId}=await capture('s-img','hello',['s1']);
      expect(await parts(workId)).toEqual([
        {kind:'text',text:'u-ext: hello',state:'pending',error_code:null,filename:null},
        {kind:'image',text:null,state:'waiting',error_code:null,filename:'s1.png'}]);
    });
    it('fails an old waiting part of an External Monitor attachment in settle and ends the run as send_failed',async()=>{
      await store('o-img','hello',[image('o1')]);
      const {workId,runId}=await capture('o-img','hello',['o1']);
      await pool.query("UPDATE attachments SET status='queued' WHERE account_id='agent' AND message_id='o-img'");
      await markExternal('o-img');
      const forwards=new ScheduleForwardRepository(pool);
      await forwards.settle();
      expect((await parts(workId)).map((part)=>[part.state,part.error_code])).toEqual([['pending',null],['failed',CODE]]);
      const text=(await forwards.pending()).find((part)=>part.workId===workId)!;
      expect(await forwards.mark(text,'sending')).toBe(true);
      expect(await forwards.mark(text,'sent',null,true)).toBe(true);
      await forwards.settle();
      expect((await pool.query('SELECT outcome FROM agent_schedule_runs WHERE run_id=$1',[runId])).rows[0].outcome).toBe('send_failed');
    });
    it('still cancels pending parts after another failure',async()=>{
      await store('f-img','hello',[image('f1')]);
      const {workId}=await capture('f-img','hello',['f1']);
      await pool.query("UPDATE agent_schedule_forward_parts SET state='failed',error_code='download_failed' WHERE work_id=$1 AND part_index=1",[workId]);
      await new ScheduleForwardRepository(pool).settle();
      expect((await parts(workId)).map((part)=>[part.state,part.error_code])).toEqual([['cancelled','forwarding_cancelled'],['failed','download_failed']]);
    });
  });
  describe('mention rules and rule actions', () => {
    const destination = { accountId: 'agent', chatType: 'group' as const, chatId: 'destination', title: 'Destination' };
    const agentTarget = { accountId: 'agent', chatType: 'group' as const, chatId: 'agent-room', title: 'Agent room' };
    type Actions = { forward?: boolean; notify?: boolean; agent?: { prompt?: string; target: typeof agentTarget } | null };
    const rule = (title: string, match: Record<string, unknown>, actions?: Actions, extra: Record<string, unknown> = {}) => repo.create(AgentScheduleCreateInputSchema.parse({
      title, provider: 'claude', recurrence: { kind: 'message' }, targets: [],
      task: { type: 'message_forward', match: { mode: 'mention', members: [], ...match }, ...(actions ? { actions } : {}), ...extra },
      delivery: actions?.forward === false ? { mode: 'record_only' } : { mode: 'line_target', target: destination } }));
    const clearAll = async () => { await pool.query('DELETE FROM agent_schedules'); };
    let counter = 0;
    /** Store one group message in an account without capturing it. */
    const put = async (accountId: string, id: string, mentionIds: string[], opts: { text?: string; chatId?: string; senderId?: string } = {}) => {
      const chatId = opts.chatId ?? 'source';
      await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,'Mention group') ON CONFLICT DO NOTHING`, [accountId, chatId]);
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,text_content,content,content_rule_version,
        mention_ids,mention_ranges,ingestion_source,occurred_at,raw) VALUES ($1,$2,$3,$4,'group',$5,'text',$6,'{}'::jsonb,1,$7::jsonb,'[]'::jsonb,'live',
        clock_timestamp()+interval '2 seconds','{}'::jsonb)`, [accountId, id, 'ev-' + id + '-' + counter++, chatId, opts.senderId ?? 'u-alice', opts.text ?? 'hello', JSON.stringify(mentionIds)]);
    };
    const capture = (accountId: string, id: string, extra: object = {}) => captureScheduleForward(pool,
      { accountId, chatType: 'group', chatId: 'source', messageId: id, attachmentOrder: [], ...extra }, undefined);
    const works = async (id: string) => (await pool.query(`SELECT s.title,w.notify_state,w.agent_state,w.work_id,w.run_id,
      (SELECT count(*) FROM agent_schedule_forward_parts p WHERE p.work_id=w.work_id)::int AS parts
      FROM agent_schedule_forward_work w JOIN agent_schedules s USING(schedule_id) WHERE w.message_id=$1 ORDER BY s.title`, [id])).rows;
    const outcome = async (runId: string) => (await pool.query('SELECT outcome FROM agent_schedule_runs WHERE run_id=$1', [runId])).rows[0].outcome as string;

    beforeAll(async () => {
      await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('agent','direct','u-boss','u-boss','PRIMARY_ADMIN')
        ON CONFLICT DO NOTHING`);
    });

    it('selects a message by member MID, admin MID or everyone, over all readable chats', async () => {
      await clearAll();
      await rule('A member', { members: [{ accountId: 'agent', mid: 'u-bob' }] });
      await rule('B admin', { admin: true }, { forward: false, notify: true });
      await rule('C all', { all: true }, { forward: false, agent: { prompt: 'Answer', target: agentTarget } });
      const cases: Array<[string, string[], string[]]> = [
        ['mn-bob', ['u-bob'], ['A member']], ['mn-boss', ['u-boss', 'u-x'], ['B admin']], ['mn-all', ['@all'], ['C all']],
        ['mn-none', ['u-zed'], []], ['mn-empty', [], []], ['mn-two', ['u-bob', 'u-boss', '@all'], ['A member', 'B admin', 'C all']],
      ];
      for (const [id, mentions, expected] of cases) {
        await put('agent', id, mentions);
        expect(await capture('agent', id)).toBe(expected.length);
        expect((await works(id)).map((row) => row.title)).toEqual(expected);
      }
      const bob = (await works('mn-bob'))[0]!;
      expect(bob).toMatchObject({ notify_state: null, agent_state: null, parts: 1 });
      expect(await works('mn-boss')).toMatchObject([{ notify_state: 'pending', agent_state: null, parts: 0 }]);
      expect(await works('mn-all')).toMatchObject([{ notify_state: null, agent_state: 'pending', parts: 0 }]);
    });

    it('does not capture a mention of the admin when no admin MID is known or a mention of its own account sends', async () => {
      await clearAll();
      await rule('Admin', { admin: true }, { forward: false, notify: true });
      await put('agent', 'own-1', ['u-boss'], { senderId: 'u-agent' });
      expect(await capture('agent', 'own-1')).toBe(0);
      await pool.query("DELETE FROM account_administrators WHERE account_id='agent'");
      await put('agent', 'own-2', ['u-boss']);
      expect(await capture('agent', 'own-2')).toBe(0);
      await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('agent','direct','u-boss','u-boss','PRIMARY_ADMIN')`);
    });

    it('captures mention messages through the system login ingress path with empty targets', async () => {
      await clearAll();
      const created = await rule('Login', { admin: true }, { forward: false, notify: true });
      const messages = new MessageRepository(pool);
      const cursor = (value: string) => ({ version: 1 as const, revision: value, globalRev: '0', individualRev: '0' });
      const revision = Number((await pool.query("SELECT cursor FROM external_source_checkpoints WHERE account_id='agent'")).rows[0]?.cursor?.revision ?? '0') + 1;
      const batch = { type: 'batch' as const, accountId: 'agent', workerInstanceId: 'w1', controlEpoch: 1, batchId: 'mention-' + revision,
        cursorBefore: cursor(String(revision - 1)), cursorAfter: cursor(String(revision)),
        envelopes: ['u-boss', 'u-other'].map((mention, index) => ({ accountId: 'agent', eventId: 'login-' + index, chatType: 'group' as const, chatId: 'source', senderId: 'u-alice',
          messageId: 'login-' + index, kind: 'text' as const, text: '@someone hi', mentionIds: [mention],
          mentionRanges: [{ start: 0, end: 8, userId: mention }], replyToMessageId: null, ingestion: { source: 'live' as const, cursor: null },
          occurredAt: new Date(Date.now() + 1000 + index).toISOString(), raw: {}, attachments: [] })) };
      await messages.prepareBatchConversations(batch);
      await messages.ingestBatchSource(batch, new Set(), true);
      expect((await works('login-0')).map((row) => row.title)).toEqual(['Login']);
      expect(await works('login-1')).toEqual([]);
      const run = (await repo.listRuns(created.scheduleId))[0]!;
      expect(run.outcome).toBe('submitting');
    });

    it('captures a monitor copy and dedupes the Agent copy of one group message', async () => {
      await clearAll();
      const accounts = new AccountRepository(pool);
      await accounts.ensureAccount('admin');
      await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id='admin'");
      await accounts.activateControl('admin', 1);
      await accounts.bindWorker({ accountId: 'admin', workerInstanceId: 'w2', controlEpoch: 1 });
      await accounts.applyWorkerLogin({ accountId: 'admin', workerInstanceId: 'w2', controlEpoch: 1 }, 'u-boss', 'Boss');
      await rule('Dedupe', { all: true });
      await put('admin', 'dd-1', ['@all']);
      await put('agent', 'dd-1', ['@all']);
      await pool.query(`INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES ('admin','group','source','u-alice') ON CONFLICT DO NOTHING`);
      await pool.query(`INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES ('agent','group','source','u-agent') ON CONFLICT DO NOTHING`);
      // The monitor copy comes first; the Agent copy of the same logical message adds nothing.
      expect(await capture('admin', 'dd-1', { externalMonitor: true })).toBe(1);
      expect(await capture('agent', 'dd-1')).toBe(0);
      expect(await works('dd-1')).toHaveLength(1);
      // The other order.
      await put('admin', 'dd-2', ['@all']);
      await put('agent', 'dd-2', ['@all']);
      expect(await capture('agent', 'dd-2')).toBe(1);
      expect(await capture('admin', 'dd-2', { externalMonitor: true })).toBe(0);
      const row = (await pool.query("SELECT account_id,selected_source FROM agent_schedule_forward_work WHERE message_id='dd-2'")).rows[0];
      expect(row).toMatchObject({ account_id: 'agent', selected_source: { accountId: 'agent', ownMid: 'u-agent' } });
      // A group the admin account sees and the Agent does not: only the admin copy exists.
      await put('admin', 'dd-3', ['@all'], { chatId: 'admin-only' });
      expect(await captureScheduleForward(pool, { accountId: 'admin', chatType: 'group', chatId: 'admin-only', messageId: 'dd-3', externalMonitor: true })).toBe(1);
    });

    it('keeps the destination loop guard only for rules that forward', async () => {
      await clearAll();
      const loop = { accountId: 'agent', chatType: 'group' as const, chatId: 'source', title: 'Source' };
      await repo.create(AgentScheduleCreateInputSchema.parse({ title: 'Loop', provider: 'claude', recurrence: { kind: 'message' }, targets: [],
        task: { type: 'message_forward', match: { mode: 'mention', members: [], all: true } }, delivery: { mode: 'line_target', target: loop } }));
      await rule('Quiet', { all: true }, { forward: false, notify: true });
      await put('agent', 'loop-1', ['@all']);
      expect(await capture('agent', 'loop-1')).toBe(1);
      expect((await works('loop-1')).map((row) => row.title)).toEqual(['Quiet']);
    });

    it('lists pending notices and Agent copies and settles each run outcome', async () => {
      await clearAll();
      const forwards = new ScheduleForwardRepository(pool);
      const created = await rule('Both', { all: true }, { forward: false, notify: true, agent: { prompt: 'Reply', target: agentTarget } });
      const states = async (id: string) => { const [row] = await works(id); return { work: row!, outcome: await outcome(row!.run_id) }; };
      const next = async (id: string) => { await put('agent', id, ['@all'], { text: 'x'.repeat(300) }); await capture('agent', id); return (await works(id))[0]!; };

      // Both pending: the run waits.
      const w1 = await next('st-1');
      const notices = await forwards.pendingNotifications();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ workId: w1.work_id, scheduleId: created.scheduleId, title: 'Both', accountId: 'agent', chatType: 'group', chatId: 'source',
        messageId: 'st-1', sourceTitle: '', senderName: 'u-alice', attachmentKinds: [] });
      expect(notices[0]!.text).toHaveLength(200);
      const dispatches = await forwards.pendingAgentDispatches();
      expect(dispatches[0]).toMatchObject({ workId: w1.work_id, runId: w1.run_id, scheduleId: created.scheduleId, provider: 'claude',
        agent: { prompt: 'Reply', target: agentTarget }, messageId: 'st-1', senderId: 'u-alice', sourceTitle: '', title: 'Both', matchMode: 'mention', externalAccountScope: null });
      expect(dispatches[0]!.scheduledFor).toBeInstanceOf(Date);
      expect(await forwards.forwardWorkById(created.scheduleId, w1.work_id)).toMatchObject({ workId: w1.work_id, messageId: 'st-1', senderId: 'u-alice', senderName: 'u-alice', sourceTitle: '' });
      expect(await forwards.forwardWorkById(created.scheduleId, randomUUID())).toBeNull();
      expect(await forwards.forwardWorkById(randomUUID(), w1.work_id)).toBeNull();
      expect(await forwards.forwardMessage({ accountId: 'agent', chatType: 'group', chatId: 'source', messageId: 'st-1' }))
        .toMatchObject({ text: 'x'.repeat(300), kind: 'text', attachments: [] });
      expect(await forwards.forwardMessage({ accountId: 'agent', chatType: 'group', chatId: 'source', messageId: 'missing' })).toBeNull();
      expect(await forwards.forwardMessage({ accountId: 'admin', chatType: 'group', chatId: 'source', messageId: 'st-1' })).toBeNull();
      // Only queued jobs with this rule's forward request id count.
      const jobs = new AgentRepository(pool);
      const enqueue = (requestId: string) => jobs.enqueueScheduleJob({ provider: 'claude', requestId, prompt: 'p', workspacePath: 'w' });
      expect(await forwards.queuedAgentJobs(created.scheduleId)).toBe(0);
      await enqueue(`schedule:${created.scheduleId}:forward:${randomUUID()}`);
      await enqueue(`schedule:${created.scheduleId}:forward:${randomUUID()}`);
      await enqueue(`schedule:${randomUUID()}:forward:${randomUUID()}`);
      await enqueue(`schedule:${created.scheduleId}:2026-10-02T01:00:00.000Z`);
      expect(await forwards.queuedAgentJobs(created.scheduleId)).toBe(2);
      await pool.query("UPDATE agent_jobs SET status='completed' WHERE source_request_id LIKE $1", [`schedule:${created.scheduleId}:forward:%`]);
      expect(await forwards.queuedAgentJobs(created.scheduleId)).toBe(0);
      expect((await states('st-1')).outcome).toBe('submitting');
      expect(await forwards.markNotification(w1.work_id, 'shown')).toBe(true);
      expect(await forwards.markNotification(w1.work_id, 'failed')).toBe(false);
      expect((await states('st-1')).outcome).toBe('submitting');
      const agentJobId = randomUUID();
      expect(await forwards.markAgentDispatch(w1.work_id, 'submitted', agentJobId, null)).toBe(true);
      expect(await forwards.markAgentDispatch(w1.work_id, 'failed', null, 'late')).toBe(false);
      expect((await states('st-1')).outcome).toBe('submitted');
      // The run list shows the Agent job of the work row as the job of the run, with the states of both actions.
      const listed = (await repo.listRuns(created.scheduleId)).find((item) => item.runId === w1.run_id)!;
      expect(listed.jobId).toBe(agentJobId);
      expect(listed.forwarding).toMatchObject({ notifyState: 'shown', agentState: 'submitted', agentError: null, parts: [] });
      expect(await forwards.pendingNotifications()).toEqual([]);
      expect(await forwards.pendingAgentDispatches()).toEqual([]);

      const table: Array<[string, 'shown' | 'failed', 'submitted' | 'failed' | 'skipped', string]> = [
        ['st-2', 'shown', 'failed', 'failed'], ['st-3', 'shown', 'skipped', 'failed'], ['st-4', 'failed', 'submitted', 'submitted'], ['st-5', 'failed', 'failed', 'failed']];
      for (const [id, notify, agent, expected] of table) {
        const work = await next(id);
        await forwards.markAgentDispatch(work.work_id, agent, null, agent === 'submitted' ? null : 'x');
        expect((await states(id)).outcome).toBe('submitting');
        await forwards.markNotification(work.work_id, notify);
        expect((await states(id)).outcome).toBe(expected);
      }
      const noticeOnly = await rule('Notice only', { all: true }, { forward: false, notify: true });
      await pool.query('UPDATE agent_schedules SET enabled=false WHERE schedule_id=$1', [created.scheduleId]);
      for (const [id, notify, expected] of [['st-6', 'shown', 'notified'], ['st-7', 'failed', 'send_failed']] as const) {
        const work = await next(id);
        await forwards.markNotification(work.work_id, notify);
        expect((await states(id)).outcome).toBe(expected);
      }
      expect((await repo.listRuns(noticeOnly.scheduleId))[0]!.outcome).toBe('send_failed');
      expect((await repo.get(noticeOnly.scheduleId))!.lastOutcome).toBe('send_failed');
    });

    it('lets a forwarding run wait for its parts only', async () => {
      await clearAll();
      const forwards = new ScheduleForwardRepository(pool);
      await rule('Forward and notify', { all: true }, { forward: true, notify: true });
      await put('agent', 'fw-1', ['@all']);
      expect(await capture('agent', 'fw-1')).toBe(1);
      const work = (await works('fw-1'))[0]!;
      expect(work).toMatchObject({ notify_state: 'pending', parts: 1 });
      const part = (await forwards.pending())[0]!;
      expect(await forwards.mark(part, 'sending')).toBe(true);
      expect(await forwards.mark(part, 'sent', null, true)).toBe(true);
      await forwards.settle();
      expect(await outcome(work.run_id)).toBe('sent');
      expect((await works('fw-1'))[0]!.notify_state).toBe('pending');
    });

    it('expires stale pending work on recover and keeps fresh work', async () => {
      await clearAll();
      const forwards = new ScheduleForwardRepository(pool);
      await rule('Stale', { all: true }, { forward: false, notify: true, agent: { target: agentTarget } });
      for (const id of ['old-1', 'new-1']) { await put('agent', id, ['@all']); await capture('agent', id); }
      const old = (await works('old-1'))[0]!;
      await pool.query("UPDATE agent_schedule_forward_work SET created_at=clock_timestamp()-interval '11 minutes' WHERE work_id=$1", [old.work_id]);
      await forwards.recover();
      expect(await pool.query('SELECT notify_state,agent_state,agent_error FROM agent_schedule_forward_work WHERE work_id=$1', [old.work_id]).then((r) => r.rows[0]))
        .toEqual({ notify_state: 'failed', agent_state: 'skipped', agent_error: 'stale_after_restart' });
      expect(await outcome(old.run_id)).toBe('failed');
      const fresh = (await works('new-1'))[0]!;
      expect(fresh).toMatchObject({ notify_state: 'pending', agent_state: 'pending' });
      expect(await outcome(fresh.run_id)).toBe('submitting');
      await forwards.expireStale(0);
      expect((await works('new-1'))[0]).toMatchObject({ notify_state: 'failed', agent_state: 'skipped' });
    });

    it('closes pending notices and Agent copies when the rule is disabled, changed or deleted', async () => {
      await clearAll();
      const forwards = new ScheduleForwardRepository(pool);
      const created = await rule('Cancel', { all: true }, { forward: false, notify: true, agent: { target: agentTarget } });
      await put('agent', 'cx-1', ['@all']);
      await capture('agent', 'cx-1');
      expect(await forwards.pendingNotifications()).toHaveLength(1);
      await repo.update(created.scheduleId, { enabled: false });
      expect(await forwards.pendingNotifications()).toEqual([]);
      expect(await forwards.pendingAgentDispatches()).toEqual([]);
      await forwards.settle();
      const closed = (await pool.query("SELECT notify_state,agent_state,agent_error FROM agent_schedule_forward_work WHERE message_id='cx-1'")).rows[0];
      expect(closed).toEqual({ notify_state: 'failed', agent_state: 'skipped', agent_error: 'forwarding_cancelled' });
      expect(await outcome((await works('cx-1'))[0]!.run_id)).toBe('failed');

      // A changed rule (new revision) closes the work of the old revision.
      await repo.update(created.scheduleId, { enabled: true });
      await put('agent', 'cx-2', ['@all']);
      await capture('agent', 'cx-2');
      await pool.query('UPDATE agent_schedules SET rule_revision=rule_revision+1 WHERE schedule_id=$1', [created.scheduleId]);
      expect(await forwards.pendingNotifications()).toEqual([]);
      await forwards.settle();
      expect((await works('cx-2'))[0]).toMatchObject({ notify_state: 'failed', agent_state: 'skipped' });

      // A recalled source message closes the work when it is read.
      await put('agent', 'cx-3', ['@all']);
      await capture('agent', 'cx-3');
      await pool.query(`UPDATE messages SET content='{"format":1,"type":"unsent"}'::jsonb WHERE account_id='agent' AND message_id='cx-3'`);
      expect(await forwards.pendingNotifications()).toEqual([]);
      expect(await forwards.pendingAgentDispatches()).toEqual([]);
      expect((await works('cx-3'))[0]).toMatchObject({ notify_state: 'failed' });

      // Deleting the rule removes its work.
      await put('agent', 'cx-4', ['@all']);
      await capture('agent', 'cx-4');
      await repo.delete(created.scheduleId);
      expect(await works('cx-4')).toEqual([]);
    });
  });
});
