import { createHash } from 'node:crypto';

/**
 * The namespace every A2A session id is derived in. A constant, not
 * configuration: changing it gives every principal's every context a new
 * session id, which orphans the history stored under the old one.
 */
export const A2A_SESSION_NAMESPACE = '8a1d4f0e-6b3c-4c55-9a8e-2f7d1c0b5e93';

/** RFC 9562 §5.5: a name-based UUID, SHA-1, version 5. */
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (namespaceBytes.length !== 16) throw new Error(`not a UUID: ${namespace}`);

  const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
