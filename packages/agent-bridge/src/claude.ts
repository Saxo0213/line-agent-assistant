import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {asIdentifier,asObject,asText,asUsage} from './jsonl.js';
import {classifyProviderFailure,providerMessage} from './failure.js';
import {claudeMcpConfig,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
import {claudeExtensionPlan} from './extensions.js';

/**
 * Built-in tools from the Main-resolved policy. `--restricted` keeps file tools inside the working directory.
 * Write/Edit are pre-approved only when both the execution level and principal permissions grant file writes.
 * Bash prompts through the internal permission tool for interactive operator jobs. Non-interactive (LINE) jobs get Bash, WebSearch and WebFetch
 * without a prompt only at the `full` level with local tools; below `full` they never get Bash.
 */
export const CLAUDE_WEB_TOOLS=['WebSearch','WebFetch'] as const;
export function claudeBuiltInTools(policy:AgentRunRequest['tools']):string[] {
  const tools=claudeLevelTools(policy);
  // Every resolved principal may search and open web pages; full access is unrestricted and stays untouched.
  const fullAccess=policy.localTools&&(policy.level ?? 'workspace_write')==='full';
  return policy.webTools&&!fullAccess?[...tools,...CLAUDE_WEB_TOOLS.filter(tool=>!tools.includes(tool))]:tools;
}
function claudeLevelTools(policy:AgentRunRequest['tools']):string[] {
  if(!policy.localTools) return [...(policy.fileRead?['Read','Glob','Grep']:[]),...(policy.fileWrite?['Write','Edit']:[])];
  const level=policy.level ?? (policy.localTools?'workspace_write':'read_only');
  if(level==='full') return [];
  if(level==='read_only') return ['Read','Glob','Grep'];
  if(level==='workspace_write') return ['Read','Glob','Grep','Write','Edit'];
  if(level==='trust') return ['Read','Glob','Grep','Write','Edit','WebFetch','WebSearch'];
  return [...(policy.fileRead?['Read','Glob','Grep']:[]),...(policy.fileWrite?['Write','Edit']:[])];
}
/**
 * Claude permission-rule path form. Rules are matched against POSIX-normalized paths (`C:\a\b` -> `/c/a/b`, UNC `\\s\h\x` -> `//s/h/x`),
 * and a rule starting with `//` means "absolute from the filesystem root" (that first slash is stripped), so the rule path is '/' + the POSIX form.
 */
export function claudePermissionPath(path:string):string {
  const posix=path.startsWith('\\\\')?path.replaceAll('\\','/'):/^[A-Za-z]:[\\/]/.test(path)?'/'+path[0]!.toLowerCase()+path.slice(2).replaceAll('\\','/'):path.replaceAll('\\','/');
  return '/'+posix.replace(/\/+$/,'');
}
/** `Edit` deny rules (documented: Edit rules cover every built-in file-editing tool, Write and NotebookEdit included; a deny beats any allow) for every project folder the job may only read. */
export function claudeProjectDenyRules(projectDirs:AgentRunRequest['tools']['projectDirs']):string[] {
  return (projectDirs??[]).filter(dir=>!dir.writable).flatMap(dir=>{const rule=`${claudePermissionPath(dir.path)}/**`;return [`Edit(${rule})`];});
}
/** `Edit` deny rules for the per-chat rule files of a protected job: AGENTS.md, CLAUDE.md and everything under rules/. */
export function claudeChatRulesDenyRules(workspacePath:string):string[] {
  const base=claudePermissionPath(workspacePath);
  return [`Edit(${base}/AGENTS.md)`,`Edit(${base}/CLAUDE.md)`,`Edit(${base}/rules/**)`];
}
/** Same deny rules for plain directory paths. */
export function claudeReadOnlyDenyRules(paths:readonly string[]):string[] {
  return claudeProjectDenyRules(paths.map(path=>({path,writable:false})));
}
/** One-shot arguments: the text input head, the LINE tool arguments, and `--resume` last. */
export function claudeArguments(request:AgentRunRequest) {
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages',...claudeToolArguments(request,request.mcp?.endpoint),...(request.resumeSessionId?['--resume',request.resumeSessionId]:[])];
}
/**
 * Resident arguments. Same order as CliTalkAgent `build_stream_json_claude_args` (adapters.rs): the stream-json head,
 * `--setting-sources`, the system prompt, `--resume`, `--model`, then the LINE tool arguments.
 */
export function claudeResidentArguments(request:AgentRunRequest,options:{systemPrompt?:string|undefined;model?:string|undefined;mcpEndpoint?:string|undefined}) {
  const systemPrompt=options.systemPrompt?.trim();
  const model=options.model?.trim();
  return ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--setting-sources','project,local',
    ...(systemPrompt?['--append-system-prompt',systemPrompt]:[]),
    ...(request.resumeSessionId?['--resume',request.resumeSessionId]:[]),
    '--model',model||'opus',
    ...claudeToolArguments(request,options.mcpEndpoint)];
}
/** One user turn for the resident stdin: one JSON line (CliTalkAgent stream-json input). */
export function claudeUserTurnLine(text:string):string {
  return JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n';
}
/** The permission, tool, add-dir, settings, MCP and allowedTools arguments. `mcpEndpoint` is the internal MCP URL; without it the job has no internal MCP. */
export function claudeToolArguments(request:AgentRunRequest,mcpEndpoint:string|undefined):string[] {
  const level=request.tools.level ?? (request.tools.localTools?'workspace_write':'read_only');
  const fullAccess=level==='full'&&request.tools.localTools;
  const allowed:string[]=[...(mcpEndpoint?claudeMcpToolNames():[]),...(request.tools.fileWrite&&['workspace_write','trust','full'].includes(level)?['Write','Edit']:[])];
  const interactive=request.tools.interactiveApproval&&!!mcpEndpoint;
  const askBash=interactive&&(level==='workspace_write'||level==='trust');
  const tools=claudeBuiltInTools(request.tools);
  // Extension additions (eligible jobs only; Main leaves `extensions` unset otherwise). They only add: a tool the level already lists is
  // left exactly as it was, full access is already unrestricted, and Bash is added only where the Agent room approval prompt exists.
  const extension=claudeExtensionPlan(request.extensions);
  const toggles=request.extensions?.tools;
  const added=fullAccess||!toggles?[]:[
    ...(toggles.fileRead?['Read','Glob','Grep']:[]),...(toggles.fileWrite?['Write','Edit']:[]),
    ...(toggles.webFetch?['WebFetch']:[]),...(toggles.webSearch?['WebSearch']:[]),
  ].filter(tool=>!tools.includes(tool));
  const bashByToggle=!!toggles?.bash&&!fullAccess&&interactive&&level==='read_only';
  tools.push(...added);
  if(askBash||bashByToggle) tools.push('Bash');
  const askBashEffective=askBash||bashByToggle;
  // Non-interactive jobs at full access with local tools (admin, or a user holding agent.local_tools) run Bash unprompted; deny rules still apply.
  const fullUnattended=fullAccess&&!interactive;
  const disallowBash=fullUnattended?false:!interactive||(level==='read_only'&&!bashByToggle);
  // LINE jobs run in dontAsk mode: a tool missing from --allowedTools is refused, so the web tools are listed explicitly.
  const webAllowed=request.tools.webTools&&(!fullAccess||fullUnattended)?CLAUDE_WEB_TOOLS:[];
  allowed.push(...added,...(fullUnattended?['Bash']:[]),...webAllowed,...extension.allowedTools);
  const projectDirs=request.tools.projectDirs??[];
  // Linked folders are always read-only; a job whose writes exist only for project folders must not write its own chat folder either.
  const deny=[...claudeProjectDenyRules(projectDirs),...claudeReadOnlyDenyRules([...(request.tools.fileWrite?request.tools.linkedReadDirs:[]),...(request.tools.ownFolderReadOnly?[request.workspacePath]:[])]),...(request.tools.chatRulesProtected?claudeChatRulesDenyRules(request.workspacePath):[])];
  const settings=askBashEffective||deny.length?['--settings',JSON.stringify({permissions:{...(askBashEffective?{ask:['Bash']}:{}),...(deny.length?{deny}:{})}})]:[];
  return [...(fullAccess?[]:['--restricted']),'--permission-mode',interactive?'default':'dontAsk',...(interactive?['--permission-prompt-tool',claudePermissionPromptToolName]:[]),'--strict-mcp-config',...[...(request.tools.workspaceRootDir?[request.tools.workspaceRootDir]:[]),...request.tools.linkedReadDirs,...projectDirs.map(dir=>dir.path)].flatMap(directory=>['--add-dir',directory]),...(fullAccess?[]:['--tools',tools.join(',')]),...settings,...(disallowBash?['--disallowedTools','Bash']:[]),...(mcpEndpoint||Object.keys(extension.servers).length?['--mcp-config',claudeMcpConfig(mcpEndpoint?{endpoint:mcpEndpoint}:undefined,extension.servers)]:[]),...(allowed.length?['--allowedTools',[...new Set(allowed)].join(',')]:[])];
}
/**
 * Claude `stream-json` reader. Port of CliTalkAgent adapters.rs and stream_json_host.rs.
 * A line or a field of the wrong type is skipped. It never fails the job.
 * A result is a failure only when `is_error` is true. After the first terminal event, later events are ignored.
 */
