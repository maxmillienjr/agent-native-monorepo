import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { decodeFloat32Base64, encodeFloat32Base64 } from '@repo/agent-cassette';
import { EmbeddingRequestError } from '../agent/model/gemini-embedder.js';

/**
 * Recorded embeddings for the retrieval ablation.
 *
 * Every corpus fact and every query is embedded once through the production
 * embedder and committed, so the ablation runs with no key and no network.
 * The reader lives here rather than in `@repo/eval-harness` because that
 * package does not import `@repo/agent-cassette` on purpose, and the codec is
 * the cassette's: `vector(768)` is `float4`, so float32 base64 loses nothing
 * the database would have kept.
 *
 * The file is keyed on sha256 of the text, not on a fact handle, so a query
 * and a fact with the same wording would share one vector — which is what the
 * embedder would return for both anyway.
 */
export const EmbeddingFileSchema = z.object({
  header: z.object({
    formatVersion: z.literal(1),
    /** Must equal `EMBEDDING_MODEL`. */
    embeddingModel: z.string(),
    /** Must equal `EMBEDDING_DIMENSIONS`. */
    embeddingDimensions: z.number().int().positive(),
    /** When the last vector was written. A resumed recording keeps moving it. */
    recordedAt: z.string().datetime(),
    /** The commit the last vector was written at. */
    gitSha: z.string().length(40),
    /** The dataset these vectors belong to; see `datasetSha256`. */
    datasetSha256: z.string().length(64),
  }),
  /** sha256(text) -> base64 float32, as returned by the production embedder. */
  vectors: z.record(z.string().length(64), z.string()),
});
export type EmbeddingFile = z.infer<typeof EmbeddingFileSchema>;
export type EmbeddingFileHeader = EmbeddingFile['header'];

export function embeddingFilePath(datasetDir: string): string {
  return join(datasetDir, 'recorded', 'embeddings.json');
}

export const textKey = (text: string): string => createHash('sha256').update(text).digest('hex');

export class EmbeddingFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingFileRefusedError';
  }
}

/** What the running configuration requires a file to have been recorded against. */
export interface EmbeddingExpectation {
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly datasetSha256: string;
}

function mismatches(header: EmbeddingFileHeader, expected: EmbeddingExpectation): string[] {
  const out: string[] = [];
  if (header.embeddingModel !== expected.embeddingModel) {
    out.push(`embeddingModel is ${header.embeddingModel}, running ${expected.embeddingModel}`);
  }
  if (header.embeddingDimensions !== expected.embeddingDimensions) {
    out.push(
      `embeddingDimensions is ${header.embeddingDimensions}, running ${expected.embeddingDimensions}`,
    );
  }
  if (header.datasetSha256 !== expected.datasetSha256) {
    out.push(`datasetSha256 is ${header.datasetSha256}, the dataset is ${expected.datasetSha256}`);
  }
  return out;
}

/**
 * Replay: a lookup from text to vector, or a refusal.
 *
 * It refuses rather than falls back, on each of the four things that would
 * make a replayed number describe something else: a different model, a
 * different width, a different dataset — a label edited after recording is a
 * different dataset — or a text with no vector. A missing vector cannot be
 * filled by calling the embedder, because then the run is not on the recorded
 * axis it reports.
 */
export function replayEmbeddings(
  raw: unknown,
  expected: EmbeddingExpectation,
  texts: readonly string[],
): { readonly header: EmbeddingFileHeader; readonly embed: (text: string) => number[] } {
  const file = EmbeddingFileSchema.parse(raw);

  const wrong = mismatches(file.header, expected);
  if (wrong.length > 0) {
    throw new EmbeddingFileRefusedError(
      `the embedding file does not match this configuration: ${wrong.join('; ')}. ` +
        'Re-record it with EVAL_EMBEDDINGS_MODE=record.',
    );
  }

  const missing = [...new Set(texts)].filter((text) => file.vectors[textKey(text)] === undefined);
  if (missing.length > 0) {
    throw new EmbeddingFileRefusedError(
      `the embedding file is missing ${missing.length} vector(s), first: ` +
        `${JSON.stringify(missing[0])}. Resume the recording with EVAL_EMBEDDINGS_MODE=record.`,
    );
  }

  const decoded = new Map<string, number[]>();
  return {
    header: file.header,
    embed: (text) => {
      const key = textKey(text);
      let vector = decoded.get(key);
      if (vector === undefined) {
        const encoded = file.vectors[key];
        if (encoded === undefined) {
          throw new EmbeddingFileRefusedError(`no recorded vector for ${JSON.stringify(text)}`);
        }
        vector = decodeFloat32Base64(encoded);
        if (vector.length !== expected.embeddingDimensions) {
          throw new EmbeddingFileRefusedError(
            `the recorded vector for ${JSON.stringify(text)} has ${vector.length} values, ` +
              `expected ${expected.embeddingDimensions}`,
          );
        }
        decoded.set(key, vector);
      }
      return vector;
    },
  };
}

