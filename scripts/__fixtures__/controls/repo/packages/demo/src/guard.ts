// Fixture source for scripts/lint-controls.test.mjs. Not compiled, not imported.
export const LIMIT = 3;

export function guard(value: number): boolean {
  return value <= LIMIT;
}
