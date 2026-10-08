import { randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { RunResponse, StreamEvent } from '@repo/agent-contracts';
import { createLogger, withAgentSpan, type AgentSpan } from '@repo/telemetry';
import {
  EMBEDDING_DIMENSIONS,
  type EpisodicRepository,
  type Neo4jWriter,
  type PgvectorWriter,
  type RetrievalFacade,
} from '@repo/memory-core';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { buildAgentGraph, type GraphDeps } from '../agent/graph/graph.js';
import { buildRunResponse } from '../agent/nodes/egress.node.js';
import type { AgentState } from '../agent/graph/state.js';
import { createGeminiEmbedder } from '../agent/model/gemini-embedder.js';
import { invokeChat, type ChatRequest } from '../agent/model/gemini-chat.js';
import { stopOnDailyQuota } from '../agent/model/rate-limit.js';
import { EXTRACTION_PROMPT, parseExtraction } from '../agent/model/extraction.js';
import {
  EPISODIC_REPOSITORY,
  NEO4J_WRITER,
  PGVECTOR_WRITER,
  RETRIEVAL_FACADE,
  CHECKPOINTER,
} from '../memory/memory.tokens.js';
import { NO_USAGE } from '../agent/model/usage.js';
import { CHAT_MODEL, defaultTools, type ModelDeps } from '../agent/model/model-deps.js';
import type { ToolSelection } from '../agent/nodes/act.node.js';
import {
  ASSESS_PROMPT,
  assessmentPrompt,
  parseAssessment,
  stubAssessment,
} from '../agent/prior-auth/assessment.js';

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
  /** The trace the run's `invoke_agent` span is the root of. */
  readonly traceId: string;
}

/**
 * `gen_ai.agent.name` on every run's root span. The conventions ask for it at
 * creation because a sampler may read it.
 */
export const AGENT_NAME = 'agent-service';

/**
 * The chat client, constructed in one place so the retry behaviour is the same
 * on both instances and a test can build exactly what a request uses.
 *
 * `onFailedAttempt` reaches LangChain's `AsyncCaller`, which retries every
 * status outside a short list — 429 included — up to six times. A daily-quota
 * 429 cannot succeed on any of them, so `stopOnDailyQuota` makes it terminal
 * and leaves every other failure to the default handler.
 */
