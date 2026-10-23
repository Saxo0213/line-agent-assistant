const fs = require('node:fs');
const path = require('node:path');
const [provider, scenario, ...args] = process.argv.slice(2);
if (args.join(' ') === 'login status') {
  if (scenario === 'api') process.stderr.write('Logged in using API key\n');
  else if (scenario === 'unavailable') process.exitCode = 2;
  else process.stderr.write('Logged in using ChatGPT\n');
  return;
}
if (args.join(' ') === 'auth status') {
  if (scenario === 'api') process.stdout.write('{"loggedIn":true,"authMethod":"api_key"}');
  else if (scenario === 'malformed') process.stdout.write('{not-json');
  else if (scenario === 'unknown') process.stdout.write('{"loggedIn":true,"authMethod":"console"}');
  else if (scenario === 'unavailable') process.exitCode = 2;
  else process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}');
  return;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (scenario === 'echo') {
    const payload = JSON.stringify({args,cwd:process.cwd(),input,env:process.env});
    if (provider === 'codex') {
      send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
      send({type:'item.completed',item:{id:'a',type:'agent_message',text:payload}});
      send({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}});
    } else {
      send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
      send({type:'result',subtype:'success',is_error:false,result:payload,session_id:'22222222-2222-4222-8222-222222222222'});
    }
    return;
  }
  if (scenario === 'malformed') { process.stdout.write('{bad}\n'); return; }
  if (scenario === 'nonzero') { process.stderr.write('Authorization: Bearer sk-unsafe-secret-value\n'); process.exitCode=17; return; }
  if (scenario === 'auth-required') {
    process.stderr.write(provider === 'codex' ? 'Not logged in. Please run codex login.\n' : 'Authentication required. Please run /login.\n');
    process.exitCode=1; return;
  }
  if (scenario === 'hang') { send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}); setInterval(()=>{},1000); return; }
  if (scenario === 'no-session') { send({type:'item.completed',item:{id:'a',type:'agent_message',text:'message'}}); send({type:'turn.completed'}); return; }
  if (scenario === 'empty-turn') { send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}); send({type:'turn.completed'}); return; }
  if (scenario === 'missing-terminal') { send({type:'thread.started',thread_id:'session'}); return; }
  if (scenario === 'invalid-terminal') { send({type:'turn.completed',usage:'invalid'}); return; }
  const limitText = "You've hit your usage limit. Upgrade to Pro or try again in 3 days.";
  if (scenario === 'codex-limit') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}); send({type:'turn.started'});
    send({type:'error',message:limitText}); send({type:'turn.failed',error:{message:limitText}}); process.exitCode=1; return;
  }
  if (scenario === 'codex-limit-reverse') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'turn.failed',error:{message:limitText}}); send({type:'error',message:limitText}); send({type:'error',message:limitText}); return;
  }
  if (scenario === 'codex-fail') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'error',message:'model exploded unexpectedly'}); send({type:'turn.failed',error:{message:'model exploded unexpectedly'}}); return;
  }
  if (scenario === 'codex-secret') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'turn.failed',error:{message:'bad request Authorization: Bearer sk-unsafe-secret-value api_key=abcd1234 '+'x'.repeat(900)}}); return;
  }
  if (scenario === 'codex-unknown-event') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'future.event',payload:{a:1}}); send({type:'error',message:'Reconnecting... 1/5'});
    send({type:'item.completed',item:{id:'a',type:'agent_message',text:'done'}});
    send({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}); return;
  }
  if (scenario === 'codex-error-exit') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'error',message:limitText}); process.exitCode=1; return;
  }
  if (scenario === 'codex-failed-garbage') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'turn.failed',error:{message:limitText}}); process.stdout.write('{bad}\n'); return;
  }
  if (scenario === 'codex-late-limit') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'turn.failed',error:{message:'x'.repeat(700)+' usage limit'}}); return;
  }
  if (scenario === 'codex-complete-then-error') {
    send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
    send({type:'item.completed',item:{id:'a',type:'agent_message',text:'done'}});
    send({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}});
    send({type:'error',message:'late'}); return;
  }
  if (scenario === 'claude-top-error') {
    send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    send({type:'error',error:{message:'Rate limit exceeded'}}); return;
  }
  if (scenario === 'claude-500') {
    send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    send({type:'result',subtype:'success',is_error:true,result:'API Error: 500 Internal server error. Please try again later.'}); return;
  }
  if (scenario === 'claude-auth-result') {
    send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    send({type:'result',subtype:'success',is_error:true,result:'Invalid API key · Please run /login'}); return;
  }
  if (scenario === 'claude-limit') {
    send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    send({type:'result',subtype:'success',is_error:true,result:'Claude AI usage limit reached|1760000000'}); process.exitCode=1; return;
  }
  if (scenario === 'claude-fail') {
    send({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    send({type:'future_event',x:1});
    send({type:'result',subtype:'error_during_execution',is_error:true,result:'tool crashed'}); return;
  }
  if (scenario === 'claude-error') { send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Authorization: Bearer test-token-value']}); return; }
  const bytes = fs.readFileSync(path.join(__dirname, provider === 'codex' ? 'codex-0.144.5.jsonl' : 'claude-2.1.295.jsonl'));
  // Split every UTF-8 multibyte character and every JSON token at some boundary.
  for (let i=0;i<bytes.length;i+=7) { process.stdout.write(bytes.subarray(i,i+7)); await new Promise(resolve=>setTimeout(resolve,1)); }
  if (scenario === 'terminal-then-nonzero') process.exitCode=7;
});
