import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository, AdminRepository, ExternalMonitorRepository, FriendWhitelistRepository, MessageRepository, SettingsRepository,
  type ExternalMonitorAgentReceipt } from '@line-agent/database';
import type { InboundEnvelope, LineWorkerCommand } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { LineService, type RoomControlHandler } from './line-service.js';
import { plainEnvelope } from '../../../../../packages/database/src/content-bridge/test-support.js';
import { toExternalObservation } from '../connected-facade.js';
import {AgentScheduleRepository,ScheduleForwardRepository} from '@line-agent/database';
import {AgentScheduleCreateInputSchema} from '@line-agent/contracts';
import {AgentLineSendService} from './agent-line-send-service.js';
import {ScheduleForwardService} from './schedule-forward-service.js';
import {AgentScheduleService} from './agent-schedule-service.js';
import {createAgentScheduleTargetResolver} from './agent-schedule-targets.js';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const database=process.env.TEST_DATABASE_URL ? describe : describe.skip;
const agentMid=`u${'a'.repeat(32)}`; const adminMid=`u${'b'.repeat(32)}`;
database('monitor Agent real ingress',()=>{
  let pool:Pool; let close:()=>Promise<void>; let accounts:AccountRepository; let messages:MessageRepository;
  let settings:SettingsRepository; let admins:AdminRepository; let monitor:ExternalMonitorRepository;
  let source:{sourceId:string;generation:number;modeRevision:number};
  let checkpoint:Record<string,unknown>|null=null; let sequence=100000;
  const binding={accountId:'agent',workerInstanceId:'agent-worker',controlEpoch:1,mode:'ACTIVE_CONTROL' as const};
  const cursor=(revision:string)=>({version:1 as const,revision,globalRev:'0',individualRev:'0'});
  const livePredecessors=new Map<string,ReturnType<typeof cursor>>();
  beforeAll(async()=>{
    ({pool,close}=await createTestDatabase()); accounts=new AccountRepository(pool); messages=new MessageRepository(pool);
    settings=new SettingsRepository(pool); admins=new AdminRepository(pool); monitor=new ExternalMonitorRepository(pool);
    for(const [id,mid,role] of [['agent',agentMid,'AGENT'],['admin',adminMid,'PRIMARY_ADMIN']]){
      await accounts.ensureAccount(id!); await accounts.setOwnMid(id!,mid!);
      await pool.query('UPDATE line_accounts SET product_role=$2 WHERE account_id=$1',[id,role]);
    }
    await accounts.activateControl('agent',1); await accounts.bindWorker(binding);
    await accounts.applyWorkerLogin(binding,agentMid,'Agent');
    await admins.bindPrimary('agent',adminMid,adminMid);
    source=await monitor.bindVerifiedExternalSource({accountId:'admin',ownMid:adminMid,sourceIdentity:'native-profile'});
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,agent_enabled) VALUES('agent','direct',$1,true) ON CONFLICT DO NOTHING",[adminMid]);
    await settings.setConversationAgent({accountId:'agent',chatType:'direct',chatId:adminMid,enabled:true,provider:'codex'});
  });
  afterAll(async()=>{await close?.();});
  async function receipt(text='hello',extra:Record<string,unknown>={}):Promise<ExternalMonitorAgentReceipt>{
    const id=String(++sequence); const next={id};
    const result=await monitor.commitDirectPoll({accountId:'admin',...source,expectedModeRevision:source.modeRevision,
      expectedCheckpoint:checkpoint,batchId:id,cursor:next,dispatchEligible:true,tailObservations:[],forwardObservations:[{
        observationId:id,canonicalMessageId:id,nativeMessageId:id,chatType:'direct',chatId:agentMid,senderId:adminMid,
        kind:'text',text,occurredAt:'2026-11-02T00:00:00Z',...extra}]});
    checkpoint=next; expect(result.dispatchReceipts).toHaveLength(1); return result.dispatchReceipts[0]!;
  }
  async function service(roomControl?:RoomControlHandler){
    const commands:LineWorkerCommand[]=[]; const kick=vi.fn(); const stop=vi.fn(async()=>true);
    const instance=new LineService(accounts,messages,settings,{async send(command){commands.push(command);}},
      {kick,stopChat:stop,async resetChat(){}},undefined,undefined,undefined,admins,
      {async inspect(){return {status:'available',version:1,path:'C:\\trusted'};}},roomControl,new FriendWhitelistRepository(pool));
    await instance.bind(binding); return {instance,commands,kick,stop};
  }
  function live(r:ExternalMonitorAgentReceipt,text=r.observation.text):InboundEnvelope{
    return {eventId:`live:${r.messageId}`,accountId:'agent',chatType:r.chatType,chatId:r.targetChatId,senderId:r.senderId,
      messageId:r.messageId,kind:'text',text,mentionIds:[],mentionRanges:[],replyToMessageId:null,
      ingestion:{source:'live',cursor:null},occurredAt:r.observation.occurredAt,attachments:[],raw:{}};
  }
  async function liveReceive(instance:LineService,r:ExternalMonitorAgentReceipt){
    const checkpointRow=await pool.query("SELECT cursor FROM external_source_checkpoints WHERE source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id='agent')");
    const predecessor=livePredecessors.get(r.messageId) ?? checkpointRow.rows[0]?.cursor ?? cursor('0');
    livePredecessors.set(r.messageId,predecessor);
    return instance.handleWorkerEvent(binding.workerInstanceId,{type:'batch',...binding,batchId:`live:${r.messageId}`,
      cursorBefore:predecessor,cursorAfter:cursor(r.messageId),envelopes:[live(r)],startupSync:false});
  }
  it('recovers a committed checkpoint without live reception, reverses direct MID, and preserves worker startup state',async()=>{
    const r=await receipt(); const {instance,commands,kick}=await service();
    const before=await pool.query("SELECT cursor FROM external_source_checkpoints WHERE source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id='agent')");
    await instance.handleMonitorReceipt(r);
    expect(commands).toEqual([]); expect(kick).toHaveBeenCalledTimes(1);
    expect((instance as unknown as {startupSync:Map<string,{active:boolean}>}).startupSync.get(binding.workerInstanceId)?.active).toBe(true);
    expect((await pool.query("SELECT cursor FROM external_source_checkpoints WHERE source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id='agent')")).rows).toEqual(before.rows);
    expect((await pool.query('SELECT chat_id,ingestion_source FROM messages WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows)
      .toEqual([{chat_id:adminMid,ingestion_source:'history'}]);
    expect((await pool.query('SELECT count(*)::int n FROM message_source_provenance WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows[0].n).toBe(0);
    await monitor.finishAgentDispatchReceipt(r);
    await liveReceive(instance,r);
    expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[r.messageId])).rows[0].n).toBe(1);
    await instance.shutdownIngress();
  });
  it('rejects logical direct/group loops in shared schedule service while allowing different direct participants',async()=>{
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('admin','direct',$1),('admin','direct','u-peer'),('agent','direct','u-peer'),('admin','group','loop-group'),('agent','group','loop-group') ON CONFLICT DO NOTHING",[agentMid]);
    const schedules=new AgentScheduleRepository(pool),handler=new AgentScheduleService({store:schedules,targets:createAgentScheduleTargetResolver({messages,pool}),submit:async()=>({jobId:'unused'})});
    const input=AgentScheduleCreateInputSchema.parse({title:'Validate loop',provider:'claude',recurrence:{kind:'message'},targets:[{accountId:'admin',chatType:'direct',chatId:'u-peer',title:'Peer'}],
      task:{type:'message_forward',match:{mode:'contains',keywords:['hello']}},delivery:{mode:'line_target',target:{accountId:'agent',chatType:'direct',chatId:'u-peer',title:'Peer'}}});
    const allowed=await handler.create(input);
    const direct={...input,targets:[{accountId:'admin',chatType:'direct' as const,chatId:agentMid,title:'Agent'}],delivery:{mode:'line_target' as const,target:{accountId:'agent',chatType:'direct' as const,chatId:adminMid,title:'Admin'}}};
    await expect(handler.create(direct)).rejects.toMatchObject({code:'SCHEDULE_INVALID_TARGET'});
    await expect(handler.update(allowed.scheduleId,{targets:direct.targets,delivery:direct.delivery})).rejects.toMatchObject({code:'SCHEDULE_INVALID_TARGET'});
    const group={...input,targets:[{accountId:'admin',chatType:'group' as const,chatId:'loop-group',title:'Group'}],delivery:{mode:'line_target' as const,target:{accountId:'agent',chatType:'group' as const,chatId:'loop-group',title:'Group'}}};
    await expect(handler.createExternal(group,['admin','agent'])).rejects.toMatchObject({code:'SCHEDULE_INVALID_TARGET'});
    const external=await handler.createExternal(input,['admin','agent']);
    await expect(handler.updateExternal(external.scheduleId,{targets:group.targets,delivery:group.delivery},['admin','agent'])).rejects.toMatchObject({code:'SCHEDULE_INVALID_TARGET'});
    await schedules.delete(allowed.scheduleId);await schedules.delete(external.scheduleId);
  });
  it('forwards the fresh native copy before delayed Agent live receipt and deduplicates the late copy',async()=>{
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','direct','u-destination') ON CONFLICT DO NOTHING");
    const schedules=new AgentScheduleRepository(pool),store=new ScheduleForwardRepository(pool);
    const schedule=await schedules.create(AgentScheduleCreateInputSchema.parse({title:'Immediate forward',provider:'claude',recurrence:{kind:'message'},
      targets:[{accountId:'agent',chatType:'direct',chatId:adminMid,title:'Admin'}],
      task:{type:'message_forward',match:{mode:'exact',text:'before\n```\noriginal\n```\nafter'},sender:{accountId:'agent',mid:adminMid,label:'Admin'}},
      delivery:{mode:'line_target',target:{accountId:'agent',chatType:'direct',chatId:'u-destination',title:'Destination'}}}));
    const original='before\n```\noriginal\n```\nafter';
    const r=await receipt(original,{occurredAt:new Date(Date.now()+1000).toISOString()});
    expect((await pool.query('SELECT account_id FROM agent_schedule_forward_work WHERE schedule_id=$1',[schedule.scheduleId])).rows).toEqual([{account_id:'admin'}]);
    expect((await pool.query("SELECT 1 FROM messages WHERE account_id='agent' AND message_id=$1",[r.messageId])).rowCount).toBe(0);
    const sent:string[]=[];
    const sender=new AgentLineSendService({messages,attachmentRoot:'C:\\unused',canWriteLine:async()=>true,worker:{binding:async()=>binding,
      async send(command){sent.push(command.text);return {type:'sendResult',...binding,requestId:command.requestId,status:'sent',messageId:'forwarded',error:null};}}});
    const forward=new ScheduleForwardService({store,messages,sender,publish(){},onError(error){throw error;}});
    await forward.drain();
    expect(sent).toEqual([`Admin: ${original}`]);
    expect((await schedules.listRuns(schedule.scheduleId))[0]!.outcome).toBe('sent');
    const {instance}=await service();
    await liveReceive(instance,r);
    await forward.drain();
    expect(sent).toEqual([`Admin: ${original}`]);
    expect((await pool.query('SELECT count(*) FROM agent_schedule_forward_work WHERE schedule_id=$1',[schedule.scheduleId])).rows[0].count).toBe('1');
    await instance.shutdownIngress();await forward.stop();await sender.shutdown();await schedules.delete(schedule.scheduleId);
  });
  it('deduplicates live-first and racing monitor/live arrivals',async()=>{
    const {instance}=await service(); const first=await receipt('live first');
    await liveReceive(instance,first); await instance.handleMonitorReceipt(first);
    const racing=await receipt('race');
    await Promise.all([instance.handleMonitorReceipt(racing),liveReceive(instance,racing)]);
    for(const r of [first,racing]) expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[r.messageId])).rows[0].n).toBe(1);
    await instance.shutdownIngress();
  });
  it('keeps configuration commands eligible for normal live execution',async()=>{
    const {instance,commands}=await service(); const r=await receipt('/agent claude');
    await instance.handleMonitorReceipt(r); await monitor.finishAgentDispatchReceipt(r);
    expect((await pool.query('SELECT count(*)::int n FROM message_routes WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows[0].n).toBe(0);
    await liveReceive(instance,r); await liveReceive(instance,r); await instance.idleRoomEffects();
    expect(commands.filter((c)=>c.type==='sendText')).toHaveLength(1);
    expect((await settings.getConversationAgent({accountId:'agent',chatType:'direct',chatId:adminMid}))?.provider).toBe('claude');
    await instance.shutdownIngress();
  });
  it('executes durable stop once and projects validated monitor status aliases',async()=>{
    const {instance,stop}=await service(); const r=await receipt('/stop');
    await instance.handleMonitorReceipt(r); await instance.handleMonitorReceipt(r); await liveReceive(instance,r);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await monitor.listAgentMessageAliases({accountId:'admin',messageIds:[r.messageId],direction:'monitor'}))
      .toMatchObject([{agentAccountId:'agent',targetChatId:adminMid,sourceChatId:agentMid}]);
    await instance.shutdownIngress();
  });
  it('retains native reply and attachments without inventing login provenance',async()=>{
    const {instance}=await service(); const r=await receipt('with native context',{
      nativePayload:plainEnvelope({_contentType:0,_text:'with native context',_messageRelationType:3,_relatedMessageId:'12345'}),
      attachments:[{id:'native-file',kind:'file',name:'notes.txt',mimeType:'text/plain',sizeBytes:42,expiresAt:null}]});
    await instance.handleMonitorReceipt(r);
    expect((await pool.query('SELECT reply_to_message_id,raw FROM messages WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows[0])
      .toMatchObject({reply_to_message_id:'12345',raw:{native:r.observation.nativePayload}});
    expect((await pool.query('SELECT external_attachment_id FROM attachments WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows)
      .toEqual([{external_attachment_id:'native-file'}]);
    await instance.shutdownIngress();
  });
  it('waits for original image/file bytes, preserves successful parts on unknown and blocks revoked alias membership',async()=>{
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','direct','u-destination') ON CONFLICT DO NOTHING");
    const root=await mkdtemp(path.join(tmpdir(),'forward-original-'));
    const schedules=new AgentScheduleRepository(pool),store=new ScheduleForwardRepository(pool);
    const schedule=await schedules.create(AgentScheduleCreateInputSchema.parse({title:'Original media',provider:'claude',recurrence:{kind:'message'},
      targets:[{accountId:'agent',chatType:'direct',chatId:adminMid,title:'Admin'}],task:{type:'message_forward',match:{mode:'sender'},sender:{accountId:'agent',mid:adminMid}},
      delivery:{mode:'line_target',target:{accountId:'agent',chatType:'direct',chatId:'u-destination',title:'Destination'}}}));
    const sent:Array<{kind:string;name:string;bytes:string}>=[],texts:string[]=[];
    const sender=new AgentLineSendService({messages,attachmentRoot:root,canWriteLine:async()=>true,worker:{binding:async()=>binding,
      async send(command){texts.push(command.text);return {type:'sendResult',...binding,requestId:command.requestId,status:'sent',messageId:'text-sent',error:null};},
      async sendMedia(command){sent.push({kind:command.kind,name:command.fileName,bytes:(await readFile(command.filePath)).toString()});
        return {type:'sendResult',...binding,requestId:command.requestId,status:command.kind==='file'?'unknown':'sent',messageId:command.kind==='file'?null:'image-sent',error:null};}}});
    const forward=new ScheduleForwardService({store,messages,sender,publish(){},onError(error){throw error;}});
    try {
      const r=await receipt('',{kind:'image',occurredAt:new Date(Date.now()+1000).toISOString(),attachments:[
        {id:'original-image',kind:'image',name:'原圖.png',mimeType:'image/png',sizeBytes:8,expiresAt:null},
        {id:'original-file',kind:'file',name:'原檔.pdf',mimeType:'application/pdf',sizeBytes:8,expiresAt:null}]});
      // An External Monitor attachment never downloads, so the text carries a notice and the media parts fail.
      await forward.drain();expect(sent).toEqual([]);
      expect(texts).toEqual([`${adminMid}: [圖片] [檔案]`]);
      expect((await schedules.listRuns(schedule.scheduleId))[0]).toMatchObject({outcome:'send_failed',forwarding:{parts:[{state:'sent'},{state:'failed',errorCode:'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE'},{state:'failed',errorCode:'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE'}]}});
      // Rebuild the legacy waiting state so that the rest of this test still covers sending of downloaded media bytes.
      await pool.query("UPDATE agent_schedule_forward_parts SET state='waiting',error_code=NULL WHERE kind<>'text' AND work_id=(SELECT work_id FROM agent_schedule_forward_work WHERE message_id=$1)",[r.messageId]);
      await pool.query('DELETE FROM message_source_provenance WHERE message_id=$1',[r.messageId]);
      await pool.query("UPDATE agent_schedule_runs SET outcome='submitting' WHERE run_id=(SELECT run_id FROM agent_schedule_forward_work WHERE message_id=$1)",[r.messageId]);
      const attachments=await pool.query<{attachment_id:string;external_attachment_id:string}>('SELECT attachment_id,external_attachment_id FROM attachments WHERE account_id=$1 AND message_id=$2',['admin',r.messageId]);
      for(const attachment of attachments.rows) {
        const bytes=attachment.external_attachment_id==='original-image'?'IMAGE123':'FILE1234';
        const sha=createHash('sha256').update(bytes).digest('hex'),relative=`att-${sha}.blob`;
        await writeFile(path.join(root,relative),bytes);
        await pool.query("UPDATE attachments SET status='ready',relative_path=$2,sha256=$3,size_bytes=8 WHERE attachment_id=$1",[attachment.attachment_id,relative,sha]);
      }
      const first=(await store.pending())[0]!;
      const claims=await Promise.all([store.mark(first,'sending'),store.mark(first,'sending')]);
      expect(claims.sort()).toEqual([false,true]);
      await pool.query("UPDATE agent_schedule_forward_parts SET state='waiting' WHERE work_id=$1 AND part_index=1",[first.workId]);
      await forward.drain();
      expect(sent).toEqual([{kind:'image',name:'原圖.png',bytes:'IMAGE123'},{kind:'file',name:'原檔.pdf',bytes:'FILE1234'}]);
      expect((await schedules.listRuns(schedule.scheduleId))[0]).toMatchObject({outcome:'send_unknown',forwarding:{accountId:'admin',senderId:adminMid,parts:[{state:'sent'},{state:'sent'},{state:'unknown'}]}});
      await store.recover();await forward.drain();expect(sent).toHaveLength(2);
      for(let index=0;index<32;index++) await receipt('',{kind:'image',occurredAt:new Date(Date.now()+1000).toISOString(),
        attachments:[{id:`waiting-${index}`,kind:'image',name:'waiting.png',mimeType:'image/png',sizeBytes:8,expiresAt:null}]});
      await receipt('fair-ready',{occurredAt:new Date(Date.now()+1000).toISOString()});
      await forward.drain();expect(texts.at(-1)).toBe(`${adminMid}: fair-ready`);expect(sent).toHaveLength(2);
      await schedules.update(schedule.scheduleId,{targets:[{accountId:'agent',chatType:'group',chatId:'forward-revoke',title:'Group'}]});
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','group','forward-revoke')");
      await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES('agent','group','forward-revoke',$1)",[agentMid]);
      const blocked=await receipt('',{kind:'image',chatType:'group',chatId:'forward-revoke',senderId:adminMid,occurredAt:new Date(Date.now()+1000).toISOString(),
        attachments:[{id:'revoked-image',kind:'image',name:'blocked.png',mimeType:'image/png',sizeBytes:8,expiresAt:null}]});
      await pool.query("DELETE FROM conversation_members WHERE account_id='agent' AND chat_id='forward-revoke'");
      const imageHash=createHash('sha256').update('IMAGE123').digest('hex');
      await pool.query("UPDATE attachments SET status='ready',relative_path=$2,sha256=$3,size_bytes=8 WHERE account_id='admin' AND message_id=$1",[blocked.messageId,`att-${imageHash}.blob`,imageHash]);
      await forward.drain();expect(sent).toHaveLength(2);
      expect((await pool.query('SELECT p.state FROM agent_schedule_forward_parts p JOIN agent_schedule_forward_work w USING(work_id) WHERE w.message_id=$1 ORDER BY p.part_index',[blocked.messageId])).rows).toEqual([{state:'cancelled'},{state:'failed'}]);
    } finally {await forward.stop();await sender.shutdown();await schedules.delete(schedule.scheduleId);await rm(root,{recursive:true,force:true});}
  });
  it('requires current group membership before admission and preserves mentions',async()=>{
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','group','group-chat')");
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES('agent','group','group-chat',$1)",[agentMid]);
    const respond=vi.fn(async()=>{});
    const {instance}=await service({async handle(){},async isEnabled(){return true;},respond});
    const {observationId:_observationId,canonicalMessageId:_messageId,nativeMessageId:_nativeMessageId,...extra}=toExternalObservation({observationId:'native-group',canonicalMessageId:null,
      nativeConversationKind:'group',nativeConversationId:'group-chat',nativeMessageId:'12345678',chatType:'group',chatId:'group-chat',
      senderId:adminMid,kind:'text',text:'@Agent do this',mentionRanges:[{start:0,end:6,userId:agentMid}],createdTime:'1793577600000',readonlyForSending:false});
    const allowed=await receipt('@Agent do this',extra); await instance.handleMonitorReceipt(allowed);
    expect((await pool.query('SELECT prompt FROM agent_jobs WHERE source_message_id=$1',[allowed.messageId])).rows[0].prompt).toBe('do this');
    const revoked=await receipt('@Agent revoked',extra);
    await pool.query("DELETE FROM conversation_members WHERE account_id='agent' AND chat_id='group-chat'");
    await expect(instance.handleMonitorReceipt(revoked)).rejects.toThrow('Stale monitor dispatch authority');
    expect(respond).not.toHaveBeenCalled();
    await instance.shutdownIngress();
  });
  it('retains canonical route dedupe after monitor receipt cleanup',async()=>{
    const {instance,stop}=await service(); const r=await receipt('/stop');
    await instance.handleMonitorReceipt(r);
    await pool.query('DELETE FROM external_monitor_agent_receipts WHERE source_id=$1 AND generation=$2 AND observation_id=$3',[r.sourceId,r.generation,r.observationId]);
    expect((await pool.query('SELECT monitor_source_id,monitor_origin FROM message_routes WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows)
      .toEqual([{monitor_source_id:null,monitor_origin:true}]);
    await liveReceive(instance,r); expect(stop).toHaveBeenCalledTimes(1); await instance.shutdownIngress();
  });
  it('leaves ignored group mentions to the original live auto-reply path',async()=>{
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','group','ignored-group')");
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES('agent','group','ignored-group',$1)",[agentMid]);
    const respond=vi.fn(async()=>{}); const {instance}=await service({async handle(){},async isEnabled(){return false;},respond});
    const r=await receipt('@Agent hello',{chatType:'group',chatId:'ignored-group',senderId:`u${'c'.repeat(32)}`,
      mentionRanges:[{start:0,end:6,userId:agentMid}]});
    await instance.handleMonitorReceipt(r);
    expect(respond).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int n FROM message_routes WHERE account_id=$1 AND message_id=$2',['agent',r.messageId])).rows[0].n).toBe(0);
    const e=live(r);e.mentionIds=[agentMid];e.mentionRanges=[{start:0,end:6,userId:agentMid}];
    const checkpointRow=await pool.query("SELECT cursor FROM external_source_checkpoints WHERE source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id='agent')");
    const batch={type:'batch' as const,...binding,batchId:`live:${r.messageId}`,cursorBefore:checkpointRow.rows[0].cursor,cursorAfter:cursor(r.messageId),envelopes:[e],startupSync:false};
    await instance.handleWorkerEvent(binding.workerInstanceId,batch);await instance.idleRoomEffects();
    await instance.handleWorkerEvent(binding.workerInstanceId,batch);await instance.idleRoomEffects();
    expect(respond).toHaveBeenCalledTimes(1);await instance.shutdownIngress();
  });
  it('rechecks a group friend grant in the admission transaction',async()=>{
    const sender=`u${'d'.repeat(32)}`; const key={accountId:'agent',chatType:'group' as const,chatId:'grant-group'};
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES('agent','group','grant-group')");
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id) VALUES('agent','group','grant-group',$1)",[agentMid]);
    const whitelist=new FriendWhitelistRepository(pool);const scope={kind:'CHAT' as const,chatType:'group' as const,chatId:key.chatId};
    await whitelist.activate('agent',sender,adminMid,scope);
    const r=await receipt('@Agent revoked grant',{chatType:key.chatType,chatId:key.chatId,senderId:sender,mentionRanges:[{start:0,end:6,userId:agentMid}]});
    const {instance}=await service(); const original=messages.admitLiveBatch.bind(messages);
    const spy=vi.spyOn(messages,'admitLiveBatch').mockImplementationOnce(async(...args)=>{
      await whitelist.revoke('agent',sender,adminMid,scope);return original(...args);
    });
    try {await instance.handleMonitorReceipt(r);} finally {spy.mockRestore();}
    expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[r.messageId])).rows[0].n).toBe(0);
    await instance.shutdownIngress();
  });
  it('recovers a job committed before the dispatch kick',async()=>{
    const r=await receipt('admitted before crash');
    await messages.admitLiveBatch({type:'batch',...binding,batchId:'crash-after-admission',cursorBefore:cursor('0'),cursorAfter:cursor('0'),envelopes:[live(r)]},
      [{eligible:true,provider:'codex',prompt:'admitted before crash',workspacePath:'C:\\trusted'}],r);
    const {instance,kick}=await service(); await instance.handleMonitorReceipt(r);
    expect(kick).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[r.messageId])).rows[0].n).toBe(1);
    await instance.shutdownIngress();
  });
  it('suppresses a stale pending monitor action without blocking subsequent live ingress',async()=>{
    const r=await receipt('/stop');
    await messages.admitLiveBatch({type:'batch',...binding,batchId:'crash-command',cursorBefore:cursor('0'),cursorAfter:cursor('0'),envelopes:[live(r)]},
      [{eligible:false,action:'stop'}],r);
    await pool.query('DELETE FROM external_monitor_agent_receipts WHERE source_id=$1 AND generation=$2 AND observation_id=$3',[r.sourceId,r.generation,r.observationId]);
    const apply=vi.fn(async()=>{});
    expect(await messages.applyPendingRouteAction({accountId:'agent',chatType:'direct',chatId:adminMid},r.messageId,binding.workerInstanceId,apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    const {instance}=await service(); const later=await receipt('later live'); await liveReceive(instance,later);
    expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[later.messageId])).rows[0].n).toBe(1);
    await instance.shutdownIngress();
  });
  it('rejects authority changed after checkpoint and before admission',async()=>{
    const {instance}=await service(); const r=await receipt('stale');
    await pool.query("UPDATE account_administrator_versions SET version=version+1 WHERE account_id='agent'");
    await expect(instance.handleMonitorReceipt(r)).rejects.toThrow('Stale monitor dispatch authority');
    expect((await pool.query('SELECT count(*)::int n FROM agent_jobs WHERE source_message_id=$1',[r.messageId])).rows[0].n).toBe(0);
    expect(await monitor.listAgentMessageAliases({accountId:'admin',messageIds:[r.messageId],direction:'monitor'})).toEqual([]);
    await instance.shutdownIngress();
  });
});
