import type {AgentEvent,AgentRunRequest} from '@line-agent/contracts';
import {identifier,object,ProtocolError,text,usage} from './jsonl.js';
import {classifyProviderFailure,providerMessage} from './failure.js';
import {claudeMcpConfig,claudeMcpToolNames,claudePermissionPromptToolName} from './mcp.js';
import {claudeExtensionPlan} from './extensions.js';

/**
 * Built-in tools from the Main-resolved policy. `--restricted` keeps file tools inside the working directory.
 * Write/Edit are pre-approved only when both the execution level and principal permissions grant file writes.
 * Bash prompts through the internal permission tool only for interactive operator jobs.
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
/** Same deny rules for plain directory paths. */
export function claudeReadOnlyDenyRules(paths:readonly string[]):string[] {
  return claudeProjectDenyRules(paths.map(path=>({path,writable:false})));
}
/** `claude --autocompact <auto|tokens>` (documented in `claude --help`, 100k-1M); 400k is the operator-chosen window (CLI range 100k-1M). */
export const CLAUDE_AUTO_COMPACT_TOKENS=400000;
export function claudeArguments(request:AgentRunRequest) {
  const level=request.tools.level ?? (request.tools.localTools?'workspace_write':'read_only');
  const fullAccess=level==='full'&&request.tools.localTools;
  const allowed:string[]=[...(request.mcp?claudeMcpToolNames():[]),...(request.tools.fileWrite&&['workspace_write','trust','full'].includes(level)?['Write','Edit']:[])];
  const interactive=request.tools.interactiveApproval&&!!request.mcp;
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
  const disallowBash=!interactive||(level==='read_only'&&!bashByToggle);
  // LINE jobs run in dontAsk mode: a tool missing from --allowedTools is refused, so the web tools are listed explicitly.
  const webAllowed=request.tools.webTools&&!fullAccess?CLAUDE_WEB_TOOLS:[];
  allowed.push(...added,...webAllowed,...extension.allowedTools);
  const projectDirs=request.tools.projectDirs??[];
  // Linked folders are always read-only; a job whose writes exist only for project folders must not write its own chat folder either.
  const deny=[...claudeProjectDenyRules(projectDirs),...claudeReadOnlyDenyRules([...(request.tools.fileWrite?request.tools.linkedReadDirs:[]),...(request.tools.ownFolderReadOnly?[request.workspacePath]:[])])];
  const settings=askBashEffective||deny.length?['--settings',JSON.stringify({permissions:{...(askBashEffective?{ask:['Bash']}:{}),...(deny.length?{deny}:{})}})]:[];
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--autocompact',String(CLAUDE_AUTO_COMPACT_TOKENS),...(fullAccess?[]:['--restricted']),'--permission-mode',interactive?'default':'dontAsk',...(interactive?['--permission-prompt-tool',claudePermissionPromptToolName]:[]),'--strict-mcp-config',...[...(request.tools.workspaceRootDir?[request.tools.workspaceRootDir]:[]),...request.tools.linkedReadDirs,...projectDirs.map(dir=>dir.path)].flatMap(directory=>['--add-dir',directory]),...(fullAccess?[]:['--tools',tools.join(',')]),...settings,...(disallowBash?['--disallowedTools','Bash']:[]),...(request.mcp||Object.keys(extension.servers).length?['--mcp-config',claudeMcpConfig(request.mcp,extension.servers)]:[]),...(allowed.length?['--allowedTools',[...new Set(allowed)].join(',')]:[]),...(request.resumeSessionId?['--resume',request.resumeSessionId]:[])];
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
