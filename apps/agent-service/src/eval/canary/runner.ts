import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMBEDDING_MODEL } from '@repo/memory-core';
import { redactDeep } from '@repo/agent-cassette';
import { abortError, type AbortCause, type AbortError } from '@repo/eval-harness';
import { createGeminiEmbedder } from '../../agent/model/gemini-embedder.js';
import { classifyRateLimit, dailyQuotaIds } from '../../agent/model/rate-limit.js';
import { PINNED_CHAT_MODEL } from '../../runs/runs.service.js';
import { MODEL_HOST } from '../cassette-deps.js';
import { updatedBaseline, type CanaryBaseline, type CanaryObservations } from './baseline.js';
import {
  PROBE_KINDS,
  chatVerdict,
  metadataVerdict,
  probeChatVersion,
  probeEmbeddings,
  readModelMetadata,
  type ChatUsage,
  type ChatVersionObservation,
  type EmbeddingProbeResult,
  type ModelMetadata,
  type ProbeKind,
  type ProbeResult,
} from './probes.js';
import { renderCanaryAbortSummary, renderCanarySummary } from './render.js';

/**
 * The floating alias. Google's changelog moved it to `gemini-3-flash-preview`
 * on 2026-01-21 and to `gemini-3.5-flash` on 2026-05-19; `models.get` does not
 * say where it points, and only `modelVersion` on a response does.
 */
export const FLOATING_CHAT_MODEL = 'gemini-flash-latest';

/** The three ids `models.get` is asked about, and whether each is pinned. */
export const METADATA_IDS: readonly { readonly id: string; readonly pinned: boolean }[] = [
  { id: PINNED_CHAT_MODEL, pinned: true },
  { id: EMBEDDING_MODEL, pinned: true },
  { id: FLOATING_CHAT_MODEL, pinned: false },
];

/** Every file a canary run can leave behind, cleared before it starts. */
export const CANARY_OUTPUT_FILES = [
  'canary-report.json',
  'canary-summary.md',
  'canary-abort.json',
] as const;

/** Requests to the model host, by the API they spent. */
export interface RequestCounts {
  readonly metadata: number;
  readonly generateContent: number;
  readonly embedContent: number;
  readonly other: number;
}

/**
 * Counts every request that reaches the model host, by path, from the same
 * `undici:request:create` channel the replay watcher uses (`cassette-deps.ts`).
 * `fetch` publishes there, so the count is what left the process rather than
 * what the probes meant to send.
 */
export function countModelRequests(): { counts: () => RequestCounts; stop: () => void } {
  const counts = { metadata: 0, generateContent: 0, embedContent: 0, other: 0 };
  const listener = (message: unknown): void => {
    const request = (message as { request?: { origin?: unknown; path?: unknown } }).request;
    if (!String(request?.origin ?? '').includes(MODEL_HOST)) return;
    const path = String(request?.path ?? '');
    if (path.includes(':generateContent')) counts.generateContent += 1;
    else if (path.includes(':embedContent')) counts.embedContent += 1;
    else if (/\/models\/[^/:?]+(\?|$)/.test(path)) counts.metadata += 1;
    else counts.other += 1;
  };
  subscribe('undici:request:create', listener);
  return {
    counts: () => ({ ...counts }),
    stop: () => unsubscribe('undici:request:create', listener),
  };
}

export interface CanaryReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `failed` when a pinned probe is `changed`, `gone` or `unobserved`. */
  readonly result: 'passed' | 'failed';
  readonly results: readonly ProbeResult[];
  /** Probes left out by `CANARY_PROBES`. A canary run in CI leaves out none. */
  readonly notRun: readonly ProbeKind[];
  readonly requests: RequestCounts;
  /** `usageMetadata` per chat id, as the API returned it. */
  readonly usage: Readonly<Record<string, ChatUsage>>;
  /** Whether this run rewrote the baseline (`CANARY_BASELINE=update`). */
  readonly baselineUpdated: boolean;
}

