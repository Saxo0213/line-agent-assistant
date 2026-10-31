import type {AgentEvent} from '@line-agent/contracts';
import {redactSensitive} from './redact.js';

export const isAuthenticationDiagnostic=(diagnostic:string)=>/\bnot logged in\b|\bauthentication (?:is )?(?:required|failed)\b|\bplease (?:run|use) (?:`?[\w.-]+`? )?(?:auth )?(?:login|\/login)\b/i.test(diagnostic);
/** The single list of provider wording that means "usage/rate limit". */
export const isUsageLimitMessage=(message:string)=>/usage limit|rate[\s_-]?limit|quota|\b429\b|(?:usage|rate) limit reached|hit your (?:usage |weekly |rate )?limit|too many requests/i.test(message);

/** Parses a provider's explicit reset wording without guessing when the date, clock time or zone is incomplete. */
export function providerFailureResetAt(message:string,observedAt=Date.now()):string|undefined {
  const match=/\b([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if(!match) return undefined;
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month=months.indexOf(match[1]!.toLowerCase());
  const day=Number(match[2]);
  let hour=Number(match[3]);
  const minute=Number(match[4]??'0');
  const zone=match[6]!.trim();
  if(month<0||day<1||day>31||hour<1||hour>12||minute>59) return undefined;
  hour=hour%12+(match[5]!.toLowerCase()==='pm'?12:0);
  const localParts=(year:number)=>Date.UTC(year,month,day,hour,minute);
  const offsetAt=(instant:number)=>{
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
    const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
    return Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute))-instant;
  };
  try {
    const currentYear=new Date(observedAt).getUTCFullYear();
    for(let year=currentYear;year<=currentYear+1;year++) {
      const local=localParts(year);
      const instant=local-offsetAt(local);
      if(instant>=observedAt) return new Date(instant).toISOString();
    }
  } catch { return undefined; }
  return undefined;
}

const MAX_PROVIDER_MESSAGE=500;
/** Pull the provider's human-readable reason from an error-ish event; undefined when none. */
export function providerMessage(data:Record<string,unknown>):string|undefined {
  const parts:string[]=[];
  const add=(value:unknown)=>{if(typeof value==='string' && value.trim()) parts.push(value);};
  const error=data.error;
  if(error!==null && typeof error==='object' && !Array.isArray(error)) add((error as Record<string,unknown>).message);
  else add(error);
  add(data.message);
  add(data.result);
  if(Array.isArray(data.errors)) for(const item of data.errors) add(typeof item==='object' && item!==null?(item as Record<string,unknown>).message:item);
  const first=parts[0];
  return first===undefined?undefined:parts.filter((part,index)=>parts.indexOf(part)===index).join(' ');
}
export function classifyProviderFailure(name:'Codex'|'Claude',raw:string|undefined,observedAt=Date.now()):AgentEvent {
  // Classify on the full redacted text; only the displayed text is truncated.
  const full=raw===undefined?'':redactSensitive(raw).replace(/\s+/g,' ').trim();
  const message=full.slice(0,MAX_PROVIDER_MESSAGE);
  if(full && isAuthenticationDiagnostic(full)) return {type:'failed',code:'AUTH_REQUIRED',message:'Sign in through Settings → Agent and retry the job.',retryable:false};
  if(full && isUsageLimitMessage(full)) {
    const quotaRecoveryAt=providerFailureResetAt(full,observedAt);
    return {type:'failed',code:'PROVIDER_LIMIT',message:`${name} 已達用量上限：${message}`,retryable:true,...(quotaRecoveryAt?{quotaRecoveryAt}:{})};
  }
  if(message) return {type:'failed',code:'PROVIDER_FAILED',message:`${name} 無法完成這次工作：${message}`,retryable:false};
  return {type:'failed',code:'PROVIDER_FAILED',message:`${name} 無法完成這次工作。`,retryable:false};
}
