import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CypherNeo4jExplainer,
  MAX_EXPLANATION_HOPS,
  PgNeo4jSeedManager,
  createNeo4jClient,
  createPgvectorPool,
  ensureSemanticConstraints,
  runMigrations,
} from '@repo/memory-core';
import {
  buildExplanationReport,
  constructionCheck,
  graphFacts,
  loadExplanationLabels,
  loadRetrievalDataset,
  renderExplanationJson,
  renderExplanationMarkdown,
  summarizeExplanationCondition,
  type ExplanationGraphShape,
  type ExplanationPair,
  type QuestionConceptSource,
  type RawExplanationCondition,
  type RetrievalDataset,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { readMemoryConfig } from '../memory/memory.config.js';
import { MODEL_HOST, watchForModelRequests } from './cassette-deps.js';

const logger = createLogger('eval-explanation');

const BOOTSTRAP = { resamples: 10_000, seed: 0x5eed } as const;

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
 * Stage 2, the answer-level comparison, is not here. It runs only if stage 1
 * is `good`, and the report says whether it is.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

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

    const report = buildExplanationReport({
      dataset,
      labelsSha256,
      pairs: labels.pairs.length,
      // The report lists conditions in the PRD's table order.
      conditions: CONDITIONS.flatMap((c) => (raw.has(c.name) ? [raw.get(c.name)!] : [])),
      startedAt,
      finishedAt: new Date().toISOString(),
      maxHops: MAX_EXPLANATION_HOPS,
      bootstrap: BOOTSTRAP,
      explainerChangedAfterFirstRun: EXPLAINER_CHANGED_AFTER_FIRST_RUN,
      constructionCondition: CONSTRUCTION.name,
      decisiveCondition: 'explain',
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

  // Stage 1 calls no model and no embedder. A request to the model host is a
  // run on an axis the report does not name, and so is not a result.
  const reached = requests();
  if (reached.length > 0) {
    throw new Error(
      `stage 1 made ${reached.length} request(s) to ${MODEL_HOST}: ${reached.join(', ')}`,
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
): Promise<void> {
  await seeds.restoreToSeed({ sessionId: dataset.sessionId, conceptIds: [], contentHashes: [] });
  await seeds.applySeed({
    sessionId: dataset.sessionId,
    concepts: [...dataset.entities.values()].map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
    })),
    relationships: dataset.episodes.flatMap((episode) =>
      episode.relationships.map((rel) => ({ ...rel, episodeId: episode.episodeId })),
    ),
    graphFacts: graphFacts(dataset, shape),
  });
  logger.info({ msg: 'eval.explanation.seeded', shape, facts: dataset.facts.size });
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

main().catch((error: unknown) => {
  logger.error({
    msg: 'eval.explanation.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
