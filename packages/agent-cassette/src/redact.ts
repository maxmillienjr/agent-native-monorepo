/**
 * Key-shaped strings out of anything that is about to be written to a
 * cassette.
 *
 * `createGeminiEmbedder` puts the API key in an `x-goog-api-key` header, and a
 * Google SDK error can carry the request URL it failed on. A decision cassette
 * never sees the header — that is half of why it records at the decision seam —
 * but an error message is free-form text written by someone else's client, and
 * the cassettes are committed to a repository that is read in public. This pass
 * is the belt to that braces.
 */

/** Google API keys. The literal prefix plus 35 characters of key. */
export const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/g;

/** `?key=...` and its relatives, for a key that does not match the prefix. */
const QUERY_SECRET_PATTERN = /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi;

export const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
  return value
    .replace(GOOGLE_API_KEY_PATTERN, REDACTED)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`);
}

/**
 * Walks a value, redacting every string in it. Structure is preserved so a
 * redacted request still diffs against a live one on a miss.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const key of Object.keys(source)) redacted[key] = redactDeep(source[key]);
    return redacted;
  }

  return value;
}

/** True when a value still carries something key-shaped. The test's assertion. */
export function containsSecret(value: string): boolean {
  return new RegExp(GOOGLE_API_KEY_PATTERN.source).test(value);
}