export class ClaudeEvents {
  private terminal=false;
  private sessionSeen=false;
  private assistantText='';
  private lastLabel:string|undefined;
  private toolCount=0;
  /** Same meaning as CliTalkAgent `provider_line_has_tool_activity` (any line of the run). */
  hadToolActivity=false;
  /** Same meaning as CliTalkAgent `provider_line_has_effective_output` (any line of the run). */
  hadEffectiveOutput=false;
  pendingFailure():AgentEvent|undefined {return undefined;}
  accept(value:unknown):AgentEvent[] {
    const data=asObject(value);
    if(!data || this.terminal) return [];
    const events:AgentEvent[]=[];
    const sessionId=claudeSessionId(data);
    if(sessionId!==undefined && !this.sessionSeen) {this.sessionSeen=true;events.push({type:'started',externalSessionId:sessionId});}
    this.hadToolActivity||=claudeLineHasToolActivity(data);
    this.hadEffectiveOutput||=claudeLineHasEffectiveOutput(data);
    switch(data.type) {
      case 'stream_event': {
        const event=asObject(data.event);
        const delta=asObject(event?.delta);
        if(event?.type==='content_block_delta' && delta?.type==='text_delta' && typeof delta.text==='string') events.push({type:'text_delta',text:delta.text});
        break;
      }
      case 'assistant': {
        const text=claudeAssistantText(data);
        if(text!==undefined) this.assistantText+=text;
        const label=claudeStatusLabel(data);
        if(label!==undefined && label!==this.lastLabel) {
          this.lastLabel=label;
          const tool=claudeToolUseBlocks(data)[0];
          // The writing label is only remembered, so that the same tool label after a text block is reported again.
          if(tool) events.push({type:'tool_started',toolName:label,toolUseId:nonBlank(asText(tool.id)) ?? `tool-${++this.toolCount}`});
        }
        break;
      }
      case 'result': {
        this.terminal=true;
        if(data.is_error===true) {
          events.push(classifyProviderFailure('Claude',claudeResultError(data)));
          break;
        }
        const result=asText(data.result);
        const reply=result!==undefined && result.trim()?result:this.assistantText;
        const usage=asUsage(data.usage);
        events.push({type:'completed',finalText:stripLeadingTimestamp(reply.trim()),...(usage?{usage}:{})});
        break;
      }
      case 'error':
        this.terminal=true;
        events.push(classifyProviderFailure('Claude',nonBlank(asText(data.message)) ?? nonBlank(asText(data.error)) ?? providerMessage(data)));
        break;
      // Forward compatibility: new CLI event types are skipped.
      default: break;
    }
    return events;
  }
}
const nonBlank=(value:string|undefined)=>value!==undefined && value.trim()?value:undefined;
/** CliTalkAgent `claude_stream_session_id`: a top-level `session_id` or `sessionId`. */
function claudeSessionId(data:Record<string,unknown>):string|undefined {
  return asIdentifier(data.session_id) ?? asIdentifier(data.sessionId);
}
/** CliTalkAgent `claude_stream_result_error`, with the other provider error fields as a last fallback. */
function claudeResultError(data:Record<string,unknown>):string {
  return nonBlank(asText(data.result)) ?? nonBlank(asText(data.error)) ?? providerMessage(data) ?? 'Claude stream returned an error';
}
function claudeContent(data:Record<string,unknown>):unknown {
  return asObject(data.message)?.content ?? data.content;
}
/** CliTalkAgent `claude_stream_text_delta`: the complete text of an `assistant` line, or undefined when it is blank. */
function claudeAssistantText(data:Record<string,unknown>):string|undefined {
  if(data.type!=='assistant') return undefined;
  const chunks:string[]=[];
  if(typeof data.text==='string') chunks.push(data.text);
  const content=claudeContent(data);
  if(typeof content==='string') chunks.push(content);
  else if(Array.isArray(content)) for(const block of content) {
    const item=asObject(block);
    if(item?.type==='text' && typeof item.text==='string') chunks.push(item.text);
  }
  const text=chunks.join('');
  return text.trim()?text:undefined;
}
/** The `tool_use` blocks of an `assistant` line (CliTalkAgent `claude_stream_tool_uses`). */
function claudeToolUseBlocks(data:Record<string,unknown>):Record<string,unknown>[] {
  const content=claudeContent(data);
  if(data.type!=='assistant' || !Array.isArray(content)) return [];
  return content.map(asObject).filter((block):block is Record<string,unknown>=>block?.type==='tool_use');
}
/** CliTalkAgent `claude_stream_status_label`: the label of the first tool_use block; a text block alone gives the writing label. */
function claudeStatusLabel(data:Record<string,unknown>):string|undefined {
  if(data.type!=='assistant') return undefined;
  const content=claudeContent(data);
  if(!Array.isArray(content)) return undefined;
  let sawText=false;
  for(const block of content) {
    const item=asObject(block);
    if(item?.type==='tool_use') return claudeToolLabel(asText(item.name) ?? '');
    if(item?.type==='text') sawText=true;
  }
  return sawText?'撰寫回覆…':undefined;
}
/** CliTalkAgent `tool_status_label`. */
function claudeToolLabel(name:string):string {
  switch(name) {
    case 'Read': return '讀取檔案…';
    case 'Glob': case 'Grep': return '搜尋中…';
    case 'Bash': case 'Shell': return '執行指令…';
    case 'Edit': case 'Write': case 'NotebookEdit': return '編輯檔案…';
    case 'WebFetch': case 'WebSearch': return '查詢網路…';
    case 'Task': return '指派子代理…';
    default: return `使用工具：${name}…`;
  }
}
/** CliTalkAgent `provider_line_has_tool_activity` for Claude. */
function claudeLineHasToolActivity(data:Record<string,unknown>):boolean {
  return claudeToolUseBlocks(data).some(block=>typeof block.name==='string') || asObject(asObject(data.event)?.content_block)?.type==='tool_use';
}
/** CliTalkAgent `provider_line_has_effective_output` for Claude. */
function claudeLineHasEffectiveOutput(data:Record<string,unknown>):boolean {
  if(Object.hasOwn(data,'error')) return false;
  const delta=asObject(asObject(data.event)?.delta);
  const text=claudeAssistantText(data) ?? (delta?.type==='text_delta'?asText(delta.text) ?? '':undefined);
  return text!==undefined && text.trim()!=='';
}
/** CliTalkAgent `strip_leading_timestamp`: remove one leading `[HH:MM]` or `[M/D HH:MM]` token and the spaces after it. */
export function stripLeadingTimestamp(reply:string):string {
  const trimmed=reply.trimStart();
  if(!trimmed.startsWith('[')) return reply;
  const close=trimmed.indexOf(']');
  if(close<0) return reply;
  if(!isTimestampShape(trimmed.slice(1,close))) return reply;
  return trimmed.slice(close+1).replace(/^[ \t　]+/,'');
}
function isTimestampShape(inner:string):boolean {
  if(isHourMinute(inner)) return true;
  const space=inner.indexOf(' ');
  return space>=0 && isMonthDay(inner.slice(0,space)) && isHourMinute(inner.slice(space+1));
}
function isHourMinute(text:string):boolean {
  const colon=text.indexOf(':');
  if(colon<0) return false;
  const hour=text.slice(0,colon), minute=text.slice(colon+1);
  if(hour.length===0 || hour.length>2 || !/^[0-9]+$/.test(hour)) return false;
  if(minute.length!==2 || !/^[0-9]+$/.test(minute)) return false;
  return Number(hour)<=23 && Number(minute)<=59;
}
function isMonthDay(text:string):boolean {
  const slash=text.indexOf('/');
  if(slash<0) return false;
  const month=text.slice(0,slash), day=text.slice(slash+1);
  const digits=(part:string)=>part.length>0 && part.length<=2 && /^[0-9]+$/.test(part);
  if(!digits(month) || !digits(day)) return false;
  return Number(month)>=1 && Number(month)<=12 && Number(day)>=1 && Number(day)<=31;
}

