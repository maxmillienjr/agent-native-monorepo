import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  CASSETTE_FORMAT_VERSION,
  DecisionSchema,
  buildDecision,
  encodeResponse,
  requestHash,
} from '@repo/agent-cassette';
import { STAGE2_CONDITIONS, type Stage2Condition } from '@repo/eval-harness';
import { calls, tokenCountsFor } from '../agent/model/decision-seam.js';
import { classifyRateLimit, dailyQuotaIds } from '../agent/model/rate-limit.js';
import type { PlanNodeDeps } from '../agent/nodes/plan.node.js';
import { quotaNames } from './embedding-file.js';

/**
 * Stage 2's answers: one `plan.callLlm` decision per (query, condition),
 * recorded once and replayed with no key.
 *
 * Each answer is a cassette decision, format 2, built by the same
 * `buildDecision` over the same `calls.plan` request a cassette records. So
 * an answer's `requestHash` is the sha256 the PRD keys on, and it is the hash
 * a cassette would give the same call. The file is not a cassette: a cassette
 * is one trial, finished and written at its end, and this file has to survive
 * a recording spread over ten days of free-tier quota. It is written after
 * every call, as `embedding-file.ts` is.
 *
 * The 76 answers are committed evidence. Re-scoring them, or changing a
 * grader, needs no call; changing a prompt does, and replay refuses a prompt
 * whose hash is not the recorded one rather than grade an old answer against
 * a new question.
 */

export const AnswerFileHeaderSchema = z.object({
  formatVersion: z.literal(1),
  /** The decision format each answer is written in: a cassette's. */
  decisionFormatVersion: z.literal(CASSETTE_FORMAT_VERSION),
  /** Must equal `CHAT_MODEL`. */
  chatModel: z.string(),
  datasetSha256: z.string().length(64),
  labelsSha256: z.string().length(64),
  /** The selected queries, in the order the recorder asks them. The first write pins them. */
  queries: z.array(z.string()).min(1),
});
export type AnswerFileHeader = z.infer<typeof AnswerFileHeaderSchema>;

export const AnswerEntrySchema = z.object({
  queryId: z.string(),
  condition: z.enum(STAGE2_CONDITIONS),
  recordedAt: z.string().datetime(),
  /** The commit the call was made at. */
  gitSha: z.string().length(40),
  /** Which invocation of the recorder made the call, counting from 1. */
  invocation: z.number().int().positive(),
  decision: DecisionSchema,
});
export type AnswerEntry = z.infer<typeof AnswerEntrySchema>;

export const AnswerFileSchema = z.object({
  header: AnswerFileHeaderSchema,
  /** `answerKey(queryId, condition)` -> the answer. */
  answers: z.record(z.string(), AnswerEntrySchema),
});
export type AnswerFile = z.infer<typeof AnswerFileSchema>;

const PlanAnswerSchema = z.object({ content: z.string() }).passthrough();

export function answerFilePath(datasetDir: string): string {
  return join(datasetDir, 'recorded', 'explanation-answers.json');
}

export const answerKey = (queryId: string, condition: Stage2Condition): string =>
  `${queryId}/${condition}`;

/** One call stage 2 makes: a query, a condition, and the prompt it asks. */
export interface AnswerItem {
  readonly queryId: string;
  readonly condition: Stage2Condition;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

/** The hash the recorded decision is keyed on: a cassette's, over `calls.plan`. */
export const promptHash = (item: AnswerItem): string =>
  requestHash(calls.plan(item.systemPrompt, item.userPrompt));

export class AnswerFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerFileRefusedError';
  }
}

/** A recorded answer, with what the report needs from it. */
export interface RecordedAnswer extends AnswerEntry {
  readonly content: string;
}

/**
 * Everything that makes a file not a recording of these items, at once.
 *
 * A header that differs is a different measurement: another model, another
 * dataset or labels, another selection. An answer whose prompt hash differs
 * answered a different question, which happens when the stores, the
 * retrieval, the explainer or a prompt changed after it was recorded.
 */
