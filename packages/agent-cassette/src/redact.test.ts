import { describe, expect, it } from 'vitest';
import { REDACTED, containsSecret, redactDeep, redactString } from './redact.js';

/**
 * Key-shaped and not a key: the prefix plus 35 characters. It is assembled at
 * runtime rather than written out, so the fixture itself cannot trip a secret
 * scanner on the way past.
 */
const KEY_SHAPED = ['AI', 'za', 'x'.repeat(35)].join('');

describe('redactString', () => {
  it('removes a key-shaped string from an error message', () => {
    const message = `GoogleGenerativeAI Error: got 400 from https://x/v1/models?key=${KEY_SHAPED}`;

    const redacted = redactString(message);

    expect(redacted).not.toContain(KEY_SHAPED);
    expect(redacted).toContain(REDACTED);
    expect(containsSecret(redacted)).toBe(false);
  });

  it('removes a secret query parameter even when the value is not key-shaped', () => {
    expect(redactString('https://x/v1?key=not-a-google-key&alt=sse')).toBe(
      `https://x/v1?key=${REDACTED}&alt=sse`,
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactString('the plan is to read the file')).toBe('the plan is to read the file');
  });
});

describe('redactDeep', () => {
  it('walks a structure and preserves its shape', () => {
    const redacted = redactDeep({
      url: `https://x?key=${KEY_SHAPED}`,
      nested: [{ note: `see ${KEY_SHAPED}` }],
      count: 2,
      flag: null,
    });

    expect(redacted).toEqual({
      url: `https://x?key=${REDACTED}`,
      nested: [{ note: `see ${REDACTED}` }],
      count: 2,
      flag: null,
    });
  });
});
