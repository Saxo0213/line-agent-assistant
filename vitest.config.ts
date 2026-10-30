import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@line-agent/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@line-agent/database': fileURLToPath(new URL('./packages/database/src/index.ts', import.meta.url)),
      '@line-agent/agent-bridge': fileURLToPath(new URL('./packages/agent-bridge/src/index.ts', import.meta.url)),
      '@line-agent/line-worker': fileURLToPath(new URL('./packages/line-worker/src/index.ts', import.meta.url)),
      '@line-agent/line-chrome': fileURLToPath(new URL('./packages/line-chrome/src/index.ts', import.meta.url)),
    },
  },
  test: {
    testTimeout: 15000,
    hookTimeout: 20000,
    environment: 'node',
    // The attachment repository enforces fixed 500 ms database transaction budgets (message-repository.ts), and many
    // suites share one Postgres and the machine's CPUs. Unbounded forks (one per core) pushed those budgets and the
    // native-process fixtures past their limits; a small pool keeps full runs deterministic.
    maxWorkers: 4,
    globalSetup: ['./tests/support/prebuild-desktop.ts'],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/**/*.test.ts'],
  },
});
