import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CypherNeo4jReader,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  PgNeo4jSeedManager,
  PgPgvectorReader,
  createNeo4jClient,
  createPgvectorPool,
  ensureSemanticConstraints,
  runMigrations,
  type RetrievalCandidate,
} from '@repo/memory-core';
import {
  RETRIEVAL_ABLATION_DATASET_DIR,
  adjudicatedLabels,
  adjudicationPaths,
  buildAblationReport,
  buildPool,
  graphFacts,
  loadRetrievalDataset,
  renderAblationJson,
  renderAblationMarkdown,
  renderPoolFiles,
  rrfMerge,
  textsToEmbed,
  type AdjudicationSummary,
  type GraphShape,
  type Labels,
  type RawCondition,
  type RawQueryResult,
  type RetrievalDataset,
  type SeedSource,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { createGeminiEmbedder } from '../agent/model/gemini-embedder.js';
import { readMemoryConfig } from '../memory/memory.config.js';
import { MODEL_HOST, gitHead, watchForModelRequests } from './cassette-deps.js';
import {
  embeddingFilePath,
  readEmbeddingsMode,
  recordEmbeddings,
  replayEmbeddings,
  type EmbeddingExpectation,
} from './embedding-file.js';
import { extractSeedEntityIds } from './seed-linker.js';

const logger = createLogger('eval-retrieval');

/** The defaults a request got when the ablation ran, before ADR 0009. */
const TOP_K = 10;
const HOP_DEPTH = 2;
const HOP_DEPTHS = [1, 2, 3] as const;
const BOOTSTRAP = { resamples: 10_000, seed: 0x5eed } as const;

/**
 * `yarn eval:retrieval` — the graph/vector/hybrid ablation P2-B specifies.
 *
 * A retrieval-level benchmark: query text in, a ranked list of content hashes
 * out, scored against pre-registered labels. No chat model is in the loop, and
 * on the default axis no request leaves the process — the query and fact
 * vectors come from the committed embedding file, and the runner fails if
 * anything reaches the model host anyway.
 *
 * Every condition is built from the classes the service constructed when the
 * ablation ran — `PgPgvectorReader`, `CypherNeo4jReader`, the seed linker and
 * the fused path (`fusedRetrieve`) — over stores reset and seeded through
 * `PgNeo4jSeedManager`, so the only thing that differed from a request was
 * where the query vector came from.
 *
 * It measures the design ADR 0009 retired. Retrieval is vector-only since
 * then: `vector` is still what a request gets, and the `graph` and `hybrid`
 * conditions are a historical measurement, kept runnable so the result that
 * decided ADR 0002 can be reproduced from the committed dataset.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

  const mode = readEmbeddingsMode();
  const dataset = loadRetrievalDataset();
  const texts = textsToEmbed(dataset);
  const expected: EmbeddingExpectation = {
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    datasetSha256: dataset.sha256,
  };
  const requests = watchForModelRequests(() => undefined);

  if (mode === 'record') {
    await record(dataset, texts, expected, requests);
    return;
  }

  const outputDir = resolve(process.env['EVAL_OUTPUT_DIR'] ?? 'eval-results');
  const startedAt = new Date().toISOString();

  const { vectorFor, embeddings } = await embeddingsFor(mode, texts, expected);

  const config = readMemoryConfig();
  if (config === null) {
    throw new Error(
      'the memory axis is unconfigured: set DATABASE_URL and NEO4J_URI. The ablation reads ' +
        'live stores and has no stub path.',
    );
  }

  const pool = await createPgvectorPool({ connectionString: config.databaseUrl });
  const driver = createNeo4jClient({
    uri: config.neo4jUri,
    username: config.neo4jUser,
    password: config.neo4jPassword,
  });

  try {
    await runMigrations(pool);
    await ensureSemanticConstraints(driver);

    logger.info({
      msg: 'eval.retrieval.start',
      axes: { memory: 'live', embeddings: mode === 'live' ? 'live' : 'recorded' },
      datasetSha256: dataset.sha256,
      queries: dataset.queries.length,
      facts: dataset.facts.size,
    });

    const run = await runConditions(dataset, vectorFor, {
      pgReader: new PgPgvectorReader(pool),
      neo4jReader: new CypherNeo4jReader(driver),
      seeds: new PgNeo4jSeedManager(pool, driver),
    });

    const labelSets: { name: 'pre-registered' | 'adjudicated'; labels: Labels }[] = [
      { name: 'pre-registered', labels: preRegisteredLabels(dataset) },
    ];
    let adjudication: AdjudicationSummary | null = null;
    const paths = adjudicationPaths(RETRIEVAL_ABLATION_DATASET_DIR);
    if (existsSync(paths.decisions)) {
      const adjudicated = adjudicatedLabels(
        dataset,
        JSON.parse(readFileSync(paths.key, 'utf8')),
        JSON.parse(readFileSync(paths.decisions, 'utf8')),
      );
      labelSets.push({ name: 'adjudicated', labels: adjudicated.labels });
      adjudication = {
        adjudicator: adjudicated.adjudicator.name,
        adjudicatorKind: adjudicated.adjudicator.kind,
        candidates: adjudicated.candidates,
        judgedRelevant: adjudicated.judgedRelevant,
      };
    }

    const report = buildAblationReport({
      dataset,
      conditions: run.conditions,
      labelSets,
      startedAt,
      finishedAt: new Date().toISOString(),
      axes: { memory: 'live', embeddings: mode === 'live' ? 'live' : 'recorded' },
      embeddings,
      vectorPlan: run.vectorPlan,
      linkerIds: run.linkerIds,
      goldSeeds: new Map(dataset.queries.map((q) => [q.id, q.goldSeeds])),
      topK: TOP_K,
      hopDepth: HOP_DEPTH,
      hopDepths: [...HOP_DEPTHS],
      bootstrap: BOOTSTRAP,
      adjudication,
      // P2-B applies the rule to the pre-registered labels, and only once the
      // adjudicated set exists to be reported beside them.
      applyRule: adjudication !== null,
    });

    const poolFiles = renderPoolFiles(dataset.sha256, buildPool(dataset, run.conditions, TOP_K));

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, 'ablation-report.json'), renderAblationJson(report));
    writeFileSync(resolve(outputDir, 'ablation-summary.md'), renderAblationMarkdown(report));
    writeFileSync(resolve(outputDir, 'pool-candidates.json'), poolFiles.candidates);
    writeFileSync(resolve(outputDir, 'pool-key.json'), poolFiles.key);

    const primary = report.labelSets[0]!.conditions.filter((c) => c.table === 'primary');
    logger.info({
      msg: 'eval.retrieval.done',
      outputDir,
      recallAt10: Object.fromEntries(primary.map((c) => [c.name, c.overall.recall[10]])),
      adjudicated: adjudication !== null,
    });
  } finally {
    await driver.close();
    await pool.end();
  }

  // On the recorded axis nothing has business reaching the model host. A run
  // that did is not a cheap run that worked; it is a run on a different axis
  // than the one its report names.
  const reached = requests();
  if (mode === 'replay' && reached.length > 0) {
    throw new Error(
      `the recorded axis made ${reached.length} request(s) to ${MODEL_HOST}: ${reached.join(', ')}`,
    );
  }
}

/** Embeds what the file lacks, through the production embedder, and says what it spent. */
async function record(
  dataset: RetrievalDataset,
  texts: readonly string[],
  expected: EmbeddingExpectation,
  requests: () => string[],
): Promise<void> {
  const apiKey = process.env['GOOGLE_API_KEY'];
  if (!apiKey) throw new Error('EVAL_EMBEDDINGS_MODE=record needs GOOGLE_API_KEY');

  const head = gitHead();
  if (head.dirty) {
    logger.warn({ msg: 'eval.retrieval.record.dirty-tree', gitSha: head.sha });
  }

  const path = embeddingFilePath(RETRIEVAL_ABLATION_DATASET_DIR);
  const outcome = await recordEmbeddings({
    path,
    texts,
    embed: createGeminiEmbedder(apiKey),
    expected,
    gitSha: head.sha,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total)
        logger.info({ msg: 'eval.retrieval.record.progress', done, total });
    },
  });

  const sent = requests();
  const embedCalls = sent.filter((target) => target.includes(':embedContent')).length;
  const otherCalls = sent.length - embedCalls;

  logger.info({
    msg: 'eval.retrieval.record.done',
    path,
    datasetSha256: dataset.sha256,
    ...outcome,
    requests: { embedContent: embedCalls, other: otherCalls },
  });

  if (otherCalls > 0) {
    throw new Error(
      `recording made ${otherCalls} request(s) other than embedContent: ${sent.join(', ')}`,
    );
  }
  if (outcome.rateLimited) {
    logger.warn({
      msg: 'eval.retrieval.record.rate-limited',
      remaining: outcome.remaining,
      detail: 'stopped on the first 429; run again to resume from here',
    });
    process.exitCode = 1;
  }
}

