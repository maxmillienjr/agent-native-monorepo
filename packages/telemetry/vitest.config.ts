import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located tests only: `tsc --build` emits compiled copies into `dist`,
    // which Vitest 4's default exclude no longer covers.
    include: ['src/**/*.test.ts'],
  },
});
