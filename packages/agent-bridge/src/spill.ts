import {mkdirSync,readdirSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Spill of long Claude arguments into files. Port of CliTalkAgent `spill_long_claude_args` (adapters.rs).
 * A Windows command line has a limit of 32,767 characters. A long prompt or JSON value in the arguments can exceed it.
 * The value is written to a file and the argument list keeps only the path.
 */
const MAX_AGE_MS=7*24*60*60*1000;
const FNV_OFFSET=0xcbf29ce484222325n;
const FNV_PRIME=0x100000001b3n;
const MASK_64=0xffffffffffffffffn;
/** Spill name pattern. Prune deletes only files that match it. */
const SPILL_NAME=/^(?:system-prompt|agents|mcp-config|settings)-[0-9a-f]{16}\.(?:md|json)$/;

/** FNV-1a 64 of the bytes. It is stable between versions, so the same content gets the same file name. */
export function fnv1a64(content:Uint8Array):bigint {
  let hash=FNV_OFFSET;
  for(const byte of content) hash=((hash^BigInt(byte))*FNV_PRIME)&MASK_64;
  return hash;
}

interface SpillRule {readonly flag:string;readonly fileFlag:string;readonly prefix:string;readonly ext:string}
const RULES:readonly SpillRule[]=[
  {flag:'--append-system-prompt',fileFlag:'--append-system-prompt-file',prefix:'system-prompt',ext:'md'},
  {flag:'--agents',fileFlag:'--agents',prefix:'agents',ext:'json'},
  // Addition of LINEJS: the same two flags accept a file path, so the flag name stays.
  {flag:'--mcp-config',fileFlag:'--mcp-config',prefix:'mcp-config',ext:'json'},
  {flag:'--settings',fileFlag:'--settings',prefix:'settings',ext:'json'},
];

/** Delete spill files that are older than 7 days. A file that the spill code did not make stays. */
function pruneSpilledArguments(directory:string,now:number):void {
  let names:string[];
  try {names=readdirSync(directory);} catch {return;}
  for(const name of names) {
    if(!SPILL_NAME.test(name)) continue;
    try {
      const path=join(directory,name);
      if(now-statSync(path).mtimeMs>MAX_AGE_MS) unlinkSync(path);
    } catch { /* A file that cannot be deleted stays. */ }
  }
}

/**
 * Return a copy of `args` in which each spilled flag points to a file in `directory`.
 * A file is written only when it does not exist or its content is different.
 * If a write fails, the inline value stays.
 */
export function spillClaudeArguments(args:readonly string[],directory:string,now:number=Date.now()):string[] {
  const result=[...args];
  let ready=false;
  const prepare=()=>{
    if(ready) return true;
    try {mkdirSync(directory,{recursive:true});} catch {return false;}
    pruneSpilledArguments(directory,now);
    ready=true;
    return true;
  };
  for(let index=0;index+1<result.length;index++) {
    const rule=RULES.find(candidate=>candidate.flag===result[index]);
    if(!rule) continue;
    const content=result[index+1]!;
    if(!prepare()) continue;
    const bytes=Buffer.from(content,'utf8');
    const path=join(directory,`${rule.prefix}-${fnv1a64(bytes).toString(16).padStart(16,'0')}.${rule.ext}`);
    try {
      let current:Buffer|undefined;
      try {current=readFileSync(path);} catch {current=undefined;}
      if(current===undefined||!current.equals(bytes)) writeFileSync(path,bytes);
    } catch {index++;continue;}
    result[index]=rule.fileFlag;
    result[index+1]=path;
    index++;
  }
  return result;
}
