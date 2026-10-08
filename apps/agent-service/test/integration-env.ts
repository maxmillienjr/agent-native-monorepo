/**
 * The integration guard, as `packages/memory-core/test/integration-env.ts`
 * spells it: missing store variables skip the suite on a laptop, and fail it
 * by name when `REQUIRE_INTEGRATION_ENV` is set, which the integration job in
 * `e2e.yml` does. A test helper is not a package export, so the dozen lines
 * are repeated rather than imported across a workspace boundary.
 */
export function skipUnlessIntegrationEnv(suiteName: string, ...required: string[]): boolean {
  const missing = required.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return false;

  const flag = (process.env['REQUIRE_INTEGRATION_ENV'] ?? '').trim().toLowerCase();
  if (flag !== '' && flag !== '0' && flag !== 'false') {
    throw new Error(
      `${suiteName} is mandatory because REQUIRE_INTEGRATION_ENV is set, but ` +
        `${missing.join(', ')} is missing or empty.`,
    );
  }
  return true;
}
