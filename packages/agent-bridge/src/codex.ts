import type {AgentEvent, AgentRunRequest} from '@line-agent/contracts';
import {identifier, object, ProtocolError, text, usage} from './jsonl.js';
import {classifyProviderFailure,providerMessage} from './failure.js';
import {codexMcpOverrides} from './mcp.js';
import {codexExtensionPlan,codexWebSearchOverrides} from './extensions.js';

export function codexArguments(request:AgentRunRequest,workspace:string) {
  // Codex has no approval broker, so its sandbox is the enforcement boundary.
  if(!request.tools.localTools) throw new Error('Codex requires the local tools permission');
  const level=request.tools.level ?? 'workspace_write';
  // A read-only project folder cannot be protected inside danger-full-access, so such a job runs in workspace-write instead.
  const sandbox=!request.tools.fileWrite||request.tools.ownFolderReadOnly||level==='read_only'?'read-only':level==='full'&&!(request.tools.projectDirs??[]).some(dir=>!dir.writable)?'danger-full-access':'workspace-write';
  // `--add-dir` (an exec-level option, so it also precedes `resume`) adds writable roots to the workspace-write sandbox only; reading is never limited by directory.
  const writableDirs=sandbox==='workspace-write'?(request.tools.projectDirs??[]).filter(dir=>dir.writable).flatMap(dir=>['--add-dir',dir.path]):[];
  const images=codexImageArguments(request);
  // Fresh `exec --image` is variadic: the `--image=<path>` form binds exactly one value, and `-C` follows so the
  // trailing `-` is never swallowed. On `resume` the flag is a plain single-value option after the session id.
  return ['exec','--ignore-user-config',...(request.mcp?codexMcpOverrides(request.mcp):[]),...codexExtensionPlan(request.extensions).overrides,...codexWebSearchOverrides(request.extensions,request.tools.webTools),'--json','--sandbox',sandbox,...writableDirs,'--skip-git-repo-check',...(request.resumeSessionId?[]:images),'-C',workspace,...(request.resumeSessionId?['resume',request.resumeSessionId,...images]:[]),'-'];
}
/**
 * One `--image=<abs path>` per validated image. Codex splits an image value on commas, so a path containing one
 * is not passed as a flag; the prompt still names the file and Codex reads it from the workspace.
 */
function codexImageArguments(request:AgentRunRequest):string[] {
  return (request.imagePaths ?? []).filter(path=>!path.includes(',')).map(path=>`--image=${path}`);
}
export class CodexEvents {
  private messages=new Map<string,string>();
  private terminal=false;
  private failed=false;
  private lastError:string|undefined;
  /** A remembered `error` that never got a terminal event (EOF or garbage after it). */
  pendingFailure():AgentEvent|undefined {
    return this.lastError===undefined?undefined:classifyProviderFailure('Codex',this.lastError);
  }
  accept(value:unknown):AgentEvent[] {
    const data=object(value), type=text(data.type);
    // The first failure wins; Codex follows `error` with `turn.failed` for the same failure.
    if(this.failed) return [];
    if(this.terminal) throw new ProtocolError('Unexpected event after terminal state');
    switch(type) {
      case 'thread.started': return [{type:'started',externalSessionId:identifier(data.thread_id)}];
      case 'turn.started': return [];
      case 'item.started': case 'item.updated': case 'item.completed': {
        const item=object(data.item); identifier(item.id); const kind=text(item.type);
        if(kind!=='agent_message') return [];
        const id=identifier(item.id), current=text(item.text), previous=this.messages.get(id) ?? '';
        if(!current.startsWith(previous)) throw new ProtocolError('Agent text unexpectedly changed');
        this.messages.set(id,current);
        const delta=current.slice(previous.length);
        return delta?[{type:'text_delta',text:delta}]:[];
      }
      case 'turn.completed': {
        this.terminal=true;
        const finalText=[...this.messages.values()].join('\n');
        if(!finalText) throw new ProtocolError('CLI completed without an agent message');
        return [{type:'completed',finalText,...(data.usage===undefined?{}:{usage:usage(data.usage)})}];
      }
      // `error` is never terminal (it may be a retry notice); only turn.failed ends the turn.
      case 'error': this.lastError=providerMessage(data) ?? this.lastError; return [];
      case 'turn.failed':
        this.terminal=true; this.failed=true;
        return [classifyProviderFailure('Codex',providerMessage(data) ?? this.lastError)];
      // Forward compatibility: new CLI event types are not protocol violations.
      default: return [];
    }
  }
}
