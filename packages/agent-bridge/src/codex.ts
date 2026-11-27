import type {AgentEvent, AgentRunRequest} from '@line-agent/contracts';
import {asIdentifier,asObject,asText,asUsage} from './jsonl.js';
import {classifyProviderFailure} from './failure.js';
import {codexMcpOverrides} from './mcp.js';
import {codexExtensionPlan,codexWebSearchOverrides} from './extensions.js';

/** Codex features that run commands or read local files. A job without the local tools permission runs with all of them off. */
export const CODEX_LOCAL_FEATURES=['shell_tool','unified_exec','computer_use','browser_use','browser_use_external','code_mode_host','view_image','multi_agent'] as const;
export function codexArguments(request:AgentRunRequest,workspace:string) {
  // Codex has no approval broker, so its sandbox is the enforcement boundary.
  // Without the local tools permission, the run is plain conversation plus the MCP tools: read-only sandbox and every local-execution feature off.
  const chatOnly=!request.tools.localTools;
  const level=request.tools.level ?? 'workspace_write';
  // A read-only project folder cannot be protected inside danger-full-access, so such a job runs in workspace-write instead.
  const sandbox=chatOnly||!request.tools.fileWrite||request.tools.ownFolderReadOnly||level==='read_only'?'read-only':level==='full'&&!(request.tools.projectDirs??[]).some(dir=>!dir.writable)?'danger-full-access':'workspace-write';
  const disabled=chatOnly?CODEX_LOCAL_FEATURES.flatMap(feature=>['--disable',feature]):[];
  // `--add-dir` (an exec-level option, so it also precedes `resume`) adds writable roots to the workspace-write sandbox only; reading is never limited by directory.
  const writableDirs=sandbox==='workspace-write'?(request.tools.projectDirs??[]).filter(dir=>dir.writable).flatMap(dir=>['--add-dir',dir.path]):[];
  const images=codexImageArguments(request);
  const resume=request.resumeSessionId!==undefined;
  const model=request.model?.trim();
  // Order follows CliTalkAgent. A fresh `--image` is variadic, so it goes before `--sandbox`: the trailing `-` then cannot become an image value.
  // On `resume` the flag is a single-value option after the session id. The process cwd is the workspace, so there is no `-C`.
  return ['exec','--json','--skip-git-repo-check','--ignore-user-config',...(resume?[]:images),'--sandbox',sandbox,...disabled,...writableDirs,...(model?['-m',model]:[]),...(request.mcp?codexMcpOverrides(request.mcp):[]),...codexExtensionPlan(request.extensions).overrides,...codexWebSearchOverrides(request.extensions,request.tools.webTools),...(resume?['resume',request.resumeSessionId!,...images]:[]),'-'];
}
/** CliTalkAgent `normalize_model_for_provider` (Codex): 1-128 characters, `[A-Za-z0-9._:/-]`, and not a Claude alias. */
export function isValidCodexModel(value:string):boolean {
  const model=value.trim();
  if(model.length<1||model.length>128) return false;
  if(['haiku','sonnet','opus'].includes(model.toLowerCase())) return false;
  return /^[A-Za-z0-9._:/-]+$/.test(model);
}
/** CliTalkAgent `should_retry_without_resume` (Codex): the saved thread is gone. */
export function codexResumeNotFound(text:string):boolean {
  const lower=text.toLowerCase();
  return (lower.includes('thread') && (lower.includes('not found') || lower.includes('does not exist'))) || lower.includes('failed to load rollout');
}
/**
 * One `--image=<abs path>` per validated image. Codex splits an image value on commas, so a path containing one
 * is not passed as a flag; the prompt still names the file and Codex reads it from the workspace.
 */
function codexImageArguments(request:AgentRunRequest):string[] {
  return (request.imagePaths ?? []).filter(path=>!path.includes(',')).map(path=>`--image=${path}`);
}
/**
 * Codex `exec --json` reader. Port of CliTalkAgent adapters.rs `parse_codex_jsonl_output`.
 * A line or a field of the wrong type is skipped. It never fails the job.
 * The reply is the trimmed text of the completed `agent_message` items after the last tool item, joined with a new line.
 * With no message after the last tool item, the reply is the last message before it. With no tool item, every message is used.
 * Intended difference from CliTalkAgent `parse_codex_jsonl_output`: the commentary Codex writes before a tool call is not part of the reply.
 * An `error` event and a `turn.failed` event both fail the turn. The last message wins.
 * After the first terminal event, later events are ignored.
 */
