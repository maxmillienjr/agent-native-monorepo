import { z } from 'zod';

const MemoryConfigSchema = z.object({
  databaseUrl: z.string().min(1),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * Reads the memory axis from the environment.
 *
 * Memory and model availability are independent. Switching the whole
 * dependency set on `GOOGLE_API_KEY`, as this service used to, meant a
 * developer with Postgres but no API key got stub memory.
 *
 * Returns `null` when `DATABASE_URL` is unset or empty — the no-database path
 * that keeps a clone with no `.env` working, which P0-A's acceptance criteria
 * require and `test/runs.e2e-spec.ts` depends on.
 *
 * `DATABASE_URL` alone selects the axis, because Postgres is the one store
 * (P2-E). No other variable is read, so one left over in an old `.env` is
 * ignored rather than refused.
 */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig | null {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) return null;
  return MemoryConfigSchema.parse({ databaseUrl });
}