async function embeddingsFor(
  mode: 'replay' | 'live',
  texts: readonly string[],
  expected: EmbeddingExpectation,
): Promise<{
  vectorFor: (text: string) => number[];
  embeddings: {
    model: string;
    dimensions: number;
    recordedAt: string | null;
    gitSha: string | null;
  };
}> {
  if (mode === 'replay') {
    const path = embeddingFilePath(RETRIEVAL_ABLATION_DATASET_DIR);
    if (!existsSync(path)) {
      throw new Error(`no embedding file at ${path}; record one with EVAL_EMBEDDINGS_MODE=record`);
    }
    const { header, embed } = replayEmbeddings(
      JSON.parse(readFileSync(path, 'utf8')),
      expected,
      texts,
    );
    return {
      vectorFor: embed,
      embeddings: {
        model: header.embeddingModel,
        dimensions: header.embeddingDimensions,
        recordedAt: header.recordedAt,
        gitSha: header.gitSha,
      },
    };
  }

  const apiKey = process.env['GOOGLE_API_KEY'];
  if (!apiKey) throw new Error('EVAL_EMBEDDINGS_MODE=live needs GOOGLE_API_KEY');
  const embed = createGeminiEmbedder(apiKey);
  const vectors = new Map<string, number[]>();
  for (const text of new Set(texts)) vectors.set(text, await embed(text));
  return {
    vectorFor: (text) => vectors.get(text)!,
    embeddings: {
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      recordedAt: null,
      gitSha: null,
    },
  };
}

