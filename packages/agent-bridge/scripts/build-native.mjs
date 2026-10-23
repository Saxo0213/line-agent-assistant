import {execFileSync} from 'node:child_process';
import {mkdirSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32' || process.arch!=='x64') throw new Error('Agent Bridge native host requires Windows x64.');
const systemRoot=realpathSync(process.env.SystemRoot ?? 'C:\\Windows');
const compiler=realpathSync(join(systemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'));
if(!isAbsolute(compiler) || relative(systemRoot,compiler).toLowerCase()!=='microsoft.net\\framework64\\v4.0.30319\\csc.exe' || readFileSync(compiler).subarray(0,2).toString()!=='MZ') {
  throw new Error('A trusted Windows .NET Framework x64 compiler is required.');
}
const output=fileURLToPath(new URL('../dist/native/',import.meta.url));
mkdirSync(output,{recursive:true});
execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+',`/out:${join(output,'JobHost.exe')}`,fileURLToPath(new URL('../native/JobHost.cs',import.meta.url))],{
  shell:false,windowsHide:true,stdio:'inherit',env:{SystemRoot:systemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},
});