export interface CanaryAbort {
  readonly startedAt: string;
  readonly abortedAt: string;
  readonly error: AbortError;
  readonly cause?: AbortCause;
  readonly requests: RequestCounts;
  readonly completed: readonly ProbeResult[];
}

export interface CanaryOptions {
  readonly outputDir: string;
  readonly apiKey: string | undefined;
  readonly baseline: () => CanaryBaseline;
  /** Defaults to all four. */
  readonly probes?: readonly ProbeKind[];
  /** Defaults to `createGeminiEmbedder(apiKey)`, the production embedder. */
  readonly embed?: (text: string) => Promise<number[]>;
  /** Present for `CANARY_BASELINE=update`: receives the baseline to write. */
  readonly update?: (baseline: CanaryBaseline) => void;
  /** Told why the run stopped, after the abort files are written. */
  readonly onAbort?: (error: unknown, abort: CanaryAbort) => void;
  readonly now?: () => Date;
}

/** A pinned probe on one of these exits 1; a floating one never does. */
const FAILING: ReadonlySet<ProbeResult['verdict']> = new Set(['changed', 'gone', 'unobserved']);

export function failingResults(results: readonly ProbeResult[]): ProbeResult[] {
  return results.filter((result) => result.pinned && FAILING.has(result.verdict));
}

/**
 * After an update the baseline holds what was observed, so what still fails is
 * what an update cannot accept: an id that is gone, a field that did not come.
 */
function failingAfterUpdate(results: readonly ProbeResult[]): ProbeResult[] {
  return failingResults(results).filter((result) => result.verdict !== 'changed');
}

/**
 * Reads `CANARY_PROBES`: a comma-separated subset of the four, for a local run
 * on a quota that cannot spare the two `generateContent` calls. Unset, all
 * four run, which is what CI does.
 */
export function readProbeSelection(raw: string | undefined): readonly ProbeKind[] {
  if (raw === undefined || raw.trim() === '') return PROBE_KINDS;
  const picked = raw.split(',').map((entry) => entry.trim());
  const unknown = picked.filter((entry) => !(PROBE_KINDS as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new Error(
      `CANARY_PROBES names ${unknown.map((entry) => `\`${entry}\``).join(', ')}; ` +
        `the probes are ${PROBE_KINDS.join(', ')}`,
    );
  }
  return PROBE_KINDS.filter((kind) => picked.includes(kind));
}

/** No key, no run: there is no stub fallback for a canary. */
export class MissingKeyError extends Error {
  constructor() {
    super('GOOGLE_API_KEY is not set; the canary refuses to run without it');
    this.name = 'MissingKeyError';
  }
}

function apiOf(error: unknown): string {
  if (error instanceof Error && error.name === 'EmbeddingRequestError') return 'embedContent';
  const api = (error as { api?: unknown } | null)?.api;
  return typeof api === 'string' ? api : 'the model API';
}

/** The cause of an abort, for the two a reader can act on specifically. */
export function explainCanaryAbort(error: unknown): AbortCause | undefined {
  if (error instanceof MissingKeyError) {
    return {
      code: 'no-key',
      summary:
        'GOOGLE_API_KEY is not set, so the canary made no request. It has no stub fallback: ' +
        'a canary that measures a canned model reports `unchanged` forever.',
      remedy: 'set GOOGLE_API_KEY in the environment or in `.env` at the repository root.',
    };
  }
  const rateLimit = classifyRateLimit(error);
  if (rateLimit === 'daily-quota') {
    const details = (error as { errorDetails?: unknown }).errorDetails;
    const ids = dailyQuotaIds(Array.isArray(details) ? details : []);
    return {
      code: 'daily-quota',
      summary:
        `daily \`${apiOf(error)}\` quota exhausted` +
        (ids.length > 0 ? ` (\`${ids.join('`, `')}\`)` : '') +
        '. No retry can succeed before the quota resets, so none was made.',
      remedy:
        'wait for the daily reset at midnight Pacific, or run with a key that has quota left.',
    };
  }
  if (rateLimit === 'unclassified') {
    return {
      code: 'rate-limit-unclassified',
      summary: `\`${apiOf(error)}\` answered 429, and the response did not name a per-day quota.`,
    };
  }
  return undefined;
}

