// The reader keeps each full line with no size limit, the same as CliTalkAgent stream_json_host.rs.
// The CLI writes a tool result (for example a file in base64) as one line.
// A line that is not valid UTF-8 or not valid JSON is skipped. It never fails the job.
export async function* parseJsonl(stream:AsyncIterable<Uint8Array>):AsyncIterable<unknown> {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let parts:Uint8Array[]=[];
  let size=0;
  const finishLine=():unknown|undefined=>{
    const bytes=parts.length===1?parts[0]!:Buffer.concat(parts);
    parts=[];size=0;
    return decodeLine(decoder,bytes);
  };
  for await(const chunk of stream) {
    let start=0;
    while(start<=chunk.byteLength) {
      const newline=chunk.indexOf(0x0a,start);
      const end=newline<0?chunk.byteLength:newline;
      if(end>start) {parts.push(chunk.slice(start,end));size+=end-start;}
      if(newline<0) break;
      if(size>0) {
        const value=finishLine();
        if(value!==undefined) yield value;
      }
      start=newline+1;
    }
  }
  if(size>0) {
    const value=finishLine();
    if(value!==undefined) yield value;
  }
}
function decodeLine(decoder:{decode(input:Uint8Array):string},bytes:Uint8Array):unknown|undefined {
  let line:string;
  try {line=decoder.decode(bytes).trim();} catch {return undefined;}
  if(!line) return undefined;
  try {return JSON.parse(line);} catch {return undefined;}
}
/** The value as an object, or undefined for any other JSON type. */
export function asObject(value:unknown):Record<string,unknown>|undefined {
  return value===null || typeof value!=='object' || Array.isArray(value)?undefined:value as Record<string,unknown>;
}
/** The value as text, or undefined for any other JSON type. */
export function asText(value:unknown):string|undefined {
  return typeof value==='string'?value:undefined;
}
/** The text of an external session id. An id that cannot be used as a resume id is ignored. */
export function asIdentifier(value:unknown):string|undefined {
  const id=asText(value)?.trim();
  return id && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)?id:undefined;
}
/** Token usage when it is valid. An invalid value is ignored and never fails the job. */
export function asUsage(value:unknown):{inputTokens:number;outputTokens:number}|undefined {
  const data=asObject(value);
  if(!data || !Number.isSafeInteger(data.input_tokens) || !Number.isSafeInteger(data.output_tokens) || Number(data.input_tokens)<0 || Number(data.output_tokens)<0) return undefined;
  return {inputTokens:Number(data.input_tokens),outputTokens:Number(data.output_tokens)};
}
