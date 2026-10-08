import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { CASSETTE_FORMAT_VERSION } from '@repo/agent-cassette';
import {
  CypherNeo4jExplainer,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MAX_EXPLANATION_HOPS,
  PgNeo4jSeedManager,
  PgPgvectorReader,
  VectorRetrievalFacade,
  createNeo4jClient,
  createPgvectorPool,
  ensureSemanticConstraints,
  runMigrations,
  type ConceptPath,
  type RetrievalCandidate,
} from '@repo/memory-core';
import {
  RETRIEVAL_ABLATION_DATASET_DIR,
  STAGE2_CONDITIONS,
  STAGE2_QUERY_COUNT,
  bridgeConcepts,
  buildExplanationReport,
  buildStage2Report,
  constructionCheck,
  graphFacts,
  loadExplanationLabels,
  loadRetrievalDataset,
  renderExplanationJson,
  renderExplanationMarkdown,
  renderStage2Json,
  renderStage2Markdown,
  selectStage2Queries,
  stage2Status,
  summarizeExplanationCondition,
  textsToEmbed,
  type ExplanationGraphShape,
  type ExplanationLabels,
  type ExplanationPair,
  type QuestionConceptSource,
  type RawExplanationCondition,
  type RetrievalDataset,
  type Stage2Answer,
  type Stage2Condition,
  type Stage2QueryInput,
  type Stage2Status,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { gitHead } from '../audit/code-identity.js';
import { CHAT_MODEL, PINNED_CHAT_MODEL } from '../agent/model/model-deps.js';
import { readMemoryConfig } from '../memory/memory.config.js';
import { RunsService } from '../runs/runs.service.js';
import {
  answerFilePath,
  answerKey,
  fileSha256,
  recordAnswers,
  replayAnswers,
  type AnswerFileHeader,
  type AnswerItem,
  type RecordedAnswer,
} from './answer-file.js';
import { MODEL_HOST, watchForModelRequests } from './cassette-deps.js';
import { embeddingFilePath, replayEmbeddings } from './embedding-file.js';
import { stage2Prompts } from './explanation-prompt.js';

const logger = createLogger('eval-explanation');

type AnswersMode = 'replay' | 'record';

/**
 * `EVAL_ANSWERS_MODE`: `replay` (the default) scores whatever the committed
 * answer file holds and calls no model; `record` asks the calls the file
 * lacks, up to the day's budget. An unknown value is refused rather than read
 * as the default, as `EVAL_EMBEDDINGS_MODE` is.
 */
function readAnswersMode(env: NodeJS.ProcessEnv = process.env): AnswersMode {
  const raw = (env['EVAL_ANSWERS_MODE'] ?? '').trim();
  if (raw === '' || raw === 'replay') return 'replay';
  if (raw === 'record') return raw;
  throw new Error(`EVAL_ANSWERS_MODE must be replay or record; got ${JSON.stringify(raw)}`);
}

function positiveInteger(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer of at least ${minimum}; got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

const BOOTSTRAP = { resamples: 10_000, seed: 0x5eed } as const;

/** Stage 2's retrieval: what a request gets, `VectorRetrievalFacade` at the default topK. */
const TOP_K = 10;

/**
 * Stage 2's daily slice. The free tier allows 20 `generateContent` calls a
 * day and the nightly takes about 11 (`.context/conventions.md`, "Live model
 * quota"), so 8 leaves the nightly its share and keeps pairs whole.
 */
const DEFAULT_MAX_CALLS = 8;
/** 13 s between calls keeps a slice under the free tier's 5 a minute without leaning on the client's retry. */
const DEFAULT_PACE_MS = 13_000;

/**
 * Whether `CypherNeo4jExplainer` was changed after the first measured run.
 * P2-D allows one such change, at the construction check and nowhere else,
 * and the report has to say whether it was used. Set by hand, in the commit
 * that changes the explainer, if that ever happens.
 */
const EXPLAINER_CHANGED_AFTER_FIRST_RUN = false;

interface ConditionSpec {
  readonly name: string;
  readonly role: RawExplanationCondition['role'];
  readonly graphShape: ExplanationGraphShape;
  readonly questionConcepts: QuestionConceptSource;
}

/** P2-D's four conditions, construction check first. */
const CONSTRUCTION: ConditionSpec = {
  name: 'explain·per-fact·oracle',
  role: 'construction check',
  graphShape: 'per-fact',
  questionConcepts: 'gold',
};
const CONDITIONS: readonly ConditionSpec[] = [
  { name: 'explain', role: 'decisive', graphShape: 'reflect', questionConcepts: 'linker' },
  { name: 'explain·oracle', role: 'diagnostic', graphShape: 'reflect', questionConcepts: 'gold' },
  {
    name: 'explain·per-fact',
    role: 'diagnostic',
    graphShape: 'per-fact',
    questionConcepts: 'linker',
  },
  CONSTRUCTION,
];

/**
 * `yarn eval:explanation` — stage 1 of P2-D: does the graph explain a
 * retrieved fact?
 *
 * For each (query, pre-registered relevant fact) pair of P2-B's dataset it
 * asks `CypherNeo4jExplainer` for the concept paths from the question to the
 * fact, and scores them against the gold paths committed in
 * `explanation-labels.json` before this file existed. Model-free and
 * embedding-free: the stores are seeded with the graph alone, and the run
 * fails if anything reaches the model host.
 *
 * The graph is seeded through `PgNeo4jSeedManager` from empty, once per
 * shape, under the corpus session, and every read is scoped to it. The
 * construction check runs first, on the per-fact graph with the gold
 * concepts; if it fails, the explainer has a defect, and the report holds
 * that and nothing else.
 *
 * Stage 2 runs only if stage 1 is `good`: `plan`'s answer with and without
 * the paths, on the relational queries the vector path already retrieves.
 * By default it replays the committed answer file and makes no request; with
 * `EVAL_ANSWERS_MODE=record` it asks the calls the file lacks, at most
 * `EVAL_STAGE2_MAX_CALLS` of them, and stops on the first daily-quota 429.
 * `EVAL_ANSWERS_FILE` points it at another file, for a dry run. See
 * `runStage2`.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

  const mode = readAnswersMode();
  const requests = watchForModelRequests(() => undefined);
  const outputDir = resolve(process.env['EVAL_OUTPUT_DIR'] ?? 'eval-results');
  const startedAt = new Date().toISOString();

  const dataset = loadRetrievalDataset();
  const { labels, sha256: labelsSha256 } = loadExplanationLabels(dataset);

  const config = readMemoryConfig();
  if (config === null) {
    throw new Error(
      'the memory axis is unconfigured: set DATABASE_URL and NEO4J_URI. The explanation ' +
        'measurement reads live stores and has no stub path.',
    );
  }

  const pool = await createPgvectorPool({ connectionString: config.databaseUrl });
  const driver = createNeo4jClient({
    uri: config.neo4jUri,
    username: config.neo4jUser,
    password: config.neo4jPassword,
  });

  let constructionPassed = false;
  let stage1Requests = 0;
  try {
    await runMigrations(pool);
    await ensureSemanticConstraints(driver);

    logger.info({
      msg: 'eval.explanation.start',
      axes: { memory: 'live', model: 'none', embeddings: 'none' },
      datasetSha256: dataset.sha256,
      labelsSha256,
      pairs: labels.pairs.length,
    });

    const stores = {
      explainer: new CypherNeo4jExplainer(driver),
      seeds: new PgNeo4jSeedManager(pool, driver),
    };

    const raw = new Map<string, RawExplanationCondition>();

    // The construction check, alone, before any other condition is read.
    await seedGraph(stores.seeds, dataset, CONSTRUCTION.graphShape);
    raw.set(
      CONSTRUCTION.name,
      await runCondition(stores.explainer, dataset, labels.pairs, CONSTRUCTION),
    );
    const check = constructionCheck(
      summarizeExplanationCondition(dataset, raw.get(CONSTRUCTION.name)!, BOOTSTRAP),
    );
    constructionPassed = check.passed;
    logger.info({
      msg: 'eval.explanation.construction',
      ...check,
      failures: check.failures.length,
    });

    if (check.passed) {
      for (const shape of ['per-fact', 'reflect'] as const) {
        const specs = CONDITIONS.filter((c) => c.graphShape === shape && !raw.has(c.name));
        if (specs.length === 0) continue;
        if (shape !== CONSTRUCTION.graphShape) await seedGraph(stores.seeds, dataset, shape);
        for (const spec of specs) {
          raw.set(spec.name, await runCondition(stores.explainer, dataset, labels.pairs, spec));
        }
      }
    }

    const reportInput = {
      dataset,
      labelsSha256,
      pairs: labels.pairs.length,
      // The report lists conditions in the PRD's table order.
      conditions: CONDITIONS.flatMap((c) => (raw.has(c.name) ? [raw.get(c.name)!] : [])),
      startedAt,
      maxHops: MAX_EXPLANATION_HOPS,
      bootstrap: BOOTSTRAP,
      explainerChangedAfterFirstRun: EXPLAINER_CHANGED_AFTER_FIRST_RUN,
      constructionCondition: CONSTRUCTION.name,
      decisiveCondition: 'explain',
    };
    const stage1 = buildExplanationReport({ ...reportInput, finishedAt: startedAt }).stage1;

    // Stage 1 calls no model and no embedder, in either mode.
    stage1Requests = requests().length;

    let stage2: Stage2Status | undefined;
    if (stage1?.outcome === 'good') {
      stage2 = await runStage2({
        mode,
        dataset,
        labels,
        labelsSha256,
        stores: { ...stores, pool },
        outputDir,
        requests,
      });
    } else if (mode === 'record') {
      throw new Error(
        `stage 1 is ${stage1?.outcome ?? 'unscored'}; the rule runs stage 2 only after a good stage 1`,
      );
    }

    const report = buildExplanationReport({
      ...reportInput,
      finishedAt: new Date().toISOString(),
      ...(stage2 === undefined ? {} : { stage2 }),
    });

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, 'explanation-report.json'), renderExplanationJson(report));
    writeFileSync(resolve(outputDir, 'explanation-summary.md'), renderExplanationMarkdown(report));

    logger.info({
      msg: 'eval.explanation.done',
      outputDir,
      construction: report.construction.passed,
      stage1: report.stage1?.outcome ?? null,
      outcome: report.outcome,
    });
  } finally {
    await driver.close();
    await pool.end();
  }

  // Stage 1 calls no model and no embedder, and stage 2 replayed calls none.
  // A request to the model host is a run on an axis the report does not
  // name, and so is not a result. Recording calls `generateContent` and
  // nothing else.
  const reached = requests();
  if (stage1Requests > 0) {
    throw new Error(
      `stage 1 made ${stage1Requests} request(s) to ${MODEL_HOST}: ${reached.join(', ')}`,
    );
  }
  const unexpected =
    mode === 'record' ? reached.filter((target) => !target.includes(':generateContent')) : reached;
  if (unexpected.length > 0) {
    throw new Error(
      `the ${mode} run made ${unexpected.length} unexpected request(s) to ${MODEL_HOST}: ${unexpected.join(', ')}`,
    );
  }
  if (!constructionPassed) {
    throw new Error('the construction check failed: the explainer has a defect');
  }
}

/**
 * Resets the stores to empty and seeds the corpus graph in one shape:
 * concepts, `RELATES_TO` edges, and `:Fact` nodes with `MENTIONS` to every
 * entity of the fact's episode (`reflect`) or only to those it mentions
 * (`per-fact`). No pgvector row is written; stage 1 never reads one.
 */
async function seedGraph(
  seeds: PgNeo4jSeedManager,
  dataset: RetrievalDataset,
  shape: ExplanationGraphShape,
  vectorFor?: (text: string) => number[],
): Promise<void> {
  const sessionId = dataset.sessionId;
  await seeds.restoreToSeed({ sessionId, conceptIds: [], contentHashes: [] });
  await seeds.applySeed({
    sessionId,
    concepts: [...dataset.entities.values()].map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
    })),
    relationships: dataset.episodes.flatMap((episode) =>
      episode.relationships.map((rel) => ({ ...rel, episodeId: episode.episodeId })),
    ),
    // Stage 2 retrieves, so it seeds pgvector too, from the recorded vectors.
    ...(vectorFor === undefined
      ? {}
      : {
          facts: [...dataset.facts.values()].map((fact) => ({
            contentHash: fact.contentHash,
            text: fact.text,
            embedding: vectorFor(fact.text),
            episodeId: fact.episodeId,
            sessionId,
          })),
        }),
    graphFacts: graphFacts(dataset, shape),
  });
  logger.info({
    msg: 'eval.explanation.seeded',
    shape,
    facts: dataset.facts.size,
    vectors: vectorFor !== undefined,
  });
}

