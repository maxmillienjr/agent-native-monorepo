import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { MemoryInspector, SeedApplication, SeedManager, SeedState } from '@repo/memory-core';
import { loadRedTeamSuite, type MemoryOutcome, type Task } from '@repo/eval-harness';
import type { Deck } from '@repo/agent-cassette';
import type { RunsService, TracedRun } from '../runs/runs.service.js';
import { AgentServiceHarness, sessionsNamedBy } from './agent-harness.js';
import type { TrialDecks } from './cassette-deps.js';

/**
 * The adapter's own bookkeeping for a task with prior runs (P4-B): which
 * sessions a reset restores, the order the runs are made in, how often the
 * trial's deck is closed, and what the outcome carries for the canary graders.
 * The graph is not run here; `RunsService` is replaced by a recorder.
 */

const redTeamTask = (id: string): Task<MemoryOutcome> => {
  const task = loadRedTeamSuite().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`${id} is missing from the red-team dataset`);
  return task;
};
const rt001 = (): Task<MemoryOutcome> => redTeamTask('rt-001');
const rt003 = (): Task<MemoryOutcome> => redTeamTask('rt-003');

const sessionOf = (input: unknown): string => (input as { sessionId: string }).sessionId;

/** A `RunsService` that records what it was asked to run and answers in kind. */
function recordingRuns(log: string[]) {
  const runs = {
    setModelDecorator: () => {},
    executeTraced: async ({ body }: { body: unknown }): Promise<TracedRun> => {
      const sessionId = sessionOf(body);
      log.push(`run ${sessionId}`);
      return {
        response: {
          runId: randomUUID(),
          sessionId,
          messages: [{ role: 'assistant', content: `answer in ${sessionId}` }],
          outcome: 'success',
          tokenCounts: { prompt: 1, completion: 1 },
          retrievedContext: [],
        },
        nodeSequence: ['ingress', 'egress'],
        toolOutputs: [],
        extraction: {
          entities: [{ id: 'northwind', label: 'Northwind Health Plan' }],
          relationships: [],
          facts: [{ text: `a fact from ${sessionId}` }],
        },
        traceId: randomUUID(),
      };
    },
  };
  return runs as unknown as RunsService;
}

function harnessWith(log: string[]) {
  const restored: string[] = [];
  const applied: SeedApplication[] = [];
  const seeds: SeedManager = {
    restoreToSeed: async (seed: SeedState) => {
      restored.push(seed.sessionId);
    },
    applySeed: async (seed: SeedApplication) => {
      applied.push(seed);
    },
  };
  const inspector: MemoryInspector = {
    inspectRun: async (input) => ({
      runId: input.runId,
      episodeRowsForRun: 2,
      factRowsForRun: 1,
      factNodesForRun: 1,
      presentConceptIds: [...(input.conceptIds ?? [])],
    }),
  };
  const decks: TrialDecks = {
    mode: 'record',
    open: () => {
      log.push('open');
      return {} as Deck;
    },
    close: async (completed) => {
      log.push(`close ${completed}`);
    },
  };
  const context = { close: async () => {} } as unknown as INestApplicationContext;
  const harness = new AgentServiceHarness(context, recordingRuns(log), inspector, seeds, decks);
  return { harness, restored, applied };
}

describe('AgentServiceHarness, for a task with prior runs', () => {
  it('names the graded session, then each prior run’s, then each seeded fact’s, once each', () => {
    const task = rt003();
    const victim = sessionOf(task.input);
    const attacker = sessionOf(task.priorInputs![0]);
    expect(sessionsNamedBy(task)).toEqual([victim, attacker]);
  });

  it('restores every session the task names before the trial', async () => {
    const task = rt003();
    const { harness, restored } = harnessWith([]);
    await harness.reset(task);
    expect(restored).toEqual(sessionsNamedBy(task));
  });

  it('runs the prior input first, the graded one last, under one deck closed once', async () => {
    const task = rt003();
    const log: string[] = [];
    const { harness } = harnessWith(log);

    await harness.reset(task);
    const transcript = await harness.run(task);

    expect(log).toEqual([
      'open',
      `run ${sessionOf(task.priorInputs![0])}`,
      `run ${sessionOf(task.input)}`,
      'close true',
    ]);
    // The transcript is the graded run's, never the attacker's.
    expect(transcript.sessionId).toBe(sessionOf(task.input));
  });

  it('hands the outcome the graded run’s extracted fact texts', async () => {
    const task = rt003();
    const { harness } = harnessWith([]);

    await harness.reset(task);
    const transcript = await harness.run(task);
    const outcome = await harness.captureOutcome(task, transcript);

    expect(outcome.extractedFactTexts).toEqual([`a fact from ${sessionOf(task.input)}`]);
    expect(outcome.extractedConceptIds).toEqual(['northwind']);
  });
});

describe('AgentServiceHarness, for a task that seeds another session', () => {
  it('writes a graph fact under the session it names, not the graded one', async () => {
    const task = rt001();
    const victim = sessionOf(task.input);
    const [poison] = task.seeds.graphFacts;
    expect(poison?.sessionId).toBeDefined();
    expect(poison?.sessionId).not.toBe(victim);

    const { harness, applied } = harnessWith([]);
    await harness.reset(task);

    // The graded session's seed first, with the concepts the `:Fact` mentions,
    // and no graph fact of the attacker's; then the attacker's `:Fact` alone.
    expect(applied.map((seed) => [seed.sessionId, seed.graphFacts?.length ?? 0])).toEqual([
      [victim, 0],
      [poison?.sessionId, 1],
    ]);
    expect(applied[0]?.concepts?.map((concept) => concept.id)).toEqual(['northwind']);
    expect(applied[1]?.graphFacts?.[0]?.contentHash).toBe(poison?.contentHash);
  });
});
