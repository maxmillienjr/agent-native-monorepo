import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.test-d.ts` is checked by `tsc --noEmit` and never executed.
    include: ['src/**/*.test.ts'],
  },
});
