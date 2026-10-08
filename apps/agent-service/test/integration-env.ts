/**
 * The store guard for this package's integration suite, with the semantics of
 * `packages/memory-core/test/integration-env.ts`: a missing variable skips the
 * suite on a laptop, and fails it naming the variable when
 * `REQUIRE_INTEGRATION_ENV` is set, as the integration job in `e2e.yml` sets it.
 * A copy rather than an import, because a test helper is not part of
 * `memory-core`'s published surface.
 */
export function skipUnlessIntegrationEnv(suiteName: string, ...required: string[]): boolean {
  const missing = required.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return false;

  const flag = (process.env['REQUIRE_INTEGRATION_ENV'] ?? '').trim().toLowerCase();
  if (flag !== '' && flag !== '0' && flag !== 'false') {
    throw new Error(
      `${suiteName} is mandatory because REQUIRE_INTEGRATION_ENV is set, but ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing or empty.`,
    );
  }
  return true;
}
