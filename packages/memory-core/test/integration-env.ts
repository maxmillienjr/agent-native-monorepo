/**
 * Environment guard for the database-backed integration suites.
 *
 * These suites need a real Postgres (pgvector) and/or a real Neo4j. They used to
 * open with a bare `describe.skipIf(!DATABASE_URL || !NEO4J_URI)`, which is right
 * for a laptop and wrong for CI: when the variables were absent the whole suite
 * skipped and vitest still exited 0, so a nightly run that asserted nothing was
 * indistinguishable from a nightly run that passed.
 *
 * The two audiences are split by an explicit flag:
 *
 *   - No REQUIRE_INTEGRATION_ENV: missing variables mean "skip". Running
 *     `yarn test:integration` on a machine with no Docker stays a no-op, not a
 *     crash.
 *   - REQUIRE_INTEGRATION_ENV set (the integration job in `e2e.yml` sets it,
 *     and `turbo.json` declares it on `test:integration` so strict env mode
 *     lets it through): missing variables are a hard failure naming exactly
 *     which ones are absent. Under the flag the suite can never skip itself
 *     into a green build.
 *
 * Note that this guard only covers *configuration*. If the variables are present
 * but the databases are unreachable, the suite's `beforeAll` throws on connect,
 * which vitest already reports as a failure and a non-zero exit.
 */

const FLAG = 'REQUIRE_INTEGRATION_ENV';

function integrationEnvIsMandatory(): boolean {
  const raw = process.env[FLAG];
  if (raw === undefined) return false;

  const normalized = raw.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/**
 * Decide whether a database-backed suite should skip.
 *
 * @returns `true` when the suite should skip (a required variable is absent and
 *   the suite is not mandatory).
 * @throws when {@link FLAG} is set and any required variable is missing or empty,
 *   with a message naming each missing variable.
 */
export function skipUnlessIntegrationEnv(suiteName: string, ...required: string[]): boolean {
  const missing = required.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length === 0) return false;

  if (integrationEnvIsMandatory()) {
    const subject = missing.length === 1 ? 'variable is' : 'variables are';
    throw new Error(
      `${suiteName} is mandatory because ${FLAG} is set, but the following environment ` +
        `${subject} missing or empty: ${missing.join(', ')}. ` +
        `Point ${missing.join(', ')} at a reachable instance, or unset ${FLAG} to let this ` +
        `suite skip on a machine with no databases.`,
    );
  }

  return true;
}
