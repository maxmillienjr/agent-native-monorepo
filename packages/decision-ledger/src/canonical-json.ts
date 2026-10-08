/**
 * Canonical JSON: sorted keys, `undefined` dropped from objects and `null` in
 * arrays, a non-finite number as `null`, a bigint refused.
 *
 * Copied from `@repo/agent-cassette`'s `hash.ts` rather than imported, so this
 * package depends on nothing in the repository but `@repo/determination` and
 * an auditor can lift it out with the rows it verifies. The copy is held to the
 * original byte for byte by `canonical-json.test.ts`, over a shared corpus:
 * P3-E's reviewers sign the cassette's serialisation, and this one must
 * reproduce the bytes they signed.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'bigint') {
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

  return 'null';
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}
