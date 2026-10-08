import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { MemoryInspector, SeedManager, SeedState } from '@repo/memory-core';
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

const rt003 = (): Task<MemoryOutcome> => {
  const task = loadRedTeamSuite().tasks.find((candidate) => candidate.id === 'rt-003');
  if (task === undefined) throw new Error('rt-003 is missing from the red-team dataset');
  return task;
};

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
  const seeds: SeedManager = {
    restoreToSeed: async (seed: SeedState) => {
      restored.push(seed.sessionId);
    },
    applySeed: async () => {},
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
  return { harness, restored };
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