/** Reads one condition: for every labelled pair, the paths the explainer returns. */
async function runCondition(
  explainer: CypherNeo4jExplainer,
  dataset: RetrievalDataset,
  pairs: readonly ExplanationPair[],
  spec: ConditionSpec,
): Promise<RawExplanationCondition> {
  const scope = { sessionId: dataset.sessionId };
  const queries = new Map(dataset.queries.map((q) => [q.id, q]));
  const linked = new Map<string, string[]>();

  const results: RawExplanationCondition['pairs'][number][] = [];
  for (const pair of pairs) {
    const query = queries.get(pair.queryId)!;
    let questionConcepts: readonly string[];
    if (spec.questionConcepts === 'gold') {
      questionConcepts = query.goldSeeds;
    } else {
      if (!linked.has(query.id)) {
        linked.set(query.id, await explainer.linkQuestionConcepts(query.text, scope));
      }
      questionConcepts = linked.get(query.id)!;
    }

    const hash = dataset.facts.get(pair.factHandle)!.contentHash;
    const explanations = await explainer.explain(questionConcepts, [hash], scope);
    results.push({ pair, questionConcepts, returned: explanations.get(hash) ?? [] });
  }

  return {
    name: spec.name,
    role: spec.role,
    graphShape: spec.graphShape,
    questionConcepts: spec.questionConcepts,
    pairs: results,
  };
}

