import { z } from 'zod';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, l2Normalize } from '@repo/memory-core';
import { withInferenceSpan } from '@repo/telemetry';

/** The Gemini API's models collection, spelled once for every direct call (P1-E's canary too). */
export const GEMINI_MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Carries the HTTP status so the graph's `retryOn` can tell a 4xx from a 5xx,
 * and the response's `google.rpc` details so `classifyRateLimit` can tell a
 * daily quota from any other 429.
 *
 * `errorDetails` is the field name `@google/generative-ai` uses for the same
 * thing on the chat path, so one classifier reads both.
 */
export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorDetails?: readonly unknown[],
  ) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }
}

/** The Google API error envelope, as far as anything here reads it. */
const ErrorBodySchema = z.object({
  error: z.object({ details: z.array(z.unknown()).optional() }).passthrough(),
});

/** The `google.rpc` details of an error body, or `undefined` when it has none or is not JSON. */
export function errorDetailsOf(body: string): unknown[] | undefined {
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error.details : undefined;
  } catch {
    // Not JSON: a proxy's HTML page, an empty body. The status still stands.
    return undefined;
  }
}

/**
 * Embeddings via a direct `embedContent` call rather than the LangChain
 * adapter.
 *
 * This was forced once and is a choice now. `GoogleGenerativeAIEmbeddingsParams`
 * at `@langchain/google-genai` 0.2.x had no output-dimension field; since the
 * P5-C upgrade to 2.x it has `outputDimensionality`. The direct call stays
 * because it works, the `embed` seam covers it, and swapping it would change
 * the live embedding path, which only live `embedContent` calls can verify.
 *
 * The response is L2-normalized because a Matryoshka embedding truncated below
 * its native width is not unit-norm: measured at 0.583 at EMBEDDING_DIMENSIONS
 * against exactly 1.0 for the native output.
 */
export function createGeminiEmbedder(apiKey: string): (text: string) => Promise<number[]> {
  const request = {
    operation: 'embeddings',
    model: EMBEDDING_MODEL,
    seam: 'embed',
    dimensions: EMBEDDING_DIMENSIONS,
  } as const;

  // One embeddings span per call. It records no usage: the response has no
  // usage block, and a count that was never reported is not written as zero.
  return (text: string): Promise<number[]> =>
    withInferenceSpan(request, async () => {
      const response = await fetch(`${GEMINI_MODELS_ENDPOINT}/${EMBEDDING_MODEL}:embedContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new EmbeddingRequestError(
          `embedContent failed: ${response.status} ${body}`,
          response.status,
          errorDetailsOf(body),
        );
      }

      const body = (await response.json()) as { embedding?: { values?: number[] } };
      const values = body.embedding?.values;

      if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingRequestError(
          `embedContent returned ${values?.length ?? 0} values, expected ${EMBEDDING_DIMENSIONS}`,
          502,
        );
      }

      return l2Normalize(values);
    });
}
