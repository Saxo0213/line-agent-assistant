import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';

const FILES=['CLAUDE.md','AGENTS.md'] as const;
const MAX_HASHED_BYTES=1024*1024;

/**
 * Digest of the project instruction files of a working directory. The resident Claude process reads CLAUDE.md (and the AGENTS.md it imports)
 * once at start, so a change of these files must replace the process. Present, absent and changed all give a different digest.
 */
export function projectInstructionDigest(workspace:string):string {
  const hash=createHash('sha256');
  for(const name of FILES) {
    const path=join(workspace,name);
    hash.update(`${name}\0`);
    try {
      const info=statSync(path);
      if(!info.isFile()) {hash.update('other\0');continue;}
      if(info.size>MAX_HASHED_BYTES) hash.update(`large:${info.size}:${info.mtimeMs}\0`);
      else hash.update('file\0').update(readFileSync(path)).update('\0');
    } catch {hash.update('absent\0');}
  }
  return hash.digest('hex');
}