function problems(
  file: AnswerFile,
  header: AnswerFileHeader,
  items: readonly AnswerItem[],
): string[] {
  const out: string[] = [];
  for (const field of ['chatModel', 'datasetSha256', 'labelsSha256'] as const) {
    if (file.header[field] !== header[field]) {
      out.push(`${field} is ${file.header[field]}, running ${header[field]}`);
    }
  }
  if (file.header.queries.join(',') !== header.queries.join(',')) {
    out.push(
      `the file was recorded for another selection of ${file.header.queries.length} queries ` +
        `than this run's ${header.queries.length}`,
    );
  }

  const byKey = new Map(items.map((item) => [answerKey(item.queryId, item.condition), item]));
  for (const [key, entry] of Object.entries(file.answers)) {
    if (answerKey(entry.queryId, entry.condition) !== key) {
      out.push(`${key}: holds the answer for ${answerKey(entry.queryId, entry.condition)}`);
      continue;
    }
    const item = byKey.get(key);
    if (item === undefined) {
      out.push(`${key}: not a call this run makes`);
      continue;
    }
    if (entry.decision.seam !== 'plan.callLlm' || entry.decision.response.kind !== 'value') {
      out.push(`${key}: not a plan.callLlm answer`);
      continue;
    }
    if (!PlanAnswerSchema.safeParse(entry.decision.response.value).success) {
      out.push(`${key}: the recorded response has no content`);
    }
    if (entry.decision.requestHash !== promptHash(item)) {
      out.push(`${key}: recorded for another prompt than this run builds`);
    }
  }
  return out;
}

function parse(raw: unknown, where: string): AnswerFile {
  const parsed = AnswerFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AnswerFileRefusedError(`${where} is not an answer file: ${parsed.error.message}`);
  }
  return parsed.data;
}

const contentOf = (entry: AnswerEntry): string =>
  PlanAnswerSchema.parse((entry.decision.response as { value: unknown }).value).content;

/**
 * Replay: the answers recorded so far, or a refusal.
 *
 * A part-recorded file is not refused, because the recording spans days and
 * the report says how far it got. A file that does not match this run is,
 * for every reason `problems` lists.
 */
export function replayAnswers(
  raw: unknown,
  header: AnswerFileHeader,
  items: readonly AnswerItem[],
): ReadonlyMap<string, RecordedAnswer> {
  const file = parse(raw, 'the answer file');
  const wrong = problems(file, header, items);
  if (wrong.length > 0) {
    throw new AnswerFileRefusedError(
      `the answer file does not match this run:\n${wrong.map((w) => `  - ${w}`).join('\n')}`,
    );
  }
  return new Map(
    Object.entries(file.answers).map(([key, entry]) => [
      key,
      { ...entry, content: contentOf(entry) },
    ]),
  );
}

export type StoppedBy = 'complete' | 'budget' | 'daily-quota' | 'rate-limit';

export interface RecordAnswersOutcome {
  /** This invocation's number, counting from 1. */
  readonly invocation: number;
  /** Calls attempted in this invocation, the one that failed included. */
  readonly requested: number;
  /** Answers this invocation wrote. */
  readonly recorded: number;
  /** Answers already in the file, skipped without a call. */
  readonly alreadyRecorded: number;
  /** Calls still to make when the recorder stopped. */
  readonly remaining: number;
  readonly stoppedBy: StoppedBy;
  /** The quota a 429 named. */
  readonly detail?: string;
}

export interface RecordAnswersOptions {
  readonly path: string;
  readonly header: AnswerFileHeader;
  /** Every call stage 2 makes, the two conditions of a query adjacent. */
  readonly items: readonly AnswerItem[];
  /** `RunsService.modelDeps().plan.callLlm`, or a fake. */
  readonly callLlm: PlanNodeDeps['callLlm'];
  /**
   * At most this many calls in this invocation. A query is started only if
   * all its missing calls fit, so the budget never splits a pair.
   */
  readonly maxCalls: number;
  /** A wait before every call after the first, to stay under the per-minute limit. */
  readonly paceMs: number;
  readonly gitSha: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onAnswer?: (key: string, done: number, total: number) => void;
}

/**
 * Record: ask every (query, condition) the file lacks, one call each.
 *
 * - **Resumable.** It skips every answer already in the file and writes the
 *   file after every call, through a rename, so a kill at any point leaves
 *   the answers already paid for and never half a file.
 * - **No double count.** An answer is keyed on (query, condition) and never
 *   asked again once recorded. A file recorded for another prompt, model,
 *   dataset or selection is refused before any call, and so is a second
 *   recorder while one holds the lock.
 * - **Stops cleanly.** On a 429 that names a per-day quota it stops without
 *   recording, since no retry succeeds before midnight Pacific. A 429 that
 *   survived the client's own retries stops it too. Anything else is thrown,
 *   with every earlier answer already on disk.
 *
 * Pairs are kept together where it can choose: a query starts only if its
 * missing calls fit the budget. Only a 429 can split one, and the next
 * invocation finishes that query first; the report names it.
 */
