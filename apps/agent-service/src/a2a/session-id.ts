import { uuidV5 } from '../auth/session-scope.js';

// `uuidV5` lives in `auth/session-scope.ts`, beside the `/runs` derivation that
// also uses it (P5-D). Re-exported so this module's importers keep theirs.
export { uuidV5 };

/**
 * The namespace every A2A session id is derived in. A constant, not
 * configuration: changing it gives every principal's every context a new
 * session id, which orphans the history stored under the old one.
 */
export const A2A_SESSION_NAMESPACE = '8a1d4f0e-6b3c-4c55-9a8e-2f7d1c0b5e93';

/**
 * The session an A2A context runs in, for one principal.
 *
 * Not the `contextId` itself: a principal who learned another's context id
 * would then have that conversation rebuilt into its own prompt, and retrieval
 * scoped to it. Deriving the id over principal and context gives each
 * principal its own session namespace with no lookup table, and accepts any
 * client-supplied `contextId` string where `sessionId` must be a UUID.
 *
 * The newline cannot be moved between the halves to collide two pairs,
 * because a principal cannot contain one: `SERVICE_CREDENTIALS` refuses it.
 */
export function contextSessionId(principal: string, contextId: string): string {
  return uuidV5(A2A_SESSION_NAMESPACE, `${principal}\n${contextId}`);
}
