import { z } from 'zod';

/**
 * The cassette format and the seam it records at.
 *
 * A cassette is a record of the decisions one evaluation trial made, taken at
 * the seam where the agent spends money rather than at the wire. The trade is
 * argued in `docs/prd/P1-B-agent-cassette.md`: a decision recording carries no
 * credential and survives the client being replaced, at the cost of no longer
 * exercising the client.
 *
 * This package depends on `zod` and nothing else in the repository. That is a
 * constraint, not an accident — the moment it imports `@repo/eval-harness` for
 * an axis type or `@repo/memory-core` for an embedding width, it stops being
 * liftable and becomes a second place the eval types live. Everything it needs
 * to know about the running configuration arrives as data: the header carries
 * `embeddingDimensions`, and the axis check takes the axes as an argument.
 */

/**
 * The five functions that cost a model call, plus tool execution. Freeze these
 * and the run is determined: the graph's one conditional edge branches on what
 * `act.selectTool` returned, `plan`'s prompt is built from state, and every
 * `embed` argument is either the user's message or a fact from the recorded
 * extraction.
 */
export const SEAMS = [
  'plan.callLlm',
  'act.selectTool',
  'act.tool',
  'distill.extractEntities',
  'embed',
] as const;

export type Seam = (typeof SEAMS)[number];

/**
 * The one seam whose response is a vector. It is recorded as base64 float32
 * rather than a JSON float array because `semantic_facts.embedding` is
 * `vector(768)` and pgvector's `vector` is an array of `float4` — so float32
 * loses nothing the database would not lose on the way in, at a quarter of the
 * bytes.
 */
export const VECTOR_SEAM: Seam = 'embed';

export const CassetteHeaderSchema = z.object({
  formatVersion: z.literal(1),
  taskId: z.string().min(1),
  trialIndex: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
  gitSha: z.string().length(40),
  // Recording anything but a live model is a fake of a fake. The literal is the check.
  axes: z.object({ model: z.literal('live'), memory: z.literal('live') }),
  chatModel: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int().positive(),
});

export const DecisionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.unknown() }),
  z.object({ kind: z.literal('vector'), float32Base64: z.string() }),
  z.object({
    kind: z.literal('error'),
    name: z.string(),
    message: z.string(),
    status: z.number().int().optional(),
  }),
]);

export const DecisionSchema = z.object({
  seam: z.enum(SEAMS),
  /** Which tool, at the `act.tool` seam. Absent elsewhere. */
  label: z.string().optional(),
  /** sha256 over canonical JSON of `{ seam, label, request }`. The lookup key. */
  requestHash: z.string().length(64),
  /** Kept for the miss diff, never for lookup. Redacted before it is written. */
  request: z.unknown(),
  response: DecisionResponseSchema,
  tokenCounts: z.object({ prompt: z.number(), completion: z.number() }).optional(),
  latencyMs: z.number().nonnegative(),
});

export const CassetteSchema = z.object({
  header: CassetteHeaderSchema,
  decisions: z.array(DecisionSchema),
});

export type CassetteHeader = z.infer<typeof CassetteHeaderSchema>;
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Cassette = z.infer<typeof CassetteSchema>;
export type TokenCounts = NonNullable<Decision['tokenCounts']>;

/** One decision as the caller describes it, before it has been resolved. */
export interface DecisionCall {
  readonly seam: Seam;
  readonly label?: string;
  readonly request: unknown;
}

/**
 * The record and replay ends of the same seam.
 *
 * A `Deck` sits between the graph and the model half of its dependency set.
 * `CassetteRecorder` calls `live()` and appends what came back;
 * `CassettePlayer` never calls it. The dependency set does not learn which one
 * it is talking to, and in replay mode the wiring constructs no model client at
 * all — so "replay never falls through to a live call" is structural rather
 * than a promise the player makes.
 */
export interface Deck {
  readonly mode: 'record' | 'replay';
  resolve<R>(call: DecisionCall, live: () => Promise<R>): Promise<R>;
}

/**
 * The two axes, as data.
 *
 * `ModelAxis` and `MemoryAxis` live in `@repo/eval-harness`, which this package
 * must not depend on. The axis refusal therefore takes its input as a plain
 * string pair and the caller — the eval wiring — is what calls `detectAxes`.
 */
export interface RecordedAxes {
  readonly model: string;
  readonly memory: string;
}

/**
 * The model configuration a replay is running against, checked against the
 * header before the first decision is served. A cassette recorded on a
 * different chat model, a different embedding model, or a different embedding
 * width is not a recording of the system under test.
 */
export interface ReplayConfig {
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}