interface Stage2Options {
  readonly mode: AnswersMode;
  readonly dataset: RetrievalDataset;
  readonly labels: ExplanationLabels;
  readonly labelsSha256: string;
  readonly stores: {
    readonly explainer: CypherNeo4jExplainer;
    readonly seeds: PgNeo4jSeedManager;
    readonly pool: Awaited<ReturnType<typeof createPgvectorPool>>;
  };
  readonly outputDir: string;
  readonly requests: () => string[];
}

/**
 * Stage 2 of P2-D: `plan`'s answer with and without the paths.
 *
 * The stores are reseeded with the `reflect` shape the decisive condition
 * read, and with pgvector's rows from the recorded embeddings, so retrieval
 * is `VectorRetrievalFacade` at topK 10 over the corpus, as a request gets
 * it, and the paths are the explainer's as it would ship: the label linker
 * over the `reflect` graph. The selection is the relational queries whose
 * answer fact that retrieval places in its top ten, and it must be the 38
 * P2-B's committed run fixed.
 *
 * Every prompt is built before any call, so the answer file can refuse a
 * stale one before anything is spent. In `record` mode the calls the file
 * lacks go through `RunsService.modelDeps().plan.callLlm`, the production
 * client with its retry policy and `stopOnDailyQuota`, on the pinned model.
 * Either way the report is built from the file, so a recording and its
 * replay are scored by the same code from the same bytes.
 *
 * Returns the status the stage-1 report prints, or `undefined` when no
 * answer has been recorded yet, which leaves that report as stage 1 wrote it.
 */
