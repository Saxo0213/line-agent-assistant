export class ProtocolError extends Error {}
export async function* parseJsonl(stream:AsyncIterable<Uint8Array>):AsyncIterable<unknown> {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='';
  let total=0;
  for await(const chunk of stream) {
    total+=chunk.byteLength;
    if(total>16*1024*1024) throw new ProtocolError('CLI output exceeded its size limit');
    buffer+=decoder.decode(chunk,{stream:true});
    let newline:number;
    while((newline=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,newline).trim();
      buffer=buffer.slice(newline+1);
      if(line.length>1024*1024) throw new ProtocolError('CLI line exceeded its size limit');
      if(line) yield parseLine(line);
    }
    if(buffer.length>1024*1024) throw new ProtocolError('CLI line exceeded its size limit');
  }
  buffer+=decoder.decode();
  if(buffer.trim()) yield parseLine(buffer.trim());
}
function parseLine(line:string):unknown {
  try {return JSON.parse(line);} catch {throw new ProtocolError('CLI returned malformed JSONL');}
}
export function object(value:unknown):Record<string,unknown> {
  if(value===null || typeof value!=='object' || Array.isArray(value)) throw new ProtocolError('Expected a JSON object');
  return value as Record<string,unknown>;
}
export function text(value:unknown):string {
  if(typeof value!=='string') throw new ProtocolError('Expected text');
  return value;
}
export function identifier(value:unknown):string {
  const id=text(value);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) throw new ProtocolError('Invalid external identifier');
  return id;
}
export function usage(value:unknown) {
  const data=object(value);
  if(!Number.isSafeInteger(data.input_tokens) || !Number.isSafeInteger(data.output_tokens) || Number(data.input_tokens)<0 || Number(data.output_tokens)<0) throw new ProtocolError('Invalid token usage');
  return {inputTokens:Number(data.input_tokens),outputTokens:Number(data.output_tokens)};
}
