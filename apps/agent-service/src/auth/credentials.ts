import { z } from 'zod';

/** The variable, named once, because the boot failure has to name it. */
export const CREDENTIALS_VARIABLE = 'SERVICE_CREDENTIALS';

/**
 * The principal every caller is in open mode. Reserved: a configured
 * credential may not claim it, or an authenticated caller would share a task
 * namespace with every anonymous one.
 */
export const OPEN_PRINCIPAL = 'anonymous';

/** Injection token for the parsed credentials. */
export const SERVICE_CREDENTIALS = 'SERVICE_CREDENTIALS';

export interface CredentialDigest {
  readonly principal: string;
  /** sha256 of the token. The service never holds a token. */
  readonly digest: Buffer;
}

/**
 * The same three states as the model and memory axes (P5-A, ADR 0014):
 * unset runs open, set requires a token on every covered route, and malformed
 * refuses to boot.
 */
export type ServiceCredentials =
  | { readonly mode: 'open' }
  | { readonly mode: 'enforced'; readonly credentials: readonly CredentialDigest[] };

/** A configured-but-broken `SERVICE_CREDENTIALS`. Boot exits 1 on it. */
export class CredentialsConfigError extends Error {
  override readonly name = 'CredentialsConfigError';
}

const EntrySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[0-9a-f]{64}$/)
  .transform((entry) => {
    const [principal, hex] = entry.split(':') as [string, string];
    return { principal, digest: Buffer.from(hex, 'hex') };
  });

/**
 * Reads `SERVICE_CREDENTIALS`: a comma-separated list of `principal:sha256hex`.
 *
 * An empty value is unset, as compose passes `${VAR:-}` through as an empty
 * string. Nothing from a rejected entry is echoed, because a token pasted
 * where a digest belongs is exactly the mistake this message reports.
 */
export function parseCredentials(env: NodeJS.ProcessEnv): ServiceCredentials {
  const raw = env[CREDENTIALS_VARIABLE]?.trim();
  if (raw === undefined || raw === '') return { mode: 'open' };

  const entries = raw.split(',').map((entry) => entry.trim());
  const credentials = entries.map((entry, index) => {
    const parsed = EntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new CredentialsConfigError(
        `${CREDENTIALS_VARIABLE} entry ${index + 1} of ${entries.length} is not principal:sha256hex ` +
          '(a principal of letters, digits, dot, dash or underscore, then 64 lowercase hex digits)',
      );
    }
    return parsed.data;
  });

  const principals = credentials.map((c) => c.principal);
  if (principals.includes(OPEN_PRINCIPAL)) {
    throw new CredentialsConfigError(
      `${CREDENTIALS_VARIABLE} may not name the principal "${OPEN_PRINCIPAL}", which open mode reserves`,
    );
  }
  if (new Set(principals).size !== principals.length) {
    throw new CredentialsConfigError(`${CREDENTIALS_VARIABLE} names a principal twice`);
  }
  // Two principals behind one token would make the caller ambiguous.
  const digests = credentials.map((c) => c.digest.toString('hex'));
  if (new Set(digests).size !== digests.length) {
    throw new CredentialsConfigError(`${CREDENTIALS_VARIABLE} gives two principals one token`);
  }

  return { mode: 'enforced', credentials };
}
