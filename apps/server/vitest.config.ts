import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    environment: 'node',
    env: {
      DATABASE_URL: 'postgresql://beacon:beacon@localhost:5432/beacon',
      WEB_ORIGIN: 'http://localhost:3000',
      INTERNAL_API_SECRET: 'test-internal-secret-at-least-16',
      CLERK_SECRET_KEY: 'sk_test_x',
      INTEGRATIONS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 zero bytes, base64
    },
  },
});
