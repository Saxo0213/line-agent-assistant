import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {identifier,object,ProtocolError,text,usage} from './jsonl.js';
import {classifyProviderFailure,providerMessage} from './failure.js';
import {claudeMcpConfig,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';

/**
 * Built-in tools from the Main-resolved policy. `--restricted` keeps file tools inside the working directory.
 * Write/Edit are pre-approved only when both the execution level and principal permissions grant file writes.
 * Bash prompts through the internal permission tool only for interactive operator jobs.
 */
export function claudeBuiltInTools(policy:AgentRunRequest['tools']):string[] {
  if(!policy.localTools) return [...(policy.fileRead?['Read','Glob','Grep']:[]),...(policy.fileWrite?['Write','Edit']:[])];
  const level=policy.level ?? (policy.localTools?'workspace_write':'read_only');
  if(level==='full') return [];
  if(level==='read_only') return ['Read','Glob','Grep'];
  if(level==='workspace_write') return ['Read','Glob','Grep','Write','Edit'];
  if(level==='trust') return ['Read','Glob','Grep','Write','Edit','WebFetch','WebSearch'];
  return [...(policy.fileRead?['Read','Glob','Grep']:[]),...(policy.fileWrite?['Write','Edit']:[])];
}
/** `claude --autocompact <auto|tokens>` (documented in `claude --help`, 100k-1M); 400k is the operator-chosen window (CLI range 100k-1M). */
export const CLAUDE_AUTO_COMPACT_TOKENS=400000;
export function claudeArguments(request:AgentRunRequest) {
  const level=request.tools.level ?? (request.tools.localTools?'workspace_write':'read_only');
  const fullAccess=level==='full'&&request.tools.localTools;
  const allowed=[...(request.mcp?claudeMcpToolNames():[]),...(request.tools.fileWrite&&['workspace_write','trust','full'].includes(level)?['Write','Edit']:[])];
  const interactive=request.tools.interactiveApproval&&!!request.mcp;
  const askBash=interactive&&(level==='workspace_write'||level==='trust');
  const disallowBash=!interactive||level==='read_only';
  const tools=claudeBuiltInTools(request.tools);
  if(askBash) tools.push('Bash');
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--autocompact',String(CLAUDE_AUTO_COMPACT_TOKENS),...(fullAccess?[]:['--restricted']),'--permission-mode',interactive?'default':'dontAsk',...(interactive?['--permission-prompt-tool',claudePermissionPromptToolName]:[]),'--strict-mcp-config',...[...(request.tools.workspaceRootDir?[request.tools.workspaceRootDir]:[]),...request.tools.linkedReadDirs].flatMap(directory=>['--add-dir',directory]),...(fullAccess?[]:['--tools',tools.join(',')]),...(askBash?['--settings',JSON.stringify({permissions:{ask:['Bash']}})]:[]),...(disallowBash?['--disallowedTools','Bash']:[]),...(request.mcp?['--mcp-config',claudeMcpConfig(request.mcp)]:[]),...(allowed.length?['--allowedTools',allowed.join(',')]:[]),...(request.resumeSessionId?['--resume',request.resumeSessionId]:[])];
}
export class ClaudeEvents {
  private terminal=false;
  private failed=false;
  pendingFailure():AgentEvent|undefined {return undefined;}
  accept(value:unknown):AgentEvent[] {
    const data=object(value), type=text(data.type);
    if(this.failed) return [];
    if(this.terminal) throw new ProtocolError('Unexpected event after terminal state');
    switch(type) {
      case 'system':
        if(data.subtype==='init') return [{type:'started',externalSessionId:identifier(data.session_id)}];
        return [];
      case 'stream_event': {
        const event=object(data.event); text(event.type);
        if(event.type!=='content_block_delta') return [];
        const delta=object(event.delta); text(delta.type);
        return delta.type==='text_delta'?[{type:'text_delta',text:text(delta.text)}]:[];
      }
      case 'assistant': object(data.message); return [];
      case 'user': return [];
      case 'result': {
        this.terminal=true;
        if(typeof data.is_error!=='boolean') throw new ProtocolError('Result is missing error state');
        if(data.is_error || data.subtype!=='success') {
          this.failed=true;
          const reason=providerMessage(data) ?? (typeof data.subtype==='string'?data.subtype:undefined);
          return [classifyProviderFailure('Claude',reason)];
        }
        return [{type:'completed',finalText:text(data.result),...(data.usage===undefined?{}:{usage:usage(data.usage)})}];
      }
      case 'error':
        this.terminal=true; this.failed=true;
        return [classifyProviderFailure('Claude',providerMessage(data))];
      // Forward compatibility: new CLI event types are not protocol violations.
      default: return [];
    }
  }
}