/** CliTalkAgent `claude_stream_is_turn_activity`: an `assistant` line or a `stream_event` line. */
export function claudeIsTurnActivity(line:unknown):boolean {
  const type=asObject(line)?.type;
  return type==='assistant'||type==='stream_event';
}
/** CliTalkAgent `claude_stream_user_origin_is_task_notification`: a harness `user` line that reports a background task. */
export function claudeIsTaskNotification(line:unknown):boolean {
  const data=asObject(line);
  if(data?.type!=='user') return false;
  const message=asObject(data.message);
  const kind=asObject(data.origin)?.kind ?? asObject(message?.origin)?.kind;
  if(kind==='task-notification') return true;
  const marker=(text:unknown)=>typeof text==='string'&&text.includes('<task-notification>');
  const content=message?.content;
  if(typeof content==='string') return marker(content);
  if(Array.isArray(content)) return content.some(block=>marker(asObject(block)?.text));
  return false;
}
/** CliTalkAgent `claude_stream_result_text` and `claude_stream_result_error`: the text and error flag of a `result` line, or undefined for any other line. */
export function claudeResultOf(line:unknown):{text:string;isError:boolean}|undefined {
  const data=asObject(line);
  if(data?.type!=='result') return undefined;
  if(data.is_error===true) return {text:claudeResultError(data),isError:true};
  return {text:typeof data.result==='string'?data.result:'',isError:false};
}
