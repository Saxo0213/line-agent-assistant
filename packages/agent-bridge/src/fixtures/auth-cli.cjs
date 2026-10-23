// No network or credential access: a real process emulating official auth output.
const mode = process.argv[2];
const args = process.argv.slice(3);
if (mode === 'codex' && args.join(' ') === 'login status') {
  process.stderr.write('Logged in using ChatGPT\n');
} else if (mode === 'codex-home' && args.join(' ') === 'login status') {
  process.stderr.write(process.env.CODEX_HOME === 'C:\\Users\\test\\.codex-custom' ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
} else if (mode === 'codex-api' && args.join(' ') === 'login status') {
  process.stderr.write('Logged in using API key\n');
} else if (mode === 'claude' && args.join(' ') === 'auth status') {
  process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'private@example.invalid',orgId:null,orgName:null,subscriptionType:'max',accessToken:'should-not-be-exposed'}));
} else if (mode === 'api' && args.join(' ') === 'auth status') {
  process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty',subscriptionType:null}));
} else if (mode === 'console' && args.join(' ') === 'auth status') {
  process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'console',subscriptionType:null}));
} else if (mode === 'logged-out' && args.join(' ') === 'login status') {
  process.stderr.write('Not logged in\n'); process.exitCode = 1;
} else if (mode === 'logged-out' && args.join(' ') === 'auth status') {
  process.stdout.write(JSON.stringify({loggedIn:false})); process.exitCode = 1;
} else if (mode === 'error') {
  process.stderr.write('C:\\Users\\Private\\.credentials\\auth.json OPENAI_API_KEY=sk-super-secret-value'); process.exitCode = 2;
} else if (mode === 'env') {
  const forbidden = Object.keys(process.env).filter(k => /TOKEN|API_KEY|BASE_URL|DATABASE|LINE_|SECRET|NODE_OPTIONS|NODE_PATH/i.test(k));
  process.stdout.write(JSON.stringify({loggedIn:forbidden.length === 0 && Boolean(process.env.USERPROFILE),authMethod:'claude.ai',subscriptionType:'max'}));
} else if (['login', 'logout', 'auth login', 'auth logout'].includes(args.join(' '))) {
  process.exitCode = 0;
} else { process.stderr.write('Unexpected official arguments'); process.exitCode = 3; }
