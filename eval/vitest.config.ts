import { defineConfig } from 'vitest/config';
// Separate from the app's tests: `npx vitest run -c eval/vitest.config.ts`
export default defineConfig({ test: { include: ['eval/**/*.eval.ts'], testTimeout: 6 * 3600_000, environment: 'node' } });
