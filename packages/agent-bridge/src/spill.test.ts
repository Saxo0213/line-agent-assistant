import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readdirSync,readFileSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fnv1a64,spillClaudeArguments} from './spill.js';

let directory:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'spill-test-'));});
afterEach(()=>{rmSync(directory,{recursive:true,force:true});});
const bytes=(text:string)=>new TextEncoder().encode(text);
const value=(args:string[],flag:string)=>args[args.indexOf(flag)+1]!;

describe('spill of Claude arguments',()=>{
  it('computes FNV-1a 64 (reference vectors)',()=>{
    expect(fnv1a64(bytes('')).toString(16)).toBe('cbf29ce484222325');
    expect(fnv1a64(bytes('a')).toString(16)).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(bytes('foobar')).toString(16)).toBe('85944171f73967e8');
  });
  it('maps the four flags to files and keeps the other arguments',()=>{
    const persona='人格'.repeat(100);
    const args=['-p','--append-system-prompt',persona,'--agents','{"a":1}','--mcp-config','{"mcpServers":{}}','--settings','{"permissions":{}}','--resume','s1'];
    const result=spillClaudeArguments(args,directory);
    expect(result).not.toContain('--append-system-prompt');
    const promptPath=value(result,'--append-system-prompt-file');
    expect(promptPath).toMatch(/system-prompt-[0-9a-f]{16}\.md$/);
    expect(readFileSync(promptPath,'utf8')).toBe(persona);
    expect(value(result,'--agents')).toMatch(/agents-[0-9a-f]{16}\.json$/);
    expect(readFileSync(value(result,'--agents'),'utf8')).toBe('{"a":1}');
    expect(value(result,'--mcp-config')).toMatch(/mcp-config-[0-9a-f]{16}\.json$/);
    expect(readFileSync(value(result,'--mcp-config'),'utf8')).toBe('{"mcpServers":{}}');
    expect(value(result,'--settings')).toMatch(/settings-[0-9a-f]{16}\.json$/);
    expect(readFileSync(value(result,'--settings'),'utf8')).toBe('{"permissions":{}}');
    expect(result.slice(-2)).toEqual(['--resume','s1']);
    expect(result[0]).toBe('-p');
    expect(args[2]).toBe(persona);
  });
  it('uses the hash of the content in the file name',()=>{
    const result=spillClaudeArguments(['--agents','abc'],directory);
    expect(value(result,'--agents').endsWith(`agents-${fnv1a64(bytes('abc')).toString(16).padStart(16,'0')}.json`)).toBe(true);
  });
  it('writes a file once and rewrites it only when its content is different',()=>{
    const first=spillClaudeArguments(['--agents','one'],directory);
    const path=value(first,'--agents');
    const old=new Date(Date.now()-60_000);
    utimesSync(path,old,old);
    const mtime=statSync(path).mtimeMs;
    expect(spillClaudeArguments(['--agents','one'],directory)).toEqual(first);
    expect(statSync(path).mtimeMs).toBe(mtime);
    writeFileSync(path,'changed');
    spillClaudeArguments(['--agents','one'],directory);
    expect(readFileSync(path,'utf8')).toBe('one');
    expect(readdirSync(directory)).toHaveLength(1);
  });
  it('deletes spill files older than 7 days before a write and keeps other files',()=>{
    const stale=join(directory,'agents-0000000000000000.json');
    const other=join(directory,'notes.txt');
    writeFileSync(stale,'x');writeFileSync(other,'x');
    const old=new Date(Date.now()-8*24*60*60*1000);
    utimesSync(stale,old,old);utimesSync(other,old,old);
    spillClaudeArguments(['--agents','new'],directory);
    const names=readdirSync(directory).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^agents-[0-9a-f]{16}.json$/);
    expect(names[1]).toBe('notes.txt');
    expect(readdirSync(directory)).not.toContain('agents-0000000000000000.json');
  });
  it('keeps the inline value when the write fails',()=>{
    const blocked=join(directory,'file');
    writeFileSync(blocked,'x');
    const args=['--append-system-prompt','text','--settings','{}'];
    expect(spillClaudeArguments(args,join(blocked,'sub'))).toEqual(args);
  });
});
