import type {AgentProvider} from '@line-agent/contracts';
import type {AccountRef} from './child-environment.js';

/** The fast model the Claude judge uses (`claude --model` alias for the latest Haiku). */
export const CLAUDE_JUDGE_MODEL='haiku';
/** `-c` override that makes the Codex judge think as little as possible. */
export const CODEX_JUDGE_REASONING_OVERRIDE='model_reasoning_effort="low"';
export const JUDGE_DEFAULT_TIMEOUT_MS=20_000;

export interface JudgeRequest {
  provider:AgentProvider;
  /** The user turn. */
  prompt:string;
  /** Standing instructions: Claude receives them as the system prompt, Codex as a leading block of the prompt. */
  systemPrompt:string;
  /** An app-managed empty directory; never a group folder or the Agent workspace. */
  workspacePath:string;
  resumeSessionId?:string;
  timeoutMs?:number;
  /** Account source. Absent = the system source. A managed source without its login file makes the judge fail. */
  account?:AccountRef;
  /**
   * Absolute paths of image files inside `workspacePath`. Only Codex reads them (`--image`).
   * The Claude judge input is plain text, so Claude ignores this field.
   */
  imagePaths?:string[];
}
/** The most images that one judge turn can carry. */
export const JUDGE_MAX_IMAGES=4;
export interface JudgeResult {text:string; sessionId:string}

/** No tools, no MCP servers, no skills, no settings files: the judge only reads the prompt and answers. */
export function claudeJudgeArguments(request:JudgeRequest):string[] {
  return ['-p','--input-format','text','--output-format','stream-json','--verbose','--model',CLAUDE_JUDGE_MODEL,
    '--restricted','--tools','','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{}}),'--disable-slash-commands',
    '--permission-mode','dontAsk','--system-prompt',request.systemPrompt,
    ...(request.resumeSessionId?['--resume',request.resumeSessionId]:[])];
}
/** Read-only sandbox, user config (and with it every MCP server) ignored, low reasoning effort on the default model. */
export function codexJudgeArguments(request:JudgeRequest,workspace:string):string[] {
  return ['exec','--ignore-user-config','--ignore-rules','-c',CODEX_JUDGE_REASONING_OVERRIDE,'--json','--sandbox','read-only',
    '--skip-git-repo-check','-C',workspace,
    // One `--image=<path>` per image. A comma splits the value in Codex, so such a path is not passed.
    ...(request.imagePaths ?? []).filter(file=>!file.includes(',')).map(file=>`--image=${file}`),
    ...(request.resumeSessionId?['resume',request.resumeSessionId]:[]),'-'];
}
/** Codex has no system prompt flag, so the standing instructions lead the prompt. */
export function judgeInput(request:JudgeRequest):string {
  return request.provider==='codex'?`${request.systemPrompt}\n\n${request.prompt}`:request.prompt;
}