async function runStage2(options: Stage2Options): Promise<Stage2Status | undefined> {
  const { mode, dataset, labels, labelsSha256, stores, outputDir, requests } = options;
  const startedAt = new Date().toISOString();
  const sessionId = dataset.sessionId;
  const scope = { sessionId };

  const vectorFor = recordedVectors(dataset);
  await seedGraph(stores.seeds, dataset, 'reflect', vectorFor);

  const facade = new VectorRetrievalFacade(new PgPgvectorReader(stores.pool));
  const retrieved = new Map<string, RetrievalCandidate[]>();
  for (const query of dataset.queries) {
    if (query.stratum !== 'relational') continue;
    retrieved.set(
      query.id,
      await facade.retrieve({ queryEmbedding: vectorFor(query.text), topK: TOP_K, sessionId }),
    );
  }
  const selected = selectStage2Queries(
    dataset,
    new Map([...retrieved].map(([id, list]) => [id, list.map((c) => c.contentHash ?? '')])),
    TOP_K,
  );
  logger.info({
    msg: 'eval.explanation.stage2.selected',
    count: selected.length,
    queries: selected.map((q) => q.id),
  });
  if (selected.length !== STAGE2_QUERY_COUNT) {
    throw new Error(
      `vector retrieval selected ${selected.length} relational queries, not the ${STAGE2_QUERY_COUNT} ` +
        "P2-B's committed run fixed; the stores or the retrieval are not the ones stage 2 was " +
        'pre-registered against',
    );
  }

  const items: AnswerItem[] = [];
  const explained = new Map<string, { explainedFacts: number; answerFactExplained: boolean }>();
  for (const query of selected) {
    const context = retrieved.get(query.id)!;
    const linked = await stores.explainer.linkQuestionConcepts(query.text, scope);
    const explanations: ReadonlyMap<string, readonly ConceptPath[]> =
      await stores.explainer.explain(
        linked,
        context.flatMap((c) => (c.contentHash === undefined ? [] : [c.contentHash])),
        scope,
      );
    const prompts = stage2Prompts(query.text, context, explanations);
    for (const condition of STAGE2_CONDITIONS) {
      items.push({
        queryId: query.id,
        condition,
        systemPrompt: prompts.system,
        userPrompt: prompts[condition],
      });
    }

    const answerFacts = new Set(query.relevant.map((h) => dataset.facts.get(h)!.contentHash));
    const withPaths = context.filter(
      (c) => c.contentHash !== undefined && (explanations.get(c.contentHash)?.length ?? 0) > 0,
    );
    explained.set(query.id, {
      explainedFacts: withPaths.length,
      answerFactExplained: withPaths.some((c) => answerFacts.has(c.contentHash!)),
    });
  }

  const header: AnswerFileHeader = {
    formatVersion: 1,
    decisionFormatVersion: CASSETTE_FORMAT_VERSION,
    chatModel: CHAT_MODEL,
    datasetSha256: dataset.sha256,
    labelsSha256,
    queries: selected.map((q) => q.id),
  };
  // The committed file, unless a dry run points elsewhere: a fake model's
  // answers must never land where the real ones are committed.
  const override = process.env['EVAL_ANSWERS_FILE'];
  const path =
    override === undefined || override.trim() === ''
      ? answerFilePath(RETRIEVAL_ABLATION_DATASET_DIR)
      : resolve(override);

  let recordedNow = 0;
  if (mode === 'record') {
    recordedNow = await record(path, header, items);
  }

  const answers: ReadonlyMap<string, RecordedAnswer> = existsSync(path)
    ? replayAnswers(JSON.parse(readFileSync(path, 'utf8')), header, items)
    : new Map();

  const queries: Stage2QueryInput[] = selected.map((query) => {
    const pair = labels.pairs.find((p) => p.queryId === query.id)!;
    const recorded: Partial<Record<Stage2Condition, Stage2Answer>> = {};
    for (const condition of STAGE2_CONDITIONS) {
      const answer = answers.get(answerKey(query.id, condition));
      if (answer !== undefined) {
        recorded[condition] = {
          content: answer.content,
          recordedAt: answer.recordedAt,
          invocation: answer.invocation,
        };
      }
    }
    return {
      queryId: query.id,
      answerKey: labels.answerKeys[query.id]!,
      bridgeLabels: bridgeConcepts(pair).map((id) => dataset.entities.get(id)!.label),
      ...explained.get(query.id)!,
      answers: recorded,
    };
  });

  const report = buildStage2Report({
    startedAt,
    finishedAt: new Date().toISOString(),
    model: recordedNow > 0 ? 'live' : 'replay',
    datasetSha256: dataset.sha256,
    labelsSha256,
    answerFile: relative(RETRIEVAL_ABLATION_DATASET_DIR, path),
    answerFileSha256: fileSha256(path),
    chatModel: CHAT_MODEL,
    requestsThisRun: requests().filter((target) => target.includes(':generateContent')).length,
    topK: TOP_K,
    bootstrap: BOOTSTRAP,
    queries,
  });

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'stage2-report.json'), renderStage2Json(report));
  writeFileSync(resolve(outputDir, 'stage2-summary.md'), renderStage2Markdown(report));
  logger.info({
    msg: 'eval.explanation.stage2.done',
    recorded: report.answers.recorded,
    expected: report.answers.expected,
    outcome: report.outcome,
  });

  return report.answers.recorded === 0 ? undefined : stage2Status(report);
}

