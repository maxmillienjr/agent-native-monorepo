import { z } from 'zod';

/**
 * The ledger axis (P3-C), a third beside memory and model, with the
 * repository's rule: unset means no ledger, and `docs/STATUS.md` says so; set
 * and unreachable exits 1 at boot.
 *
 * There is no fallback to `DATABASE_URL`. A ledger written with the memory
 * role is a ledger its writer can rewrite, so the URL must name a role that
 * cannot — `ledger_writer` from `roles.sql` — and the module refuses one that
 * can.
 */
const LedgerConfigSchema = z.object({
  databaseUrl: z.string().min(1),
});

export type LedgerConfig = z.infer<typeof LedgerConfigSchema>;

export function readLedgerConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig | null {
  const databaseUrl = env['LEDGER_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') return null;
  return LedgerConfigSchema.parse({ databaseUrl });
}
