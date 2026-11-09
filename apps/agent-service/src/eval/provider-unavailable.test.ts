import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvalHarness,
  cassettePath,
  type EvalAbort,
  type Grader,
  type MemoryOutcome,
  type Suite,
} from '@repo/eval-harness';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type MemoryInspector,
  type SeedManager,
} from '@repo/memory-core';
import { CHAT_MODEL } from '../agent/model/model-deps.js';
import { RunsService } from '../runs/runs.service.js';
import { explainAbort } from './abort-cause.js';
import { AgentServiceHarness } from './agent-harness.js';
import { recordingDecks } from './cassette-deps.js';
import { chatOptionsFor, runAndReport } from './run-suite.js';

/**
 * P1-I's acceptance criterion for the retry bound, on a stubbed transport.
 *
 * Everything between `yarn eval` and `fetch` is the real code: the runner
 * that writes the abort, `explainAbort`, `EvalHarness`, the memory-recall
 * adapter and its recording decks, `RunsService` with the Gemini clients and
 * the graph with `IO_RETRY`. What is fake is the network, which `fetch`
 * answers, and the stores, which `RunsService` leaves at their no-database
 * stand-ins and the adapter reaches through a no-op seed manager and inspector.
 */

const TASK = 'memory-recall-001';
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answer(text: string): Response {
  return json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  });
}

function unavailable(): Response {
  return json(
    {
      error: {
        code: 503,
        message: 'This model is currently experiencing high demand. Please try again later.',
        status: 'UNAVAILABLE',
      },
    },
    503,
  );
}

/**
 * The model host. Each chat seam gets an answer its parser accepts, until
 * `outage` is set; then the next `outage` chat requests answer 503.
 */
function modelHost() {
  const state = { outage: 0, chatRequestsInOutage: 0 };
  const stub = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(':embedContent')) {
      return json({ embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.1) } });
    }
    if (state.outage > 0 || state.chatRequestsInOutage > 0) state.chatRequestsInOutage += 1;
    if (state.outage > 0) {
      state.outage -= 1;
      return unavailable();
    }
    const body = String(init?.body ?? '');
    if (body.includes('You choose the next tool call')) return answer('null');
    if (body.includes('Extract entities, relationships')) {
      return answer('{"entities": [], "relationships": [], "facts": []}');
    }
    return answer('a plan');
  });
  return { state, fetch: stub };
}

const passes: Grader<MemoryOutcome> = {
  name: 'ran',
  kind: 'code',
  grade: async () => ({ value: 1, label: 'pass' }),
};

const suite: Suite<MemoryOutcome> = {
  name: 'memory-recall',
  trialsPerTask: 2,
  tasks: [
    {
      id: TASK,
      description: 'a task',
      input: { sessionId: SESSION, messages: [{ role: 'user', content: 'What is LangGraph?' }] },
      seeds: { neo4j: [], relationships: [], pgvector: [], graphFacts: [] },
      graders: [passes],
    },
  ],
};

const noStores = {
  context: { close: async () => {} } as unknown as INestApplicationContext,
  seeds: { restoreToSeed: async () => {}, applySeed: async () => {} } satisfies SeedManager,
  inspector: {
    inspectRun: async ({ runId }) => ({
      runId,
      episodeRowsForRun: 1,
      factRowsForRun: 0,
      factNodesForRun: 0,
      presentConceptIds: [],
    }),
  } satisfies MemoryInspector,
};

describe('a recording run that meets three consecutive 503s', () => {
  const key = process.env['GOOGLE_API_KEY'];
  let outputDir: string;
  let datasetDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'p1i-output-'));
    datasetDir = mkdtempSync(join(tmpdir(), 'p1i-dataset-'));
    // Selects the Gemini model half. The key is fake and `fetch` is stubbed.
    process.env['GOOGLE_API_KEY'] = 'fake-key';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(datasetDir, { recursive: true, force: true });
    if (key === undefined) delete process.env['GOOGLE_API_KEY'];
    else process.env['GOOGLE_API_KEY'] = key;
  });

  it('makes two requests for that call, aborts with provider-unavailable, and keeps the finished trial', async () => {
    const host = modelHost();
    vi.stubGlobal('fetch', host.fetch);

    const axes = { model: 'live', memory: 'live' } as const;
    const runs = new RunsService(null, null, null, null, null, null);
    // What `createAgentServiceHarness` does with the options `run-eval.ts` passes.
    runs.setChatOptions(chatOptionsFor('record', axes));
    const decks = recordingDecks({ datasetDir, axes, gitSha: 'a'.repeat(40) });
    const agent = new AgentServiceHarness(
      noStores.context,
      runs,
      noStores.inspector,
      noStores.seeds,
      decks,
    );

    let done = false;
    const ended = runAndReport<MemoryOutcome>({
      outputDir,
      suite: suite.name,
      explain: explainAbort,
      body: (progress, onTrial) => {
        progress.axes = axes;
        return new EvalHarness<MemoryOutcome>({
          agent,
          suite,
          models: { chat: CHAT_MODEL, embedding: EMBEDDING_MODEL },
          onTrial: (trial) => {
            onTrial(trial);
            // The provider goes down after the first trial has finished.
            host.state.outage = 3;
          },
        }).run();
      },
    }).finally(() => (done = true));
    for (let step = 0; step < 40 && !done; step++) await vi.advanceTimersByTimeAsync(30_000);

    expect(await ended).toBe('aborted');

    // Two requests for the call that met the outage, and none after it: the
    // third 503 was never asked for, and `IO_RETRY` did not re-run the node.
    expect(host.state.chatRequestsInOutage).toBe(2);
    expect(host.state.outage).toBe(1);

    const abort = JSON.parse(readFileSync(join(outputDir, 'eval-abort.json'), 'utf8')) as EvalAbort;
    expect(abort.cause?.code).toBe('provider-unavailable');
    expect(abort.cause?.summary).toContain('answered 503 on a request and on its one retry');
    expect(abort.cause?.summary).toContain('after 1 completed trial.');
    expect(abort.error).toMatchObject({ name: 'ProviderUnavailableError', status: 503 });
    expect(abort.completedTrials.map((trial) => [trial.taskId, trial.index])).toEqual([[TASK, 0]]);
    expect(existsSync(join(outputDir, 'eval-report.json'))).toBe(false);

    // The finished trial's cassette is on disk; the aborted one wrote none.
    const kept = JSON.parse(readFileSync(cassettePath(datasetDir, TASK, 0), 'utf8')) as {
      header: { taskId: string; trialIndex: number };
      decisions: { seam: string }[];
    };
    expect(kept.header).toMatchObject({ taskId: TASK, trialIndex: 0 });
    expect(kept.decisions.map((decision) => decision.seam)).toContain('plan.callLlm');
    expect(existsSync(cassettePath(datasetDir, TASK, 1))).toBe(false);
  });
});

describe('chatOptionsFor', () => {
  it('bounds a recording and a live run, and leaves replay and the stub axis alone', () => {
    expect(chatOptionsFor('record', { model: 'live' })).toEqual({ boundServerErrors: true });
    expect(chatOptionsFor('off', { model: 'live' })).toEqual({ boundServerErrors: true });
    expect(chatOptionsFor('replay', { model: 'replay' })).toEqual({ boundServerErrors: false });
    expect(chatOptionsFor('off', { model: 'stub' })).toEqual({ boundServerErrors: false });
  });
});
