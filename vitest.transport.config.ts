import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@line-agent/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) } },
  test: { environment: 'node', testTimeout: 15_000, hookTimeout: 20_000, include: ['packages/contracts/src/worker-v2.test.ts',
    'packages/line-worker/src/entrypoint.test.ts', 'packages/line-worker/src/mutation-gate-chat-resources.test.ts', 'packages/line-worker/src/chat-resources.test.ts',
    'packages/line-worker/src/chat-resource-bootstrap.test.ts',
    'apps/desktop/src/main/utility-worker-gateway-send.test.ts'] },
});