export function createGeminiChat(
  apiKey: string,
  options: { json?: boolean } = {},
): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    model: CHAT_MODEL,
    apiKey,
    ...(options.json === true ? { json: true } : {}),
    onFailedAttempt: stopOnDailyQuota,
  });
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
    assess: {
      assessCriteria: (criteria, evidence) => deps().assess.assessCriteria(criteria, evidence),
    },
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

    const model = this.modelDeps();

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

  /**
   * The model half for one request, on the axis `GOOGLE_API_KEY` selects and
   * through the decorator, if one is installed.
   *
   * Public because the prior-authorization graph takes its model from here
   * too (P3-D): one axis switch and one decorator for both graphs, so an
   * evaluation that records or replays one records or replays the other.
   */
  modelDeps(): ModelDeps {
    const apiKey = process.env['GOOGLE_API_KEY'];
    const axis = (): ModelDeps =>
      apiKey ? this.createGeminiModelDeps(apiKey) : this.createStubModelDeps();

    // The decorator reaches the model half and nothing else. Undecorated, the
    // axis is built here and the path is the one a request takes; decorated,
    // it is built lazily and a decorator that ignores its argument — which is
    // what replay does — never causes a model client to exist at all.
    return this.decorateModel === undefined ? axis() : this.decorateModel(lazyModelDeps(axis));
  }

  private createGeminiModelDeps(apiKey: string): ModelDeps {
    // Two instances of the same model. `json: true` sets Gemini's
    // `responseMimeType: application/json`, which is what stops it wrapping a
    // JSON answer in a ```json fence. `plan` wants prose and must not have it;
    // the two callers that parse a response must.
    const prose = createGeminiChat(apiKey);
    const json = createGeminiChat(apiKey, { json: true });

    // Each call names its seam, so the inference span says which decision it
    // paid for — the cassette's vocabulary, which is what P1-F attributes by.
    const callWith =
      (llm: ChatGoogleGenerativeAI, request: Omit<ChatRequest, 'model'>) =>
      (systemPrompt: string, userPrompt: string) =>
        invokeChat(llm, { model: CHAT_MODEL, ...request }, systemPrompt, userPrompt);

    const callLlm = callWith(prose, { seam: 'plan.callLlm', json: false });
    const callSelect = callWith(json, { seam: 'act.selectTool', json: true });
    const callExtract = callWith(json, { seam: 'distill.extractEntities', json: true });
    const callAssess = callWith(json, { seam: 'assess.criteria', json: true });

    return {
      plan: { callLlm },
      act: {
        tools: defaultTools(),
        selectTool: async (plan, tools) => {
          const toolNames = tools.map((t) => t.name).join(', ');
          const response = await callSelect(
            'You select the best tool for a task. Respond with JSON: {"toolName": "...", "input": ...} or null if no tool is needed.',
            `Plan: ${plan}\nAvailable tools: ${toolNames}`,
          );
          // The call is paid for whether or not its answer parses, so the
          // usage goes back either way.
          let selection: ToolSelection | null;
          try {
            selection = JSON.parse(response.content) as ToolSelection | null;
          } catch {
            selection = null;
          }
          return { selection, tokenCounts: response.tokenCounts };
        },
      },
      distill: {
        extractEntities: async (context: string) => {
          const response = await callExtract(EXTRACTION_PROMPT, context);
          return {
            extraction: parseExtraction(response.content),
            tokenCounts: response.tokenCounts,
          };
        },
      },
      embed: createGeminiEmbedder(apiKey),
      assess: {
        assessCriteria: async (criteria, evidence) => {
          const response = await callAssess(ASSESS_PROMPT, assessmentPrompt(criteria, evidence));
          return parseAssessment(response.content);
        },
      },
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
        // Stub: no tool needed. No model was called, so nothing was used —
        // unlike `plan`'s canned figures, which predate P1-F and stay.
        selectTool: async () => ({ selection: null, tokenCounts: NO_USAGE }),
      },
      distill: {
        extractEntities: async () => ({
          extraction: {
            entities: [
              { id: 'langgraph', label: 'LangGraph', description: 'Framework for stateful agents' },
            ],
            relationships: [],
            facts: [{ text: 'LangGraph is used for building stateful agent workflows.' }],
          },
          tokenCounts: NO_USAGE,
        }),
      },
      embed: stubEmbedding,
      assess: stubAssessment,
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

    // The root every node span hangs off. Without it a run was seven traces,
    // one per node: nothing encloses the graph and no instrumentation supplies
    // a parent. LangGraph propagates the active context, so one span here is
    // enough.
    return withAgentSpan({ agentName: AGENT_NAME, runId }, async (agent) => {
      const result = await compiled.invoke({ runId }, { configurable: { thread_id: runId } });
      const state = result as unknown as AgentState;
      agent.setConversationId(state.sessionId);
      return buildRunResponse(state);
    });
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

    return withAgentSpan({ agentName: AGENT_NAME, runId }, async (agent) => {
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
      agent.setConversationId(finalState.sessionId);

      return {
        response: buildRunResponse(finalState),
        nodeSequence,
        toolOutputs: finalState.toolOutputs,
        extraction: finalState.extraction,
        traceId: agent.traceId,
      };
    });
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

    await withAgentSpan({ agentName: AGENT_NAME, runId }, (agent) =>
      this.streamInto(compiled, runId, params, sendEvent, agent),
    );
  }

  private async streamInto(
    compiled: ReturnType<typeof buildAgentGraph>,
    runId: string,
    params: { correlationId: string; res: Response },
    sendEvent: (event: StreamEvent) => void,
    agent: AgentSpan,
  ): Promise<void> {
    try {
      const stream = await compiled.stream({ runId }, { configurable: { thread_id: runId } });

      for await (const chunk of stream) {
        const [nodeName] = Object.keys(chunk);
        if (nodeName) {
          sendEvent({ node: nodeName });
        }
        // `ingress` is the node that validated the body, so its update is
        // where the session id first exists.
        const sessionId = (chunk as Record<string, { sessionId?: unknown }>)['ingress']?.sessionId;
        if (typeof sessionId === 'string') agent.setConversationId(sessionId);
      }

      sendEvent({ node: 'done' });
    } catch (error) {
      // Contained below, so the root span is marked here or not at all.
      agent.recordError(error);
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
    // Both from pgvector, because a configured run's are: retrieval is
    // vector-only since ADR 0009.
    {
      source: 'pgvector',
      score: 0.78,
      content: 'Agents use a Three-Brain memory architecture.',
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
