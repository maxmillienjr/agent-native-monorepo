import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVAL_DATASETS_DIR } from '@repo/eval-harness';
import { VECTOR_SEAM, type Cassette } from '@repo/agent-cassette';
import type { ChatVersionObservation, EmbeddingProbeResult, ModelMetadata } from './probes.js';

/**
 * The canary's committed reference point (P1-E).
 *
 * Its embedding half was copied once from the committed cassettes and does
 * not follow them afterwards, so re-recording a cassette after a prompt edit
 * cannot quietly move what the canary compares against. Every other change to
 * it is `CANARY_BASELINE=update yarn canary` and a commit, so each
 * acknowledged drift is in `git log` — the way back to green after a red
 * scheduled run.
 */
export const CANARY_BASELINE_PATH = join(EVAL_DATASETS_DIR, 'canary', 'baseline.json');

/** The command that accepts what the canary observed as the new baseline. */
export const CANARY_UPDATE_COMMAND = 'CANARY_BASELINE=update yarn canary';

/** The baseline as a reader finds it in the tree. */
export const CANARY_BASELINE_FILE = 'packages/eval-harness/datasets/canary/baseline.json';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');

const MetadataEntrySchema = z.object({
  version: z.string(),
  displayName: z.string(),
  observedAt: DateSchema,
});

const ChatEntrySchema = z.object({
  modelVersion: z.string().min(1),
  observedAt: DateSchema,
});

export const CanaryBaselineSchema = z.object({
  formatVersion: z.literal(1),
  /** `models.get` per id. */
  metadata: z.record(MetadataEntrySchema),
  /** `modelVersion` per id. An id with no entry has never been observed. */
  chat: z.record(ChatEntrySchema),
  embedding: z.object({
    model: z.string(),
    dimensions: z.number().int().positive(),
    /** The date the vectors below were first observed. */
    since: DateSchema,
    /** Where the vectors came from, for a reader checking them. */
    source: z.string(),
    probes: z
      .array(z.object({ taskId: z.string(), text: z.string(), float32Base64: z.string() }))
      .min(1),
  }),
});

export type CanaryBaseline = z.infer<typeof CanaryBaselineSchema>;

export function loadCanaryBaseline(path: string = CANARY_BASELINE_PATH): CanaryBaseline {
  return CanaryBaselineSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function renderCanaryBaseline(baseline: CanaryBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function writeCanaryBaseline(
  baseline: CanaryBaseline,
  path: string = CANARY_BASELINE_PATH,
): void {
  writeFileSync(path, renderCanaryBaseline(baseline));
}

/**
 * The embedding half, from a cassette set: every `embed` decision, in order,
 * with duplicates of a text dropped.
 *
 * Distinct texts because a repeated text is the same probe twice and would
 * spend a call to learn nothing. Every committed embed is a vector; an `embed`
 * that recorded an error has nothing to compare with and is left out.
 */
export function embeddingBaselineFromCassettes(
  cassettes: readonly Cassette[],
  since: string,
): CanaryBaseline['embedding'] {
  const first = cassettes[0];
  if (first === undefined) throw new Error('no cassettes to take an embedding baseline from');

  const seen = new Set<string>();
  const probes: CanaryBaseline['embedding']['probes'] = [];
  for (const cassette of cassettes) {
    for (const decision of cassette.decisions) {
      if (decision.seam !== VECTOR_SEAM || decision.response.kind !== 'vector') continue;
      const text = (decision.request as { text?: unknown }).text;
      if (typeof text !== 'string' || seen.has(text)) continue;
      seen.add(text);
      probes.push({
        taskId: cassette.header.taskId,
        text,
        float32Base64: decision.response.float32Base64,
      });
    }
  }

  const shas = [...new Set(cassettes.map((cassette) => cassette.header.gitSha))].sort();
  const recorded = cassettes.map((cassette) => cassette.header.recordedAt).sort();
  return {
    model: first.header.embeddingModel,
    dimensions: first.header.embeddingDimensions,
    since,
    source:
      `the embed decisions of ${cassettes.length} committed cassette(s) recorded ` +
      `${recorded[0]} at ${shas.join(', ')}`,
    probes,
  };
}

/** What a completed run observed, for `CANARY_BASELINE=update`. */
export interface CanaryObservations {
  readonly metadata: ReadonlyMap<string, ModelMetadata | 'not-found'>;
  readonly chat: ReadonlyMap<string, ChatVersionObservation>;
  readonly embedding?: EmbeddingProbeResult;
}

/**
 * The baseline a deliberate update writes: every string the run observed,
 * dated today, and the embedding vectors only if they changed, so an
 * unchanged set keeps the date it has held since.
 *
 * What a run did not observe — a 404, a response without `modelVersion`, a
 * probe that was not run — keeps its old entry. An update cannot turn a
 * missing answer into a baseline.
 */
export function updatedBaseline(
  baseline: CanaryBaseline,
  observed: CanaryObservations,
  today: string,
): CanaryBaseline {
  const metadata = { ...baseline.metadata };
  for (const [id, entry] of observed.metadata) {
    if (entry === 'not-found') continue;
    const old = metadata[id];
    const same =
      old !== undefined && old.version === entry.version && old.displayName === entry.displayName;
    if (!same) metadata[id] = { ...entry, observedAt: today };
  }

  const chat = { ...baseline.chat };
  for (const [id, entry] of observed.chat) {
    if (entry.modelVersion === undefined) continue;
    if (chat[id]?.modelVersion !== entry.modelVersion) {
      chat[id] = { modelVersion: entry.modelVersion, observedAt: today };
    }
  }

  let embedding = baseline.embedding;
  if (observed.embedding !== undefined && observed.embedding.verdict === 'changed') {
    const vectors = observed.embedding.vectors;
    embedding = {
      ...embedding,
      since: today,
      source: `re-observed live on ${today}; previously ${embedding.source}`,
      probes: embedding.probes.map((probe, index) => ({
        ...probe,
        float32Base64: vectors[index] ?? probe.float32Base64,
      })),
    };
  }

  return { ...baseline, metadata, chat, embedding };
}