export interface RecordOutcome {
  /** Vectors requested from the embedder in this invocation. */
  readonly requested: number;
  /** Texts already in the file, skipped without a request. */
  readonly alreadyRecorded: number;
  /** Texts still without a vector when the recorder stopped. */
  readonly remaining: number;
  /** True when a 429 stopped the recording. */
  readonly rateLimited: boolean;
}

export interface RecordOptions {
  readonly path: string;
  readonly texts: readonly string[];
  readonly embed: (text: string) => Promise<number[]>;
  readonly expected: EmbeddingExpectation;
  readonly gitSha: string;
  readonly now?: () => Date;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Record: embed every text not yet in the file, one `embedContent` call each.
 *
 * Resumable, because nothing in this repository records a daily limit for
 * `embedContent` and a wall part-way through should cost a day, not the
 * recording. It skips every text already present, writes the file after
 * every call, and stops on the first 429 with the count of what remains.
 * Any other failure is thrown after the file is written, so the vectors
 * already paid for are kept.
 *
 * It refuses to resume into a file recorded against a different model, width
 * or dataset rather than discarding the vectors in it: overwriting a recording
 * is a decision, and this function does not make it.
 */
export async function recordEmbeddings(options: RecordOptions): Promise<RecordOutcome> {
  const now = options.now ?? (() => new Date());
  const unique = [...new Set(options.texts)];

  let vectors: Record<string, string> = {};
  if (existsSync(options.path)) {
    const existing = EmbeddingFileSchema.parse(JSON.parse(readFileSync(options.path, 'utf8')));
    const wrong = mismatches(existing.header, options.expected);
    if (wrong.length > 0) {
      throw new EmbeddingFileRefusedError(
        `refusing to resume into ${options.path}: ${wrong.join('; ')}. ` +
          'Delete the file to start a new recording.',
      );
    }
    vectors = { ...existing.vectors };
  }

  const todo = unique.filter((text) => vectors[textKey(text)] === undefined);
  const alreadyRecorded = unique.length - todo.length;

  const write = (): void => {
    const file: EmbeddingFile = {
      header: {
        formatVersion: 1,
        embeddingModel: options.expected.embeddingModel,
        embeddingDimensions: options.expected.embeddingDimensions,
        recordedAt: now().toISOString(),
        gitSha: options.gitSha,
        datasetSha256: options.expected.datasetSha256,
      },
      // Sorted, so a resumed recording and a single-pass one of the same
      // vectors are byte-identical.
      vectors: Object.fromEntries(Object.entries(vectors).sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, `${JSON.stringify(file, null, 2)}\n`);
  };

  let requested = 0;
  for (const text of todo) {
    let vector: number[];
    try {
      requested += 1;
      vector = await options.embed(text);
    } catch (error) {
      // Every vector before this one is already on disk: the file is written
      // after each success, so there is nothing to flush here.
      if (error instanceof EmbeddingRequestError && error.status === 429) {
        return {
          requested,
          alreadyRecorded,
          remaining: todo.length - (requested - 1),
          rateLimited: true,
        };
      }
      throw error;
    }

    if (vector.length !== options.expected.embeddingDimensions) {
      throw new EmbeddingFileRefusedError(
        `the embedder returned ${vector.length} values, expected ${options.expected.embeddingDimensions}`,
      );
    }
    vectors[textKey(text)] = encodeFloat32Base64(vector);
    write();
    options.onProgress?.(alreadyRecorded + requested, unique.length);
  }

  if (todo.length === 0 && !existsSync(options.path)) write();

  return { requested, alreadyRecorded, remaining: 0, rateLimited: false };
}
