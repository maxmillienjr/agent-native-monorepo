import { ExtractionSchema, type Extraction } from '../graph/state.js';

export const EXTRACTION_PROMPT = `Extract the facts stated in the conversation. Respond with JSON:
{"facts": [{"text": "..."}]}`;

/**
 * A model response that is not a valid extraction.
 *
 * Deliberately not a `ZodError` and deliberately carries no `status`, because
 * `IO_RETRY.retryOn` excludes both: a malformed response is the transient
 * failure a retry policy is for, and classifying it as either would make
 * `distill` fail on the first attempt.
 */
export class ExtractionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionFormatError';
  }
}

/**
 * Parses and validates a model's extraction response.
 *
 * This used to be `try { JSON.parse(...) } catch { return EMPTY_EXTRACTION }`,
 * which is how the live model path wrote nothing to semantic memory while
 * reporting `outcome: "success"`. `gemini-2.5-flash` wraps JSON in a
 * ```json fence unless asked not to, so every extraction threw, every catch
 * returned an empty set, and `reflect` faithfully wrote zero of it. The stub
 * model always parsed, so the acceptance run never saw it.
 *
 * Throwing is the point. An empty extraction is a legitimate answer — a
 * conversation may genuinely contain no facts — so it cannot also be the
 * signal for "the model returned something unusable."
 */
export function parseExtraction(content: string): Extraction {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ExtractionFormatError(
      `extraction was not JSON: ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`,
    );
  }

  const result = ExtractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExtractionFormatError(`extraction did not match the schema: ${result.error.message}`);
  }

  return result.data;
}
