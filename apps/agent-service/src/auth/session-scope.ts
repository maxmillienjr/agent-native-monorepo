import { createHash } from 'node:crypto';

/**
 * The namespace every `/runs` session id is derived in (P5-D). A constant, not
 * configuration, for the reason `A2A_SESSION_NAMESPACE` is one: changing it
 * gives every caller's every session a new id, and orphans what is stored
 * under the old one.
 *
 * Not A2A's namespace. `/runs` writes the history its client sends, from turn
 * 0, and A2A rebuilds history from episodic memory and needs its turns
 * contiguous. Two namespaces mean a principal's `/runs` session `X` and its
 * A2A context `X` can never be one session.
 */
export const RUNS_SESSION_NAMESPACE = 'dc3293eb-fbea-4b9e-90be-b753f2faee17';

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
 * The session a `/runs` request runs in: the client's id, inside the caller's
 * namespace (P5-D, ADR 0017).
 *
 * The client names a conversation and the service decides where it is
 * stored. Two principals sending one `sessionId` get two sessions, and a
 * caller who computes another principal's stored id, from this function or
 * from `contextSessionId`, gains nothing: its request is derived again, under
 * its own principal, into a session nobody else reaches. The isolation rests
 * on that, not on the namespace being secret, because it is in the
 * repository.
 *
 * Derived in open mode too, where every caller is `anonymous`, so that no
 * route takes a storage id from a caller.
 *
 * The newline cannot be moved between the halves to collide two pairs,
 * because a principal cannot contain one: `SERVICE_CREDENTIALS` refuses it.
 */
export function runsSessionId(principal: string, sessionId: string): string {
  return uuidV5(RUNS_SESSION_NAMESPACE, `${principal}\n${sessionId}`);
}
