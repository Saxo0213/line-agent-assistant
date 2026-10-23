// Read-only: version + official auth status. Never sends prompts or reads credentials.
import {AgentCliBridge} from '../dist/index.js';
const bridge=new AgentCliBridge({workspaceRoots:[]});
for(const provider of ['codex','claude']) {
  console.log(JSON.stringify({provider,health:await bridge.health(provider),auth:await bridge.getAuthStatus(provider)}));
}
