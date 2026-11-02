import { ScheduleForwardRepository, type MessageRepository } from '@line-agent/database';
import { AgentLineSendService, SYSTEM_FORWARD_PRINCIPAL } from './agent-line-send-service.js';

export class ScheduleForwardService {
  private timer:ReturnType<typeof setInterval>|undefined;
  private flight:Promise<void>|undefined;
  private readonly controller=new AbortController();
  constructor(private readonly options:{store:ScheduleForwardRepository;messages:Pick<MessageRepository,'getSendAttachment'>;
    sender:AgentLineSendService;publish():void;onError(error:unknown):void}) {}
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
  }
  async stop():Promise<void> {
    if(this.timer) clearInterval(this.timer);
    this.controller.abort();
    if(this.flight) await this.flight;
  }
}
