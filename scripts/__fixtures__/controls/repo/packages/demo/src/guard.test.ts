// Fixture test file for scripts/lint-controls.test.mjs. No runner collects it.
import { describe, expect, it } from 'vitest';
import { guard } from './guard.js';

describe('guard', () => {
  it('holds the line', () => {
    expect(guard(3)).toBe(true);
  });

  it.skip('rejects a value past the limit', () => {
    expect(guard(4)).toBe(false);
  });
});
