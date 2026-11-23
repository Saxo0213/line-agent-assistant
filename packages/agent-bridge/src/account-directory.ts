import {lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import type {AgentProvider} from '@line-agent/contracts';

/** Marker file of a managed account directory. Its text is the account id. CliTalkAgent llm_sources.rs:453-477. */
export const ACCOUNT_MARKER='.linejs-managed-account';
const ACCOUNT_ID=/^[A-Za-z0-9_-]{1,64}$/;
/** Ids of the system sources. A managed account may not use them. */
const RESERVED_IDS=new Set(['claude','codex']);

const inside=(root:string,path:string):boolean=>{
  const rel=relative(root,path);
  return rel!=='' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The directory of a managed account: `<root>/<id>`. It throws for a bad id or a path outside the root. */
export function accountDirectory(root:string,id:string):string {
  if(!ACCOUNT_ID.test(id) || RESERVED_IDS.has(id)) throw new Error('Invalid account id');
  const base=resolve(root);
  const directory=join(base,id);
  if(!inside(base,directory)) throw new Error('Invalid account id');
  return directory;
}

/** Create the account directory and its marker. An existing marker stays as it is. */
export async function createAccountDirectory(root:string,id:string):Promise<string> {
  const directory=accountDirectory(root,id);
  await mkdir(directory,{recursive:true});
  try {await writeFile(join(directory,ACCOUNT_MARKER),id,{encoding:'utf8',flag:'wx'});}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
  return directory;
}

/**
 * Delete the account directory only when its marker text (trimmed) equals the id (CliTalkAgent rule).
 * A link, a path outside the root and a marker that is not a plain file are refused as `marker_mismatch`.
 */
export async function removeAccountDirectory(root:string,id:string):Promise<'removed'|'missing'|'marker_mismatch'> {
  const directory=accountDirectory(root,id);
  let facts;
  try {facts=await lstat(directory);}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return 'missing';throw error;}
  if(facts.isSymbolicLink() || !facts.isDirectory()) return 'marker_mismatch';
  const realRoot=await realpath(resolve(root));
  const realDirectory=await realpath(directory);
  if(!inside(realRoot,realDirectory)) return 'marker_mismatch';
  const markerPath=join(realDirectory,ACCOUNT_MARKER);
  let text:string;
  try {
    if(!(await lstat(markerPath)).isFile()) return 'marker_mismatch';
    text=await readFile(markerPath,'utf8');
  } catch {return 'marker_mismatch';}
  if(text.trim()!==id) return 'marker_mismatch';
  await rm(realDirectory,{recursive:true,force:true});
  return 'removed';
}

/** The login file of a provider inside its config directory. */
export function accountCredentialFile(provider:AgentProvider):string {
  return provider==='claude'?'.credentials.json':'auth.json';
}
