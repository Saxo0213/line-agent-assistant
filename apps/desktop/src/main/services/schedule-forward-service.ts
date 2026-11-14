import { redactSensitiveString, type AgentProvider, type AgentScheduleSendTarget } from '@line-agent/contracts';
import { AgentScheduleError, forwardNotice, type ForwardAgentDispatch, type ForwardNotification, type MessageRepository, type ScheduleForwardRepository } from '@line-agent/database';
import { AgentLineSendService, SYSTEM_FORWARD_PRINCIPAL } from './agent-line-send-service.js';
import { forwardRequestId, type AgentScheduleSubmission } from './agent-schedule-service.js';
import { composeScheduledPrompt } from './agent-schedule-prompt.js';
import type { ForwardNotify } from './forward-notifier.js';

/** At most this many notifications are shown in one drain pass; the rest wait for the next pass. */
export const FORWARD_NOTIFICATIONS_PER_PASS = 5;
/** A rule with this many queued mention Agent jobs skips the next ones. */
export const FORWARD_AGENT_QUEUE_LIMIT = 5;
const UNNAMED_CHAT = '未命名聊天室';

type ForwardStore = Pick<ScheduleForwardRepository, 'recover' | 'settle' | 'pending' | 'valid' | 'mark' | 'pendingNotifications' | 'markNotification'
  | 'pendingAgentDispatches' | 'markAgentDispatch' | 'queuedAgentJobs'>;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The notification of one stored row: no network, local data only, redacted. */
export function forwardNoticeOf(row: ForwardNotification): { title: string; body: string } {
  const text = oneLine(row.text) || forwardNotice(row.attachmentKinds) || '[訊息]';
  const title = clip(redactSensitiveString(`@ 提及：${row.title}`), 80);
  const body = clip(redactSensitiveString(`${oneLine(row.sourceTitle) || UNNAMED_CHAT}｜${oneLine(row.senderName)}: ${text}`), 200);
  return { title, body };
}

