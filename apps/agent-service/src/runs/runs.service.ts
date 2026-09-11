import { randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { RunResponse, StreamEvent } from '@repo/agent-contracts';
import { createLogger } from '@repo/telemetry';
import {
  EMBEDDING_DIMENSIONS,
  type EpisodicRepository,
  type Neo4jWriter,
  type PgvectorWriter,
  type RetrievalFacade,
} from '@repo/memory-core';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { buildAgentGraph, type GraphDeps } from '../agent/graph/graph.js';
import { buildRunResponse } from '../agent/nodes/egress.node.js';
import type { AgentState } from '../agent/graph/state.js';
import { createGeminiEmbedder } from '../agent/model/gemini-embedder.js';
import { EXTRACTION_PROMPT, parseExtraction } from '../agent/model/extraction.js';
import {
  EPISODIC_REPOSITORY,
  NEO4J_WRITER,
  PGVECTOR_WRITER,
  RETRIEVAL_FACADE,
  CHECKPOINTER,
} from '../memory/memory.tokens.js';
import type { ActNodeDeps } from '../agent/nodes/act.node.js';
import type { DistillNodeDeps } from '../agent/nodes/distill.node.js';
import type { PlanNodeDeps } from '../agent/nodes/plan.node.js';

const logger = createLogger('runs-service');

/**
 * One run plus the trajectory `RunResponse` does not carry.
 *
 * The contract deliberately returns the conversation and the retrieved context
 * and nothing about the path taken to produce them, which is right for a client
 * and useless for an evaluation: `packages/eval-harness` scores the node
 * sequence and the tool calls, and neither is reachable from the response or
 * from the SSE frames, which carry a node name and no state.
 *
 * `extraction` is here for the same reason. `reflect` writes what `distill`
 * produced, so the only way to ask "were the concepts this run extracted
 * actually MERGEd" is to know what it extracted — a count of `:Concept` nodes
 * cannot attribute one to a run, because `mergeEntity` records no episode on it.
 */
export interface TracedRun {
  readonly response: RunResponse;
  readonly nodeSequence: string[];
  readonly toolOutputs: AgentState['toolOutputs'];
  readonly extraction: AgentState['extraction'];
}

/**
 * The chat model, named once.
 *
 * A cassette header records it and the player refuses a set recorded against a
 * different one, so the string has to be readable from outside this class —
 * a second spelling of it in the eval wiring would make that check pass while
 * being wrong.
 */
export const CHAT_MODEL = 'gemini-2.5-flash';

/** The model half of a dependency set: everything that costs a model call. */
export interface ModelDeps {
  plan: PlanNodeDeps;
  act: ActNodeDeps;
  distill: DistillNodeDeps;
  embed: (text: string) => Promise<number[]>;
}

/**
 * The tool registry, which is the one thing in `ModelDeps` that costs no model
 * call.
 *
 * It is built here rather than twice inside the two axis branches because a
 * replayed dependency set needs the same registry the recorded run had: the
 * `act.selectTool` request carries the tool names, so a replay whose tool list
 * differs from the recording's misses on the hash before it gets anywhere near
 * a tool.
 *
 * The one registered tool is a pure function. A registry that holds tools which
 * change the world needs reversibility tiers before a cassette of one is safe,
 * and that is P4-C's.
 */
export function defaultTools(): ActNodeDeps['tools'] {
  return [
    {
      name: 'web-search',
      execute: async (input) => ({ results: [`Result for: ${JSON.stringify(input)}`] }),
    },
  ];
}

/**
 * A `ModelDeps` that constructs its real one on first use.
 *
 * It exists so that `getDeps` can hand a decorator the dependency set it is
 * decorating without having built it. The replay decorator ignores its
 * argument and returns a set built entirely from the cassette, so nothing here
 * is ever called on that path — and "replay constructs no Gemini client" stays
 * structural even when a key happens to be present in the environment, rather
 * than being a consequence of the key being absent.
 */
function lazyModelDeps(create: () => ModelDeps): ModelDeps {
  let built: ModelDeps | undefined;
  const deps = (): ModelDeps => (built ??= create());

  return {
    plan: { callLlm: (system, user) => deps().plan.callLlm(system, user) },
    act: {
      get tools() {
        return deps().act.tools;
      },
      selectTool: (plan, tools) => deps().act.selectTool(plan, tools),
    },
    distill: { extractEntities: (context) => deps().distill.extractEntities(context) },
    embed: (text) => deps().embed(text),
  };
}

@Injectable()
export class RunsService {
  private graphDeps: GraphDeps | undefined;
  private decorateModel: ((deps: ModelDeps) => ModelDeps) | undefined;

  // Tokens are explicit: these are interfaces with no runtime value to infer,
  // and the dev path runs through tsx, where esbuild emits no decorator
  // metadata and an implicit parameter arrives as `undefined`.
  constructor(
    @Inject(EPISODIC_REPOSITORY) private readonly episodicRepo: EpisodicRepository | null,
    @Inject(NEO4J_WRITER) private readonly neo4jWriter: Neo4jWriter | null,
    @Inject(PGVECTOR_WRITER) private readonly pgvectorWriter: PgvectorWriter | null,
    @Inject(RETRIEVAL_FACADE) private readonly retrievalFacade: RetrievalFacade | null,
    @Inject(CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver | null,
  ) {}

  setDeps(deps: GraphDeps): void {
    this.graphDeps = deps;
  }

  /**
   * Wraps the model half of the dependency set. The service does not learn what
   * a cassette is.
   *
   * It sits alongside `setDeps` and does not overlap with it: `setDeps`
   * replaces the whole set and is what the service spec uses, while this
   * decorates one half of a set the service still assembles — so the memory
   * half, the checkpointer and the retrieval facade stay exactly as a request
   * would have them. An evaluation that composed its own memory would measure a
   * system nobody deploys.
   */
  setModelDecorator(decorate: (deps: ModelDeps) => ModelDeps): void {
    this.decorateModel = decorate;
  }

  /**
   * Model availability and database availability are independent axes.
   *
   * This used to switch the whole dependency set on `GOOGLE_API_KEY`, so a
   * developer with Postgres but no API key got stub memory. `GOOGLE_API_KEY`
   * now selects the model half; `DATABASE_URL` + `NEO4J_URI`, resolved in
   * `MemoryModule`, select the memory half.
   */
  private getDeps(): GraphDeps {
    if (this.graphDeps) return this.graphDeps;

    const apiKey = process.env['GOOGLE_API_KEY'];
    const axis = (): ModelDeps =>
      apiKey ? this.createGeminiModelDeps(apiKey) : this.createStubModelDeps();

    // Between the axis switch and the assembly below, so the decorator reaches
    // the model half and nothing else. Undecorated, the axis is built here and
    // the path is the one a request takes; decorated, it is built lazily and a
    // decorator that ignores its argument — which is what replay does — never
    // causes a model client to exist at all.
    const model =
      this.decorateModel === undefined ? axis() : this.decorateModel(lazyModelDeps(axis));

    return {
      ...model,
      retrieve: {
        retrievalFacade: this.retrievalFacade ?? stubRetrievalFacade,
        embedQuery: model.embed,
      },
      reflect: {
        episodicRepo: this.episodicRepo ?? stubEpisodicRepository,
        neo4jWriter: this.neo4jWriter ?? stubNeo4jWriter,
        pgvectorWriter: this.pgvectorWriter ?? stubPgvectorWriter,
        embedText: model.embed,
      },
    };
  }

  private createGeminiModelDeps(apiKey: string): ModelDeps {
    // Two instances of the same model. `json: true` sets Gemini's
    // `responseMimeType: application/json`, which is what stops it wrapping a
    // JSON answer in a ```json fence. `plan` wants prose and must not have it;
    // the two callers that parse a response must.
    const prose = new ChatGoogleGenerativeAI({ model: CHAT_MODEL, apiKey });
    const json = new ChatGoogleGenerativeAI({ model: CHAT_MODEL, apiKey, json: true });

    const callWith =
      (llm: ChatGoogleGenerativeAI) => async (systemPrompt: string, userPrompt: string) => {
        const response = await llm.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt),
        ]);
        const meta = response.usage_metadata;
        return {
          content: typeof response.content === 'string' ? response.content : '',
          tokenCounts: {
            prompt: meta?.input_tokens ?? 0,
            completion: meta?.output_tokens ?? 0,
          },
        };
      };

    const callLlm = callWith(prose);
    const callJson = callWith(json);

    return {
      plan: { callLlm },
      act: {
        tools: defaultTools(),
        selectTool: async (plan, tools) => {
          const toolNames = tools.map((t) => t.name).join(', ');
          const response = await callJson(
            'You select the best tool for a task. Respond with JSON: {"toolName": "...", "input": ...} or null if no tool is needed.',
            `Plan: ${plan}\nAvailable tools: ${toolNames}`,
          );
          try {
            return JSON.parse(response.content);
          } catch {
            return null;
          }
        },
      },
      distill: {
        extractEntities: async (context: string) => {
          const response = await callJson(EXTRACTION_PROMPT, context);
          return parseExtraction(response.content);
        },
      },
      embed: createGeminiEmbedder(apiKey),
    };
  }

  private createStubModelDeps(): ModelDeps {
    const stubEmbedding = () =>
      Promise.resolve(new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => Math.sin(i * 0.01)));

    return {
      plan: {
        callLlm: async () => ({
          content:
            'I will research this topic and provide a comprehensive answer based on the available context.',
          tokenCounts: { prompt: 150, completion: 45 },
        }),
      },
      act: {
        tools: defaultTools(),
        selectTool: async () => null, // Stub: no tool needed
      },
      distill: {
        extractEntities: async () => ({
          entities: [
            { id: 'langgraph', label: 'LangGraph', description: 'Framework for stateful agents' },
          ],
          relationships: [],
          facts: [{ text: 'LangGraph is used for building stateful agent workflows.' }],
        }),
      },
      embed: stubEmbedding,
    };
  }

  async execute(params: { body: unknown; correlationId: string }): Promise<RunResponse> {
    // The runId is minted here rather than in `ingress` because it is the
    // checkpointer's thread_id, and that has to exist before the invoke.
    const runId = randomUUID();
    const compiled = buildAgentGraph(
      this.getDeps(),
      params.body,
      params.correlationId,
      this.checkpointer ?? undefined,
    );

    logger.info({ msg: 'run.start', correlationId: params.correlationId, runId });

    const result = await compiled.invoke({ runId }, { configurable: { thread_id: runId } });

    return buildRunResponse(result as unknown as AgentState);
  }

  /**
   * `execute`, with the trajectory recorded.
   *
   * It streams rather than invokes because the node sequence is only observable
   * as the updates arrive. Every channel in `AgentStateAnnotation` is a
   * last-value-wins `Annotation`, so folding the updates in order reconstructs
   * exactly the state `invoke` would have returned.
   *
   * Called by the evaluation harness, not by the HTTP surface. It runs the same
   * dependency set `execute` does — the same model axis, the same memory axis,
   * the same checkpointer — because an evaluation that composes its own
   * dependencies measures a system nobody deploys.
   */
  async executeTraced(params: { body: unknown; correlationId: string }): Promise<TracedRun> {
    const runId = randomUUID();
    const compiled = buildAgentGraph(
      this.getDeps(),
      params.body,
      params.correlationId,
      this.checkpointer ?? undefined,
    );

    logger.info({ msg: 'run.traced.start', correlationId: params.correlationId, runId });

    const nodeSequence: string[] = [];
    const state: Record<string, unknown> = { runId };

    const stream = await compiled.stream({ runId }, { configurable: { thread_id: runId } });
    for await (const chunk of stream) {
      for (const [nodeName, update] of Object.entries(chunk)) {
        nodeSequence.push(nodeName);
        Object.assign(state, update);
      }
    }

    const finalState = state as unknown as AgentState;

    return {
      response: buildRunResponse(finalState),
      nodeSequence,
      toolOutputs: finalState.toolOutputs,
      extraction: finalState.extraction,
    };
  }

  async stream(params: { body: unknown; correlationId: string; res: Response }): Promise<void> {
    const runId = randomUUID();
    const compiled = buildAgentGraph(
      this.getDeps(),
      params.body,
      params.correlationId,
      this.checkpointer ?? undefined,
    );

    logger.info({ msg: 'run.stream.start', correlationId: params.correlationId, runId });

    const sendEvent = (event: StreamEvent) => {
      params.res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const stream = await compiled.stream({ runId }, { configurable: { thread_id: runId } });

      for await (const chunk of stream) {
        const [nodeName] = Object.keys(chunk);
        if (nodeName) {
          sendEvent({ node: nodeName });
        }
      }

      sendEvent({ node: 'done' });
    } catch (error) {
      // The response is already committed — headers went out with the first
      // frame — so GlobalHttpExceptionFilter writing a JSON body onto it
      // throws ERR_HTTP_HEADERS_SENT and the client is left with a stream that
      // simply stops. Containment for a stream is a terminal frame, and the
      // error must not escape this method.
      const message = error instanceof Error ? error.message : String(error);
      logger.error({
        msg: 'run.stream.failed',
        correlationId: params.correlationId,
        runId,
        error: message,
      });
      sendEvent({ node: 'error', error: { node: 'unknown', message } });
    } finally {
      params.res.end();
    }
  }
}

/**
 * The no-database path. It is load-bearing, not a convenience: P0-A requires
 * both README quickstart curls to succeed against a clone with no `.env`.
 *
 * These are reached only when the memory axis is *unconfigured*. A configured
 * store that is unreachable fails at boot in `MemoryModule` and never gets
 * here — falling back to no-op writers because a database is missing is the
 * defect this change removes.
 */
const stubRetrievalFacade: RetrievalFacade = {
  retrieve: async () => [
    {
      source: 'pgvector',
      score: 0.85,
      content: 'LangGraph enables stateful agent workflows.',
    },
    {
      source: 'neo4j',
      score: 0.78,
      content: 'Agents use a Three-Brain memory architecture.',
      entityId: 'memory',
    },
  ],
};

const stubEpisodicRepository: EpisodicRepository = {
  write: async () => ({ id: randomUUID() }),
  findBySession: async () => [],
};

const stubNeo4jWriter: Neo4jWriter = {
  mergeEntity: async () => {},
  mergeRelationship: async () => {},
  mergeFact: async () => {},
};

const stubPgvectorWriter: PgvectorWriter = {
  upsertFact: async () => {},
};
