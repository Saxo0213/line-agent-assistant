import React,{useEffect,useState} from 'react';
import type {AgentScheduleTarget} from '@line-agent/contracts';
import type {DesktopApi} from '../../preload/api.js';
import type {ScheduleCopyKey} from '../../desktop-schedule-copy.js';
export type ForwardSenderOption={accountId:string;mid:string;label:string;sourceTitle:string};
export function ScheduleForwardSender({api,targets,accountId,mid,savedLabel,onSelect,text}:{api:DesktopApi;targets:readonly AgentScheduleTarget[];
  accountId:string;mid:string;savedLabel?:string;onSelect(sender:ForwardSenderOption|null):void;text(key:ScheduleCopyKey):string}) {
  const [senders,setSenders]=useState<ForwardSenderOption[]>([]),[failed,setFailed]=useState(false);
  const scope=JSON.stringify(targets.map(({accountId,chatType,chatId,title})=>({accountId,chatType,chatId,title})));
  useEffect(()=>{
    let active=true;setFailed(false);setSenders([]);
    void Promise.all(targets.slice(0,20).map(async(source)=>{
      const page=await api.listMessages(source,null,100);
      return page.messages.filter((message)=>message.direction==='inbound').map((message)=>({accountId:source.accountId,mid:message.senderId,label:message.senderName||message.senderId,sourceTitle:source.title||source.chatId}));
    })).then((pages)=>{
      if(!active)return;
      const unique=new Map<string,ForwardSenderOption>();for(const sender of pages.flat())unique.set(JSON.stringify([sender.accountId,sender.mid]),sender);
      setSenders([...unique.values()].sort((a,b)=>a.label.localeCompare(b.label)));
    }).catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[api,scope]);
  const value=JSON.stringify([accountId,mid]);
  const options=accountId && mid && !senders.some((sender)=>JSON.stringify([sender.accountId,sender.mid])===value)
    ? [{accountId,mid,label:savedLabel||mid,sourceTitle:targets.find((source)=>source.accountId===accountId)?.title||targets.find((source)=>source.accountId===accountId)?.chatId||'',},...senders]
    :senders;
  return <div className="schedule-field"><label>{text('forwardChooseSender')}
    <select aria-label={text('forwardChooseSender')} value={options.some((sender)=>JSON.stringify([sender.accountId,sender.mid])===value)?value:''}
      onChange={(event)=>onSelect(options.find((sender)=>JSON.stringify([sender.accountId,sender.mid])===event.target.value)??null)}>
      <option value="">—</option>{options.map((sender)=><option key={JSON.stringify([sender.accountId,sender.mid])} value={JSON.stringify([sender.accountId,sender.mid])}>{sender.label} · {sender.sourceTitle}</option>)}
    </select></label>{(!senders.length||failed)&&<p className="schedule-hint">{text('forwardSenderFallback')}</p>}</div>;
}
