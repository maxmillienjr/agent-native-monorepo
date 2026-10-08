import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The test TSA shells out to openssl to make a CA and a signing key.
    testTimeout: 20_000,
  },
});
