import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';

/** File system access for the transcript lookup. A test can give a fake one. */
export interface TranscriptFileSystem {
  /** The names in a directory, or an empty list when it cannot be read. */
  readdir(directory:string):string[];
  /** The file facts, or undefined when the path is missing or is not a file. */
  statFile(path:string):{mtimeMs:number;size:number}|undefined;
}
export const nodeTranscriptFileSystem:TranscriptFileSystem={
  readdir(directory) {try {return readdirSync(directory);} catch {return [];}},
  statFile(path) {
    try {const stat=statSync(path);return stat.isFile()?{mtimeMs:stat.mtimeMs,size:stat.size}:undefined;} catch {return undefined;}
  },
};

/** CliTalkAgent `claude_project_slug` (live_reflection.rs:287-292): each character that is not ASCII letter or digit becomes `-`. */
export function claudeProjectSlug(cwd:string):string {
  return Array.from(cwd,character=>/^[A-Za-z0-9]$/.test(character)?character:'-').join('');
}
const asciiLower=(text:string)=>text.replace(/[A-Z]/g,character=>character.toLowerCase());
const trimTrailingDashes=(text:string)=>text.replace(/-+$/,'');
/** CliTalkAgent `same_project_dir` (live_reflection.rs:309-316): ASCII case-insensitive, trailing `-` ignored. */
export function sameProjectDir(directoryName:string,slug:string):boolean {
  return asciiLower(trimTrailingDashes(directoryName))===asciiLower(trimTrailingDashes(slug));
}

/** The folder of the Claude Code project transcripts: `<CLAUDE_CONFIG_DIR>/projects` when a config directory is set, else `<home>/.claude/projects`. */
export function claudeProjectsDirectory(home:string,claudeConfigDir?:string):string {
  return claudeConfigDir?join(claudeConfigDir,'projects'):join(home,'.claude','projects');
}
/** The home directory from an environment: USERPROFILE first, then HOME. */
export function homeDirectoryFrom(env:NodeJS.ProcessEnv):string|undefined {
  return env.USERPROFILE||env.HOME||undefined;
}

/**
 * CliTalkAgent `pick_claude_transcript` (live_reflection.rs:239-285): choose the `<id>.jsonl` file that Claude writes now.
 * 0 files: undefined. 1 file: that file.
 * More files: (1) the folder name that matches the working directory, (2) the newest modification time, (3) the greatest path.
 * A session id that is not a plain identifier gives undefined, so an id cannot leave the projects folder.
 */
export function pickClaudeTranscript(projects:string,sessionId:string,cwd:string|undefined,fs:TranscriptFileSystem=nodeTranscriptFileSystem):string|undefined {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) return undefined;
  const fileName=`${sessionId}.jsonl`;
  const candidates:{path:string;directory:string;mtimeMs:number}[]=[];
  for(const directory of fs.readdir(projects)) {
    const path=join(projects,directory,fileName);
    const stat=fs.statFile(path);
    if(stat) candidates.push({path,directory,mtimeMs:stat.mtimeMs});
  }
  if(candidates.length<=1) return candidates[0]?.path;
  if(cwd!==undefined) {
    const slug=claudeProjectSlug(cwd);
    const hit=candidates.find(candidate=>sameProjectDir(candidate.directory,slug));
    if(hit) return hit.path;
  }
  return candidates.reduce((best,candidate)=>candidate.mtimeMs>best.mtimeMs||(candidate.mtimeMs===best.mtimeMs&&candidate.path>best.path)?candidate:best).path;
}
/** CliTalkAgent `claude_transcript_path` (live_reflection.rs:228-237). The caller gives the home directory. */
export function claudeTranscriptPath(sessionId:string,cwd:string|undefined,home:string,fs:TranscriptFileSystem=nodeTranscriptFileSystem,claudeConfigDir?:string):string|undefined {
  return pickClaudeTranscript(claudeProjectsDirectory(home,claudeConfigDir),sessionId,cwd,fs);
}
/** CliTalkAgent `transcript_bytes_for` (stream_json_host.rs:1131-1137): the size of the transcript file, or 0 when it is not known. */
export function transcriptBytes(sessionId:string|undefined,cwd:string|undefined,home:string|undefined,fs:TranscriptFileSystem=nodeTranscriptFileSystem,claudeConfigDir?:string):number {
  if(!sessionId||!home) return 0;
  const path=claudeTranscriptPath(sessionId,cwd,home,fs,claudeConfigDir);
  return path?fs.statFile(path)?.size??0:0;
}

export interface AutoSlimOptions {enabled:boolean;maxTurns?:number;maxBytes?:number}
export const AUTO_SLIM_MAX_TURNS=120;
export const AUTO_SLIM_MAX_BYTES=8_000_000;
/** CliTalkAgent `slim_reason` (stream_json_host.rs:1114-1125). The byte limit is checked first. */
export function slimReason(turns:number,bytes:number,options:AutoSlimOptions):'bytes'|'turns'|undefined {
  if(!options.enabled) return undefined;
  if(bytes>=(options.maxBytes??AUTO_SLIM_MAX_BYTES)) return 'bytes';
  if(turns>=(options.maxTurns??AUTO_SLIM_MAX_TURNS)) return 'turns';
  return undefined;
}
