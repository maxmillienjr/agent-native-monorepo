import { createHash } from 'node:crypto';
import type { DecisionCall } from './types.js';

/**
 * Canonical JSON: the same value serialises to the same bytes on every run and
 * in every process.
 *
 * `JSON.stringify` does not promise that. Its object key order is the
 * insertion order of the object it is handed, and a request assembled from
 * spread state can put the same two keys down in either order — which would
 * move the hash and turn every replay into a miss. Keys are therefore sorted,
 * and everything else follows JSON's own rules so that the output stays
 * readable: `undefined` is dropped from objects and becomes `null` in arrays,
 * and a non-finite number becomes `null`.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'bigint') {
    // JSON.stringify throws on these rather than guessing a representation,
    // and a silent guess is how two cassettes disagree about one number.
    throw new TypeError('canonicalJson cannot serialize a bigint');
  }

  if (typeof value === 'object') {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') return serialize(withToJson.toJSON());

    if (Array.isArray(value)) {
      return `[${value.map((entry) => (isOmitted(entry) ? 'null' : serialize(entry))).join(',')}]`;
    }

    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (isOmitted(entry)) return [];
        return [`${JSON.stringify(key)}:${serialize(entry)}`];
      });
    return `{${entries.join(',')}}`;
  }

  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);

  // `undefined`, a function or a symbol reaching here is a top-level value
  // rather than a member, which JSON.stringify reports as `undefined`.
  return 'null';
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * The lookup key: sha256 over canonical JSON of `{ seam, label, request }`.
 *
 * The seam and the label are inside the hash rather than beside it so that two
 * tools called with an identical input cannot collide, and so that a request
 * shape shared by two seams cannot either.
 */
export function requestHash(call: DecisionCall<string>): string {
  const subject: { seam: string; label?: string; request: unknown } = {
    seam: call.seam,
    request: call.request,
  };
  if (call.label !== undefined) subject.label = call.label;

  return createHash('sha256').update(canonicalJson(subject), 'utf8').digest('hex');
}

/**
 * The queue key. One queue per `(seam, label, requestHash)`, which is what
 * makes two identical requests in one run two entries consumed in order rather
 * than one entry served twice.
 *
 * The separator is NUL, written as an escape so the file stays text: it cannot
 * occur in a seam name or a hex hash, so no label can be shaped to collide with
 * a different key.
 */
export function decisionKey(seam: string, label: string | undefined, hash: string): string {
  return `${seam}\u0000${label ?? ''}\u0000${hash}`;
}
