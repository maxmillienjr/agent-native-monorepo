import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.test-d.ts` is deliberately not matched: a type test is checked by
    // `tsc --noEmit` and must never execute, because the lines under its
    // `@ts-expect-error` comments are calls that would throw.
    include: ['src/**/*.test.ts'],
  },
});