export class CodexEvents {
  private terminal=false;
  private sessionSeen=false;
  private messages:string[]=[];
  /** The number of messages received when the last tool item was seen. */
  private toolBoundary=0;
  private lastError:string|undefined;
  private lastLabel:string|undefined;
  private toolCount=0;
  /** Same meaning as CliTalkAgent `provider_line_has_tool_activity` (any line of the run). */
  hadToolActivity=false;
  /** Same meaning as CliTalkAgent `provider_line_has_effective_output` (any line of the run). */
  hadEffectiveOutput=false;
  /** The raw text of the last remembered Codex error. Callers test it; they never show it. */
  get rawError():string|undefined {return this.errorText();}
  /** Every completed agent message so far, joined with a new line and trimmed. */
  get messageText():string {return this.messages.join('\n').trim();}
  /** A remembered `error` that never got a terminal event (EOF after it). */
  pendingFailure():AgentEvent|undefined {
    return this.terminal || !this.errorText()?undefined:classifyProviderFailure('Codex',this.errorText());
  }
  /** The messages after the last tool item; else the last message before it; else an empty string. */
  private finalReply():string {
    const after=this.messages.slice(this.toolBoundary);
    if(after.length) return after.join('\n').trim();
    return (this.messages.at(-1) ?? '').trim();
  }
  private errorText():string|undefined {
    return this.lastError!==undefined && this.lastError.trim()?this.lastError:undefined;
  }
  accept(value:unknown):AgentEvent[] {
    const data=asObject(value);
    if(!data || this.terminal) return [];
    const events:AgentEvent[]=[];
    const item=asObject(data.item);
    if(codexLineHasToolActivity(data,item)) {this.hadToolActivity=true;this.toolBoundary=this.messages.length;}
    this.hadEffectiveOutput||=codexLineHasEffectiveOutput(data,item);
    switch(data.type) {
      case 'thread.started': {
        const id=asIdentifier(data.thread_id);
        if(id!==undefined && !this.sessionSeen) {this.sessionSeen=true;events.push({type:'started',externalSessionId:id});}
        break;
      }
      case 'item.started': {
        const label=codexItemLabel(item);
        if(label!==undefined && label!==this.lastLabel) {
          this.lastLabel=label;
          events.push({type:'tool_started',toolName:label,toolUseId:nonBlank(asText(item?.id)) ?? `tool-${++this.toolCount}`});
        }
        break;
      }
      case 'item.completed': {
        const message=item?.type==='agent_message'?asText(item.text)?.trim():undefined;
        if(message) {
          events.push({type:'text_delta',text:this.messages.length?`\n${message}`:message});
          this.messages.push(message);
        }
        break;
      }
      case 'turn.completed': {
        this.terminal=true;
        const error=this.errorText();
        if(error!==undefined) {events.push(classifyProviderFailure('Codex',error));break;}
        const finalText=this.finalReply();
        if(!finalText) {
          events.push({type:'failed',code:'NO_ASSISTANT_TEXT',message:'Codex 沒有回傳任何回覆文字。',retryable:false,detail:'no_assistant_text'});
          break;
        }
        const usage=asUsage(data.usage);
        events.push({type:'completed',finalText,...(usage?{usage}:{})});
        break;
      }
      case 'turn.failed':
        this.terminal=true;
        this.lastError=codexErrorMessage(data) ?? this.lastError;
        events.push(classifyProviderFailure('Codex',this.errorText()));
        break;
      // A later message replaces the earlier one, as in CliTalkAgent. A message with no text clears it.
      case 'error': this.lastError=codexErrorMessage(data); break;
      // Forward compatibility: new CLI event types are skipped.
      default: break;
    }
    return events;
  }
}
const nonBlank=(value:string|undefined)=>value!==undefined && value.trim()?value:undefined;
/** CliTalkAgent `codex_error_message`: `message`, then `error` as text, then `error.message`. */
function codexErrorMessage(data:Record<string,unknown>):string|undefined {
  return asText(data.message) ?? asText(data.error) ?? asText(asObject(data.error)?.message);
}
/** CliTalkAgent `codex_line_status`: the label of a command or an MCP tool call that starts. */
function codexItemLabel(item:Record<string,unknown>|undefined):string|undefined {
  switch(item?.type) {
    // Raw commands can contain host paths and credentials, so the label does not show them.
    case 'command_execution': return '執行命令';
    case 'mcp_tool_call': {
      const server=asText(item.server), name=asText(item.name);
      return server!==undefined && name!==undefined?`MCP：${server}.${name}`:undefined;
    }
    default: return undefined;
  }
}
/** CliTalkAgent `provider_line_has_tool_activity` for Codex. */
function codexLineHasToolActivity(data:Record<string,unknown>,item:Record<string,unknown>|undefined):boolean {
  const kind=asText(item?.type);
  return asText(data.type)?.startsWith('item.')===true && kind!==undefined && !['agent_message','reasoning','error'].includes(kind);
}
/** CliTalkAgent `provider_line_has_effective_output` for Codex. */
function codexLineHasEffectiveOutput(data:Record<string,unknown>,item:Record<string,unknown>|undefined):boolean {
  if(Object.hasOwn(data,'error')) return false;
  return item?.type==='agent_message' && (asText(item.text) ?? '').trim()!=='';
}
