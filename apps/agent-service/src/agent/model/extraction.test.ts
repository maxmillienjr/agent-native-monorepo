import { describe, it, expect } from 'vitest';
import { parseExtraction, ExtractionFormatError } from './extraction.js';
import { IO_RETRY } from '../graph/retry.js';

const VALID = JSON.stringify({ facts: [{ text: 'Postgres stores episodic memory.' }] });

describe('parseExtraction', () => {
  it('parses a well-formed extraction', () => {
    const result = parseExtraction(VALID);
    expect(result).toEqual({ facts: [{ text: 'Postgres stores episodic memory.' }] });
  });

  it('drops the entities and relationships the extraction no longer asks for (P2-E)', () => {
    // A model may still volunteer them, and the cassettes recorded before
    // P2-E carry them. Nothing reads either one, so they are stripped rather
    // than refused: a response with the facts in it is a usable response.
    const result = parseExtraction(
      JSON.stringify({
        entities: [{ id: 'postgres', label: 'Postgres' }],
        relationships: [],
        facts: [{ text: 'Postgres stores episodic memory.' }],
      }),
    );
    expect(result).toEqual({ facts: [{ text: 'Postgres stores episodic memory.' }] });
  });

  it('accepts an extraction that is legitimately empty', () => {
    // An empty result is a real answer, which is why it cannot also be the
    // signal for "the model returned something unusable."
    const empty = parseExtraction('{"facts":[]}');
    expect(empty.facts).toHaveLength(0);
  });

  it('throws on a fenced response rather than returning an empty extraction', () => {
    // What gemini-2.5-flash returns without responseMimeType: application/json.
    // This is the exact shape that used to be swallowed, so the live path wrote
    // nothing to semantic memory while the run reported success.
    expect(() => parseExtraction('```json\n' + VALID + '\n```')).toThrow(ExtractionFormatError);
  });

  it('throws when the JSON parses but does not match the schema', () => {
    expect(() => parseExtraction('{"entities":[]}')).toThrow(ExtractionFormatError);
    expect(() => parseExtraction('{"facts":[{}]}')).toThrow(ExtractionFormatError);
  });

  it('produces an error the retry policy will retry', () => {
    // A malformed response is transient. If this error were a ZodError, or
    // carried a 4xx status, IO_RETRY would give up on the first attempt.
    let thrown: unknown;
    try {
      parseExtraction('not json at all');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExtractionFormatError);
    expect(IO_RETRY.retryOn?.(thrown as Error)).toBe(true);
  });
});
