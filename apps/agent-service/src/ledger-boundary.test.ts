import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

/**
 * The ledger's boundary (P3-C), proven to fire as P3-A's is: the same import
 * linted with the service's own config inside the graph, where it must be an
 * error, and in the run service, which is where the ledger is appended to.
 */
const serviceRoot = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: serviceRoot });

const importsTheLedger = [
  "import { Ledger } from '@repo/decision-ledger';",
  'export const ledger = Ledger;',
  '',
].join('\n');

async function restrictedImports(filePath: string) {
  // An ignored path reports no errors either, so "none" has to mean "linted and clean".
  expect(await eslint.isPathIgnored(filePath)).toBe(false);
  const [result] = await eslint.lintText(importsTheLedger, { filePath });
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('the decision-ledger lint rule', () => {
  it('rejects the ledger inside the graph', async () => {
    const restricted = await restrictedImports('src/agent/nodes/reflect.node.ts');
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.severity).toBe(2);
    expect(restricted[0]?.message).toContain('cannot write the ledger');
  });

  it('allows it in the run service', async () => {
    const restricted = await restrictedImports('src/runs/runs.service.ts');
    expect(restricted).toHaveLength(0);
  });
});
