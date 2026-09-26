import { z } from 'zod';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, l2Normalize } from '@repo/memory-core';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

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

function errorDetailsOf(body: string): unknown[] | undefined {
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
 * `GoogleGenerativeAIEmbeddingsParams` at the pinned `@langchain/google-genai`
 * exposes model, taskType, title, stripNewLines, apiKey and baseUrl — and no
 * output-dimension field. The version that has one peers on
 * `@langchain/core ^1.2.9`, which is the P5-C upgrade. Until then chat goes
 * through LangChain and embeddings come from here.
 *
 * The response is L2-normalized because a Matryoshka embedding truncated below
 * its native width is not unit-norm: measured at 0.583 at EMBEDDING_DIMENSIONS
 * against exactly 1.0 for the native output.
 */
export function createGeminiEmbedder(apiKey: string): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const response = await fetch(`${ENDPOINT}/${EMBEDDING_MODEL}:embedContent`, {
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
  };
}
