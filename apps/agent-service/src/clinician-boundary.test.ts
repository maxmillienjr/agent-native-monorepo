import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

/**
 * A lint rule that has never fired proves nothing. This lints the same two
 * lines at two paths with the service's own ESLint config: once inside the
 * graph, where importing the clinician constructor must be an error, and once
 * in the HTTP layer, where the clinician review surface lives (P3-E).
 */
const serviceRoot = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: serviceRoot });

const importsTheConstructor = [
  "import { attestAdverseDetermination } from '@repo/determination/clinician';",
  'export const deny = attestAdverseDetermination;',
  '',
].join('\n');

async function restrictedImports(filePath: string) {
  // An ignored path reports no errors either, so "none" has to mean "linted and clean".
  expect(await eslint.isPathIgnored(filePath)).toBe(false);
  const [result] = await eslint.lintText(importsTheConstructor, { filePath });
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('the clinician gate lint rule', () => {
  it('rejects the clinician subpath inside the graph', async () => {
    const restricted = await restrictedImports('src/agent/nodes/dispose.node.ts');
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.severity).toBe(2);
    expect(restricted[0]?.message).toContain('Only a clinician can deny');
  });

  it('allows it outside the graph', async () => {
    const restricted = await restrictedImports('src/review/review.service.ts');
    expect(restricted).toHaveLength(0);
  });
});