function preRegisteredLabels(dataset: RetrievalDataset): Labels {
  return new Map(
    dataset.queries.map((q) => [
      q.id,
      new Set(q.relevant.map((h) => dataset.facts.get(h)!.contentHash)),
    ]),
  );
}

interface Stores {
  readonly pgReader: PgPgvectorReader;
  readonly neo4jReader: CypherNeo4jReader;
  readonly seeds: PgNeo4jSeedManager;
}

/**
 * `HybridRetrievalFacade.retrieve` as the service ran it until ADR 0009: both
 * readers in parallel, pgvector over-fetched at `2 × topK`, fused by
 * `rrfMerge` and cut to `topK`. The facade left `memory-core` when retrieval
 * became vector-only; it is reproduced here, its one remaining caller, so the
 * `hybrid` conditions and their latencies measure what was deployed.
 */
async function fusedRetrieve(
  stores: Pick<Stores, 'pgReader' | 'neo4jReader'>,
  query: {
    queryEmbedding: number[];
    seedEntityIds: string[];
    topK: number;
    hopDepth: number;
    sessionId: string;
  },
): Promise<RetrievalCandidate[]> {
  const [vector, graph] = await Promise.all([
    stores.pgReader.searchByCosine(query.queryEmbedding, query.topK * 2, {
      sessionId: query.sessionId,
    }),
    stores.neo4jReader.expandFromSeeds(query.seedEntityIds, query.hopDepth),
  ]);
  return rrfMerge([vector, graph], query.topK);
}

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await f();
  return [value, performance.now() - start];
}

/**
 * Condition names, as the PRD's table spells them. The primary three are the
 * deployed path: linker seeds, the `reflect`-shaped graph, the default hop depth.
 */
function conditionName(
  kind: 'graph' | 'hybrid',
  seeds: SeedSource,
  shape: GraphShape,
  hop: number,
): string {
  const base = `${kind}${seeds === 'gold' ? '·oracle' : ''}${shape === 'per-fact' ? '·per-fact' : ''}`;
  return hop === HOP_DEPTH ? base : `${base}@hop${hop}`;
}

/**
 * Resets and seeds the stores once per graph shape, then reads every
 * condition over them.
 *
 * The reset is `restoreToSeed` with nothing kept: the Neo4j half is
 * database-wide and the pgvector half is this session, so a run starts from
 * the same contents whatever the stores held before. Both shapes share the
 * pgvector rows; only the `MENTIONS` edges differ.
 */