export class ScheduleForwardService {
  private timer:ReturnType<typeof setInterval>|undefined;
  private flight:Promise<void>|undefined;
  private readonly controller=new AbortController();
  constructor(private readonly options:{store:ForwardStore;messages:Pick<MessageRepository,'getSendAttachment'>;
    sender:AgentLineSendService;publish():void;onError(error:unknown):void;
    /** Shows one desktop notification; resolves false when it cannot be shown. Absent = notifications are not available. */
    notify?:ForwardNotify;
    /** Creates the isolated Agent job of a mention rule (AgentService.submitScheduled). Called outside any database transaction. */
    submitAgent?:(input:AgentScheduleSubmission)=>Promise<{disposition?:'inserted'|'duplicate';jobId:string}>;
    /** Maps an Agent target through the Agent lineage and checks it as an Agent send target; throws AgentScheduleError SCHEDULE_INVALID_TARGET if it is not valid. */
    resolveAgentTarget?:(target:AgentScheduleSendTarget)=>Promise<AgentScheduleSendTarget>;
    /** The external account scope of a rule mapped through the Agent lineage (null stays null). */
    accountScope?:(scope:readonly string[]|null)=>Promise<string[]|null>}) {}
  async start():Promise<void> {
    await this.options.store.recover();
    this.timer=setInterval(()=>this.wake(),1000); this.timer.unref(); this.wake();
  }
  wake():void {
    if(this.flight || this.controller.signal.aborted) return;
    this.flight=this.drain().catch((error)=>this.options.onError(error)).finally(()=>{this.flight=undefined;});
  }
  async drain():Promise<void> {
    const {store,sender}=this.options;
    for(let page=0;page<4 && !this.controller.signal.aborted;page++) {
      await store.settle();
      const parts=await store.pending();
      if(!parts.length) break;
      for(const part of parts) {
        if(this.controller.signal.aborted) return;
        if(!await store.valid(part)) {await store.mark(part,'cancelled','forwarding_authority_changed');continue;}
        if(part.attachmentId) {
          const attachment=await this.options.messages.getSendAttachment(part.attachmentId);
          if(!attachment || attachment.masked) {await store.mark(part,'failed','source_unavailable');continue;}
          if(attachment.status!=='ready') {
            if(['failed','expired','unavailable'].includes(attachment.status)) await store.mark(part,'failed','download_failed');
            continue;
          }
        }
        if(!await store.mark(part,'sending')) continue;
        const common={runId:part.runId,target:part.target,principalId:SYSTEM_FORWARD_PRINCIPAL as typeof SYSTEM_FORWARD_PRINCIPAL,
          signal:this.controller.signal,validateBeforeSend:()=>store.valid(part)};
        try {
          const result=part.kind==='text' ? await sender.sendSystemText({...common,text:part.text!,physicalPart:true})
            : await sender.sendSystemAttachment({...common,attachmentId:part.attachmentId!,source:part});
          await store.mark(part,result.status,result.status==='sent'?null:result.code,true);
        } catch(error) {
          // Persist uncertainty and never attempt this physical part again.
          await store.mark(part,'unknown','send_unknown',true); this.options.onError(error);
        }
      }
      await store.settle(); this.options.publish();
    }
    if(this.controller.signal.aborted) return;
    await this.drainNotifications();
    await this.drainAgentDispatches();
  }
  private async drainNotifications():Promise<void> {
    const {store,notify}=this.options;
    const rows=(await store.pendingNotifications(FORWARD_NOTIFICATIONS_PER_PASS)).slice(0,FORWARD_NOTIFICATIONS_PER_PASS);
    for(const row of rows) {
      if(this.controller.signal.aborted) return;
      let shown=false;
      try {
        shown=notify ? await notify({...forwardNoticeOf(row),accountId:row.accountId,chatType:row.chatType,chatId:row.chatId}) : false;
      } catch(error) { this.options.onError(error); }
      await store.markNotification(row.workId,shown ? 'shown' : 'failed');
    }
    if(rows.length) this.options.publish();
  }
  private async drainAgentDispatches():Promise<void> {
    const rows=await this.options.store.pendingAgentDispatches();
    for(const row of rows) {
      if(this.controller.signal.aborted) return;
      await this.dispatchAgent(row);
    }
    if(rows.length) this.options.publish();
  }
  /** One mention Agent job. A failure ends this row only; the error code that is stored is a safe code, the raw error goes to onError. */
  private async dispatchAgent(row:ForwardAgentDispatch):Promise<void> {
    const {store,submitAgent,resolveAgentTarget,accountScope}=this.options;
    let target:AgentScheduleSendTarget;
    let job:{jobId:string};
    try {
      if(!submitAgent || !resolveAgentTarget) { await store.markAgentDispatch(row.workId,'failed',null,'agent_unavailable'); return; }
      try { target=await resolveAgentTarget(row.agent.target); }
      catch(error) {
        const invalid=error instanceof AgentScheduleError && error.code==='SCHEDULE_INVALID_TARGET';
        if(!invalid) this.options.onError(error);
        await store.markAgentDispatch(row.workId,'failed',null,invalid ? 'send_target_invalid' : 'send_target_check_failed');
        return;
      }
      if(await store.queuedAgentJobs(row.scheduleId)>=FORWARD_AGENT_QUEUE_LIMIT) { await store.markAgentDispatch(row.workId,'skipped',null,'agent_queue_full'); return; }
      const scope=row.externalAccountScope===null ? null : await (accountScope ? accountScope(row.externalAccountScope) : Promise.resolve([...row.externalAccountScope]));
      // The visible card has no ids and no times; the hidden context is built from the request id when the job starts.
      const prompt=composeScheduledPrompt({title:row.title,prompt:row.agent.prompt,task:{type:'message_forward',match:{mode:'sender'}},targets:[],delivery:{mode:'record_only'},
        window:{from:row.scheduledFor,to:row.scheduledFor},forward:{sourceTitle:row.sourceTitle,agentTarget:target,mention:row.matchMode==='mention'}});
      job=await submitAgent({provider:row.provider as AgentProvider,requestId:forwardRequestId(row.scheduleId,row.workId),prompt,
        ...(scope!==null ? {mcpAccountScope:scope} : {})});
    } catch(error) {
      this.options.onError(error);
      await store.markAgentDispatch(row.workId,'failed',null,'agent_submit_failed').catch((markError:unknown)=>this.options.onError(markError));
      return;
    }
    // A failed mark leaves the row pending; the next pass submits again and the request id de-duplicates it to the same job.
    await store.markAgentDispatch(row.workId,'submitted',job.jobId,null);
  }
  async stop():Promise<void> {
    if(this.timer) clearInterval(this.timer);
    this.controller.abort();
    if(this.flight) await this.flight;
  }
}