export async function recordAnswers(options: RecordAnswersOptions): Promise<RecordAnswersOutcome> {
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1) {
    throw new AnswerFileRefusedError(
      `maxCalls must be a positive integer; got ${options.maxCalls}`,
    );
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const release = acquireLock(options.path);
  try {
    let answers: Record<string, AnswerEntry> = {};
    if (existsSync(options.path)) {
      const file = parse(JSON.parse(readFileSync(options.path, 'utf8')), options.path);
      const wrong = problems(file, options.header, options.items);
      if (wrong.length > 0) {
        throw new AnswerFileRefusedError(
          `refusing to resume into ${options.path}:\n${wrong.map((w) => `  - ${w}`).join('\n')}\n` +
            'Delete the file to start a new recording.',
        );
      }
      answers = { ...file.answers };
    }

    const invocation = Math.max(0, ...Object.values(answers).map((a) => a.invocation)) + 1;
    const total = options.items.length;
    const alreadyRecorded = options.items.filter(
      (item) => answers[answerKey(item.queryId, item.condition)] !== undefined,
    ).length;

    const write = (): void => {
      const file: AnswerFile = {
        header: options.header,
        // Sorted, so the file's bytes do not depend on the order calls landed in.
        answers: Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))),
      };
      mkdirSync(dirname(options.path), { recursive: true });
      const temporary = `${options.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(temporary, options.path);
    };

    let requested = 0;
    let recorded = 0;
    const missingCount = (): number =>
      options.items.filter((item) => answers[answerKey(item.queryId, item.condition)] === undefined)
        .length;
    const stop = (stoppedBy: StoppedBy, detail?: string): RecordAnswersOutcome => ({
      invocation,
      requested,
      recorded,
      alreadyRecorded,
      remaining: missingCount(),
      stoppedBy,
      ...(detail === undefined ? {} : { detail }),
    });

    for (const queryId of options.header.queries) {
      const missing = options.items.filter(
        (item) =>
          item.queryId === queryId &&
          answers[answerKey(item.queryId, item.condition)] === undefined,
      );
      if (missing.length === 0) continue;
      if (requested + missing.length > options.maxCalls) return stop('budget');

      for (const item of missing) {
        if (requested > 0 && options.paceMs > 0) await sleep(options.paceMs);
        const call = calls.plan(item.systemPrompt, item.userPrompt);
        const started = Date.now();
        requested += 1;
        let result: Awaited<ReturnType<PlanNodeDeps['callLlm']>>;
        try {
          result = await options.callLlm(item.systemPrompt, item.userPrompt);
        } catch (error) {
          const limit = classifyRateLimit(error);
          if (limit === 'daily-quota') {
            const details = (error as { errorDetails?: unknown[] }).errorDetails ?? [];
            return stop('daily-quota', dailyQuotaIds(details).join(', '));
          }
          if (limit === 'unclassified') {
            return stop('rate-limit', quotaNames(error instanceof Error ? error.message : ''));
          }
          throw error;
        }

        const key = answerKey(item.queryId, item.condition);
        answers[key] = {
          queryId: item.queryId,
          condition: item.condition,
          recordedAt: now().toISOString(),
          gitSha: options.gitSha,
          invocation,
          decision: buildDecision(
            call,
            encodeResponse(call.seam, result),
            Date.now() - started,
            tokenCountsFor(call, result),
          ),
        };
        recorded += 1;
        write();
        options.onAnswer?.(key, total - missingCount(), total);
      }
    }

    if (!existsSync(options.path)) write();
    return stop('complete');
  } finally {
    release();
  }
}

/**
 * One recorder at a time per file. Two would each read the file, each ask
 * the same missing call, and the second write would discard the first
 * answer after its quota was spent.
 *
 * The lock holds the owner's pid. A lock whose process is gone — a recorder
 * killed mid-run — is taken over, so a kill costs nothing but the call in
 * flight.
 */
function acquireLock(path: string): () => void {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        if (existsSync(lock)) unlinkSync(lock);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
      if (Number.isInteger(pid) && isAlive(pid)) {
        throw new AnswerFileRefusedError(
          `another recorder (pid ${pid}) holds ${lock}; one recording at a time`,
        );
      }
      unlinkSync(lock);
    }
  }
  throw new AnswerFileRefusedError(`could not take ${lock}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** sha256 of a file's bytes, for the report; null when there is no file. */
export function fileSha256(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}