async function runConditions(
  dataset: RetrievalDataset,
  vectorFor: (text: string) => number[],
  stores: Stores,
): Promise<{ conditions: RawCondition[]; vectorPlan: string[]; linkerIds: Map<string, string[]> }> {
  const { pgReader, neo4jReader, seeds } = stores;
  const sessionId = dataset.sessionId;

  const linkerIds = new Map(
    dataset.queries.map((q) => [q.id, extractSeedEntityIds([{ role: 'user', content: q.text }])]),
  );
  const goldSeeds = new Map(dataset.queries.map((q) => [q.id, [...q.goldSeeds]]));

  const seedApplication = (shape: GraphShape) => ({
    concepts: [...dataset.entities.values()].map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
    })),
    relationships: dataset.episodes.flatMap((episode) =>
      episode.relationships.map((rel) => ({ ...rel, episodeId: episode.episodeId })),
    ),
    facts: [...dataset.facts.values()].map((fact) => ({
      contentHash: fact.contentHash,
      text: fact.text,
      embedding: vectorFor(fact.text),
      episodeId: fact.episodeId,
      sessionId,
    })),
    graphFacts: graphFacts(dataset, shape),
  });

  const conditions: RawCondition[] = [];
  let vectorPlan: string[] = [];

  for (const shape of ['reflect', 'per-fact'] as const) {
    await seeds.restoreToSeed({ sessionId, conceptIds: [], contentHashes: [] });
    await seeds.applySeed(seedApplication(shape));
    logger.info({ msg: 'eval.retrieval.seeded', shape, facts: dataset.facts.size });

    if (shape === 'reflect') {
      const results: RawQueryResult[] = [];
      for (const query of dataset.queries) {
        const [ranked, latencyMs] = await timed(() =>
          pgReader.searchByCosine(vectorFor(query.text), TOP_K, { sessionId }),
        );
        results.push({ queryId: query.id, ranked, latencyMs });
      }
      conditions.push({
        name: 'vector',
        table: 'primary',
        kind: 'vector',
        seeds: 'none',
        graphShape: null,
        hopDepth: null,
        results,
      });
      vectorPlan = await pgReader.explainSearchByCosine(
        vectorFor(dataset.queries[0]!.text),
        TOP_K,
        {
          sessionId,
        },
      );
    }

    const seedSets: [SeedSource, Map<string, string[]>][] =
      shape === 'reflect'
        ? [
            ['linker', linkerIds],
            ['gold', goldSeeds],
          ]
        : [['gold', goldSeeds]];

    for (const [source, seedMap] of seedSets) {
      for (const hop of HOP_DEPTHS) {
        const graphResults: RawQueryResult[] = [];
        const hybridResults: RawQueryResult[] = [];

        for (const query of dataset.queries) {
          const queryEmbedding = vectorFor(query.text);
          const seedEntityIds = seedMap.get(query.id) ?? [];

          // The two lists `fusedRetrieve` fuses, read on their own so provenance
          // never depends on `source`, which rrfMerge keeps from whichever
          // list saw a fact first.
          const vector: RetrievalCandidate[] = await pgReader.searchByCosine(
            queryEmbedding,
            TOP_K * 2,
            {
              sessionId,
            },
          );
          const [graph, graphMs] = await timed(() =>
            neo4jReader.expandFromSeeds(seedEntityIds, hop),
          );
          const [hybrid, hybridMs] = await timed(() =>
            fusedRetrieve(stores, {
              queryEmbedding,
              seedEntityIds,
              topK: TOP_K,
              hopDepth: hop,
              sessionId,
            }),
          );

          graphResults.push({
            queryId: query.id,
            ranked: graph,
            latencyMs: graphMs,
            fusionInputs: { vector, graph },
          });
          hybridResults.push({
            queryId: query.id,
            ranked: hybrid,
            latencyMs: hybridMs,
            fusionInputs: { vector, graph },
          });
        }

        const primary = source === 'linker' && shape === 'reflect' && hop === HOP_DEPTH;
        for (const [kind, results] of [
          ['graph', graphResults],
          ['hybrid', hybridResults],
        ] as const) {
          conditions.push({
            name: conditionName(kind, source, shape, hop),
            table: primary ? 'primary' : 'diagnostic',
            kind,
            seeds: source,
            graphShape: shape,
            hopDepth: hop,
            results,
          });
        }
      }
    }
  }

  // Primary first, then diagnostics, each in a fixed order, so two runs write
  // the same report.
  conditions.sort((a, b) => (a.table === b.table ? 0 : a.table === 'primary' ? -1 : 1));
  return { conditions, vectorPlan, linkerIds };
}

main().catch((error: unknown) => {
  logger.error({
    msg: 'eval.retrieval.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