/**
 * Asks the calls the answer file lacks, up to the day's budget, and says
 * what it spent. Returns how many answers it wrote.
 */
async function record(
  path: string,
  header: AnswerFileHeader,
  items: readonly AnswerItem[],
): Promise<number> {
  if (!process.env['GOOGLE_API_KEY']) {
    throw new Error('EVAL_ANSWERS_MODE=record needs GOOGLE_API_KEY');
  }
  if (CHAT_MODEL !== PINNED_CHAT_MODEL) {
    throw new Error(
      `stage 2 is pre-registered on ${PINNED_CHAT_MODEL}; EVAL_CHAT_MODEL selects ${CHAT_MODEL}`,
    );
  }
  const head = gitHead();
  if (head.dirty) logger.warn({ msg: 'eval.explanation.stage2.dirty-tree', gitSha: head.sha });

  const outcome = await recordAnswers({
    path,
    header,
    items,
    callLlm: new RunsService(null, null, null, null, null, null).modelDeps().plan.callLlm,
    maxCalls: positiveInteger('EVAL_STAGE2_MAX_CALLS', DEFAULT_MAX_CALLS, 1),
    paceMs: positiveInteger('EVAL_STAGE2_PACE_MS', DEFAULT_PACE_MS, 0),
    gitSha: head.sha,
    onAnswer: (key, done, total) =>
      logger.info({ msg: 'eval.explanation.stage2.answer', key, done, total }),
  });
  logger.info({ msg: 'eval.explanation.stage2.recording', path, ...outcome });

  if (outcome.stoppedBy === 'daily-quota' || outcome.stoppedBy === 'rate-limit') {
    // The day's pool was smaller than the slice planned for it. What was
    // recorded is kept; the next invocation resumes from here.
    logger.warn({
      msg: 'eval.explanation.stage2.rate-limited',
      stoppedBy: outcome.stoppedBy,
      detail: outcome.detail,
      remaining: outcome.remaining,
    });
    process.exitCode = 1;
  }
  return outcome.recorded;
}

/** The committed query and fact vectors, or a refusal: stage 2 never calls the embedder. */
function recordedVectors(dataset: RetrievalDataset): (text: string) => number[] {
  const path = embeddingFilePath(RETRIEVAL_ABLATION_DATASET_DIR);
  if (!existsSync(path)) throw new Error(`no embedding file at ${path}`);
  return replayEmbeddings(
    JSON.parse(readFileSync(path, 'utf8')),
    {
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      datasetSha256: dataset.sha256,
    },
    textsToEmbed(dataset),
  ).embed;
}

main().catch((error: unknown) => {
  logger.error({
    msg: 'eval.explanation.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
