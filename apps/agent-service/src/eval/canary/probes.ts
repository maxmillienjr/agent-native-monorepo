import { z } from 'zod';
import { decodeFloat32Base64, encodeFloat32Base64 } from '@repo/agent-cassette';
import { GEMINI_MODELS_ENDPOINT, errorDetailsOf } from '../../agent/model/gemini-embedder.js';

/**
 * The canary's probes (P1-E): what the API says about each model id, and the
 * verdict for each against the committed baseline.
 *
 * Each probe answers a different question and none substitutes for another.
 * `models.get` costs no inference and catches retirement, but `version` stays
 * `001` through any change behind the id. `modelVersion` on a `generateContent`
 * response is the only place the API names the model that answered, and it is
 * a string the provider controls. The embedding vectors are the one
 * deterministic signal: they were bit-identical across fifteen days, so any
 * difference means the model or its serving changed.
 */

/**
 * What a probe concluded.
 *
 *   unchanged   observed equals the baseline
 *   changed     a pinned id answers differently, or has no baseline to match
 *   gone        the id returns 404
 *   moved       the floating alias answers differently — expected, not drift
 *   unobserved  the response lacked the field the probe reads
 */
export type Verdict = 'unchanged' | 'changed' | 'gone' | 'moved' | 'unobserved';

export type ProbeKind = 'metadata' | 'chat-pinned' | 'chat-floating' | 'embedding';

export const PROBE_KINDS: readonly ProbeKind[] = [
  'metadata',
  'chat-pinned',
  'chat-floating',
  'embedding',
];

export interface ProbeResult {
  readonly probe: ProbeKind;
  readonly id: string;
  /** A pinned id's drift is a defect in the premise replay rests on; a floating one's is news. */
  readonly pinned: boolean;
  readonly verdict: Verdict;
  /** The string, or the baseline date, compared against. */
  readonly baseline: string | undefined;
  readonly observed: string | undefined;
  /** e.g. "3 of 21 vectors differ; min cosine 0.99871" */
  readonly detail?: string;
}

/**
 * A non-2xx answer from a direct model call, carrying what `classifyRateLimit`
 * reads (`status`, `errorDetails`) and which API produced it, so an abort can
 * name the quota that ran out.
 */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly api: 'models.get' | 'generateContent',
    readonly status: number,
    readonly errorDetails?: readonly unknown[],
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

async function failed(
  response: Response,
  api: ModelRequestError['api'],
  id: string,
): Promise<ModelRequestError> {
  const body = await response.text();
  return new ModelRequestError(
    `${api} ${id} failed: ${response.status} ${body}`,
    api,
    response.status,
    errorDetailsOf(body),
  );
}

// --- metadata --------------------------------------------------------------

export interface ModelMetadata {
  readonly version: string;
  readonly displayName: string;
}

const ModelResourceSchema = z.object({
  version: z.string().default(''),
  displayName: z.string().default(''),
});

