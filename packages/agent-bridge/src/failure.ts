import type {AgentEvent} from '@line-agent/contracts';
import {redactSensitive} from './redact.js';

export const isAuthenticationDiagnostic=(diagnostic:string)=>/\bnot logged in\b|\bauthentication (?:is )?(?:required|failed)\b|\bplease (?:run|use) (?:`?[\w.-]+`? )?(?:auth )?(?:login|\/login)\b/i.test(diagnostic);
/** The single list of provider wording that means "usage/rate limit". */
export const isUsageLimitMessage=(message:string)=>/usage limit|rate[\s_-]?limit|quota|\b429\b|(?:usage|rate) limit reached|hit your (?:usage |weekly |rate )?limit|too many requests/i.test(message);

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
export function classifyProviderFailure(name:'Codex'|'Claude',raw:string|undefined):AgentEvent {
  // Classify on the full redacted text; only the displayed text is truncated.
  const full=raw===undefined?'':redactSensitive(raw).replace(/\s+/g,' ').trim();
  const message=full.slice(0,MAX_PROVIDER_MESSAGE);
  if(full && isAuthenticationDiagnostic(full)) return {type:'failed',code:'AUTH_REQUIRED',message:'Sign in through Settings → Agent and retry the job.',retryable:false};
  if(full && isUsageLimitMessage(full)) return {type:'failed',code:'PROVIDER_LIMIT',message:`${name} 已達用量上限：${message}`,retryable:true};
  if(message) return {type:'failed',code:'PROVIDER_FAILED',message:`${name} 無法完成這次工作：${message}`,retryable:false};
  return {type:'failed',code:'PROVIDER_FAILED',message:`${name} 無法完成這次工作。`,retryable:false};
}