/**
 * Runs the selected probes against the baseline and writes the outcome.
 *
 * A completed run writes `canary-report.json` and `canary-summary.md`. Anything
 * that stops it — no key, a 429, a malformed baseline — writes
 * `canary-abort.json` and `canary-summary.md` and no report, the contract
 * P1-C set for `eval-report.json`. The directory is cleared first, so read it,
 * not the exit code.
 */
export async function runCanary(options: CanaryOptions): Promise<'passed' | 'failed' | 'aborted'> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  mkdirSync(options.outputDir, { recursive: true });
  for (const file of CANARY_OUTPUT_FILES) {
    rmSync(resolve(options.outputDir, file), { force: true });
  }

  const requests = countModelRequests();
  const results: ProbeResult[] = [];
  const usage: Record<string, ChatUsage> = {};
  const probes = options.probes ?? PROBE_KINDS;

  try {
    const apiKey = options.apiKey;
    if (apiKey === undefined || apiKey === '') throw new MissingKeyError();
    const baseline = options.baseline();
    const embed = options.embed ?? createGeminiEmbedder(apiKey);

    const metadata = new Map<string, ModelMetadata | 'not-found'>();
    const chat = new Map<string, ChatVersionObservation>();
    let embedding: EmbeddingProbeResult | undefined;

    if (probes.includes('metadata')) {
      for (const { id, pinned } of METADATA_IDS) {
        const observed = await readModelMetadata(id, apiKey);
        metadata.set(id, observed);
        results.push(metadataVerdict(id, pinned, baseline.metadata[id], observed));
      }
    }

    for (const [kind, id, pinned] of [
      ['chat-pinned', PINNED_CHAT_MODEL, true],
      ['chat-floating', FLOATING_CHAT_MODEL, false],
    ] as const) {
      if (!probes.includes(kind)) continue;
      const observation = await probeChatVersion(id, apiKey);
      chat.set(id, observation);
      if (observation.usage !== undefined) usage[id] = observation.usage;
      results.push(chatVerdict(observation, pinned, baseline.chat[id]?.modelVersion));
    }

    if (probes.includes('embedding')) {
      embedding = await probeEmbeddings(embed, baseline.embedding);
      const { vectors: _vectors, ...result } = embedding;
      results.push(result);
    }

    let baselineUpdated = false;
    if (options.update !== undefined) {
      const observed: CanaryObservations = {
        metadata,
        chat,
        ...(embedding === undefined ? {} : { embedding }),
      };
      options.update(updatedBaseline(baseline, observed, startedAt.slice(0, 10)));
      baselineUpdated = true;
    }

    const failing = baselineUpdated ? failingAfterUpdate(results) : failingResults(results);
    const report: CanaryReport = {
      startedAt,
      finishedAt: now().toISOString(),
      result: failing.length > 0 ? 'failed' : 'passed',
      results,
      notRun: PROBE_KINDS.filter((kind) => !probes.includes(kind)),
      requests: requests.counts(),
      usage,
      baselineUpdated,
    };
    writeFileSync(
      resolve(options.outputDir, 'canary-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(
      resolve(options.outputDir, 'canary-summary.md'),
      renderCanarySummary(report, baseline),
    );
    return report.result;
  } catch (error) {
    const cause = explainCanaryAbort(error);
    const abort: CanaryAbort = {
      startedAt,
      abortedAt: now().toISOString(),
      // Redacted: the file is a workflow artifact, and an error body is text
      // someone else's server wrote.
      error: redactDeep(abortError(error)) as AbortError,
      ...(cause === undefined ? {} : { cause }),
      requests: requests.counts(),
      completed: results,
    };
    writeFileSync(
      resolve(options.outputDir, 'canary-abort.json'),
      `${JSON.stringify(abort, null, 2)}\n`,
    );
    writeFileSync(resolve(options.outputDir, 'canary-summary.md'), renderCanaryAbortSummary(abort));
    options.onAbort?.(error, abort);
    return 'aborted';
  } finally {
    requests.stop();
  }
}