/** One `models.get`. No inference quota; a 404 is an answer, not an error. */
export async function readModelMetadata(
  id: string,
  apiKey: string,
): Promise<ModelMetadata | 'not-found'> {
  const response = await fetch(`${GEMINI_MODELS_ENDPOINT}/${id}`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (response.status === 404) return 'not-found';
  if (!response.ok) throw await failed(response, 'models.get', id);
  return ModelResourceSchema.parse(await response.json());
}

function describeMetadata(metadata: ModelMetadata): string {
  return `version ${metadata.version}, displayName ${metadata.displayName}`;
}

export function metadataVerdict(
  id: string,
  pinned: boolean,
  baseline: ModelMetadata | undefined,
  observed: ModelMetadata | 'not-found',
): ProbeResult {
  const base = {
    probe: 'metadata' as const,
    id,
    pinned,
    baseline: baseline === undefined ? undefined : describeMetadata(baseline),
  };
  if (observed === 'not-found') {
    return { ...base, verdict: 'gone', observed: undefined, detail: 'models.get returned 404' };
  }
  const text = describeMetadata(observed);
  if (baseline === undefined) {
    return {
      ...base,
      verdict: pinned ? 'changed' : 'moved',
      observed: text,
      detail: 'no baseline to compare with',
    };
  }
  const same =
    baseline.version === observed.version && baseline.displayName === observed.displayName;
  if (same) return { ...base, verdict: 'unchanged', observed: text };
  return { ...base, verdict: pinned ? 'changed' : 'moved', observed: text };
}

// --- chat ------------------------------------------------------------------

/**
 * Fixed and short, so every run asks the same question at the same cost. Only
 * `modelVersion` is read: a thinking model may spend the whole budget thinking
 * and finish with `MAX_TOKENS` and no text, and that does not matter here.
 */
export const CHAT_PROBE_PROMPT = 'Reply with the single word: ok';
export const CHAT_PROBE_MAX_OUTPUT_TOKENS = 64;

export interface ChatUsage {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly totalTokenCount?: number;
}

export interface ChatVersionObservation {
  readonly id: string;
  readonly found: boolean;
  readonly modelVersion?: string;
  readonly finishReason?: string;
  /** As it arrived. P2-C's open question about `totalTokenCount` is answered by reading it. */
  readonly usage?: ChatUsage;
}

const GenerateContentResponseSchema = z.object({
  modelVersion: z.string().min(1).optional(),
  candidates: z.array(z.object({ finishReason: z.string().optional() }).passthrough()).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
});

/**
 * One direct `generateContent` call. Reads `modelVersion`, `finishReason` and
 * `usageMetadata`.
 *
 * Direct with `fetch`, the way `gemini-embedder.ts` calls `embedContent`,
 * because `@langchain/google-genai` at 2.3.2 builds its message from the first
 * candidate and `usageMetadata` and drops `modelVersion` — the one field this
 * probe exists to read. No retry: a 429 is the caller's to classify, and a
 * per-day one must not be spent twice.
 */
export async function probeChatVersion(
  id: string,
  apiKey: string,
): Promise<ChatVersionObservation> {
  const response = await fetch(`${GEMINI_MODELS_ENDPOINT}/${id}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: CHAT_PROBE_PROMPT }] }],
      generationConfig: { maxOutputTokens: CHAT_PROBE_MAX_OUTPUT_TOKENS },
    }),
  });
  if (response.status === 404) return { id, found: false };
  if (!response.ok) throw await failed(response, 'generateContent', id);

  const body = GenerateContentResponseSchema.parse(await response.json());
  const finishReason = body.candidates?.[0]?.finishReason;
  return {
    id,
    found: true,
    ...(body.modelVersion === undefined ? {} : { modelVersion: body.modelVersion }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(body.usageMetadata === undefined ? {} : { usage: body.usageMetadata }),
  };
}

/**
 * A missing `modelVersion` is `unobserved`, never `unchanged`: a field that
 * stopped arriving is how a silent fallback starts (P2-A's correction).
 */
export function chatVerdict(
  observation: ChatVersionObservation,
  pinned: boolean,
  baseline: string | undefined,
): ProbeResult {
  const base = {
    probe: pinned ? ('chat-pinned' as const) : ('chat-floating' as const),
    id: observation.id,
    pinned,
    baseline,
  };
  if (!observation.found) {
    return {
      ...base,
      verdict: 'gone',
      observed: undefined,
      detail: 'generateContent returned 404',
    };
  }
  if (observation.modelVersion === undefined) {
    return {
      ...base,
      verdict: 'unobserved',
      observed: undefined,
      detail: 'the response had no modelVersion',
    };
  }
  const observed = observation.modelVersion;
  if (baseline === observed) return { ...base, verdict: 'unchanged', observed };
  return {
    ...base,
    verdict: pinned ? 'changed' : 'moved',
    observed,
    ...(baseline === undefined ? { detail: 'no baseline to compare with' } : {}),
  };
}

// --- embedding -------------------------------------------------------------

export interface EmbeddingProbe {
  readonly taskId: string;
  readonly text: string;
  /** The recorded vector, as the cassette stores it: L2-normalised, float32, little-endian. */
  readonly float32Base64: string;
}

export interface EmbeddingBaseline {
  readonly model: string;
  /** The date the baseline vectors were first observed. */
  readonly since: string;
  readonly probes: readonly EmbeddingProbe[];
}

export interface EmbeddingProbeResult extends ProbeResult {
  /** What each probe returned, encoded as the baseline stores it; for a re-baseline. */
  readonly vectors: readonly string[];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Embeds every baseline text through `embed` and compares bit for bit after
 * float32 encoding — the representation the cassette recorded.
 *
 * `embed` is `createGeminiEmbedder(apiKey)` in the runner, so the probe goes
 * through the production response check and `l2Normalize` rather than around
 * them. Sequential, so 21 calls are 21 requests in a known order.
 *
 * The rule is identity, not a cosine floor: identity is what was measured
 * (P1-E, Problem). If serving noise ever appears the rule changes at review,
 * with the noise measured; it is not tuned down to make a red run go away.
 */
export async function probeEmbeddings(
  embed: (text: string) => Promise<number[]>,
  baseline: EmbeddingBaseline,
): Promise<EmbeddingProbeResult> {
  const vectors: string[] = [];
  const differing: { index: number; taskId: string; cosine: number }[] = [];

  for (const [index, probe] of baseline.probes.entries()) {
    const observed = encodeFloat32Base64(await embed(probe.text));
    vectors.push(observed);
    if (observed !== probe.float32Base64) {
      differing.push({
        index,
        taskId: probe.taskId,
        cosine: cosine(decodeFloat32Base64(probe.float32Base64), decodeFloat32Base64(observed)),
      });
    }
  }

  const total = baseline.probes.length;
  const base = {
    probe: 'embedding' as const,
    id: baseline.model,
    pinned: true,
    baseline: baseline.since,
    vectors,
  };
  if (differing.length === 0) {
    return { ...base, verdict: 'unchanged', observed: `${total} of ${total} bit-identical` };
  }

  const min = Math.min(...differing.map((entry) => entry.cosine));
  return {
    ...base,
    verdict: 'changed',
    observed: `${total - differing.length} of ${total} bit-identical`,
    detail:
      `${differing.length} of ${total} vectors differ; min cosine ${min.toFixed(9)} — ` +
      differing
        .map((entry) => `#${entry.index} (${entry.taskId}) ${entry.cosine.toFixed(9)}`)
        .join(', '),
  };
}
