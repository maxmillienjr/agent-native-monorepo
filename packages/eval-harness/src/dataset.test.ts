import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVAL_DATASETS_DIR,
  TaskSpecSchema,
  loadMemoryRecallSuite,
  loadSuite,
  taskFromSpec,
} from './dataset.js';
import { skippedTasks } from './axes.js';

const minimalSpec = {
  id: 'minimal',
  description: 'only one assertion',
  retrievalPath: 'vector',
  input: {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [{ role: 'user', content: 'hello' }],
  },
  expectedOutcome: 'success',
  assertions: { outcomeMustBe: 'success' },
};

describe('the shipped dataset', () => {
  it('resolves its directory from the package rather than a path literal', () => {
    // The coupling that makes this worth asserting is one-way: a task file that
    // moves while a path literal stays behind makes the seed script find
    // nothing, seed nothing, and report success over an empty database.
    expect(existsSync(join(EVAL_DATASETS_DIR, 'memory-recall'))).toBe(true);
  });

  it('loads memory-recall-001, migrated from run-fixture-001.json', () => {
    const suite = loadMemoryRecallSuite();
    const task = suite.tasks.find((t) => t.id === 'memory-recall-001')!;
    // expectedSeeds is retained exactly as the fixture carried it.
    expect(task.seeds.neo4j.map((c) => c.id)).toEqual(['concept-a', 'concept-b']);
    expect(task.seeds.pgvector).toHaveLength(1);
    expect(task.seeds.relationships).toHaveLength(1);
  });

  it('runs five trials per task by default', () => {
    expect(loadMemoryRecallSuite().trialsPerTask).toBe(5);
  });

  it('turns the three dormant assertions into named graders', () => {
    const task = loadMemoryRecallSuite().tasks.find((t) => t.id === 'memory-recall-001')!;
    const names = task.graders.map((g) => g.name);
    expect(names).toContain('retrieved_context_min_length');
    expect(names).toContain('outcome_must_be');
    expect(names).toContain('token_counts_positive');
  });

  it('grades persisted state, and says which axis that needs', () => {
    const graders = loadMemoryRecallSuite().tasks.find(
      (t) => t.id === 'memory-recall-001',
    )!.graders;
    const episodic = graders.find((g) => g.name === 'episodic_row_written');
    const entity = graders.find((g) => g.name === 'entity_merged');

    expect(episodic?.requires).toEqual({ memory: 'live' });
    expect(entity?.requires).toEqual({ memory: 'live' });
  });

  it('gives every task a distinct session, so one reset cannot disturb another', () => {
    const sessions = loadMemoryRecallSuite().tasks.map(
      (task) => (task.input as { sessionId: string }).sessionId,
    );
    expect(new Set(sessions).size).toBe(sessions.length);
  });

  it('gates tool-use-001 on the agent actually calling the tool it has', () => {
    // The task memory-recall-001 does not cover. Its threshold is 1, where
    // memory-recall-001 reports the same metric without gating on it.
    const task = loadMemoryRecallSuite().tasks.find((t) => t.id === 'tool-use-001')!;
    expect(task.graders.map((g) => g.name)).toContain('tool_trajectory_recall');
  });

  it('declares the axes tool-use-001 is meaningful on, as a set', () => {
    // A set rather than `live` alone, so P1-B's replay axis needs no edit here.
    const task = loadMemoryRecallSuite().tasks.find((t) => t.id === 'tool-use-001')!;
    expect(task.requires).toEqual({ model: ['live', 'replay'] });
  });

  it('leaves a task that declared nothing without a requirement', () => {
    const task = loadMemoryRecallSuite().tasks.find((t) => t.id === 'memory-recall-001')!;
    expect(task.requires).toBeUndefined();
  });

  it('skips nothing in the shipped suite once both axes are live', () => {
    // The decision under test is the skip, and it is a function of the axes
    // alone — so it is checkable here rather than by spending a live suite's
    // worth of quota. Whether the tasks then *pass* on that axis is a different
    // claim and belongs to a live run, which P1-C owns.
    expect(skippedTasks(loadMemoryRecallSuite().tasks, { model: 'live', memory: 'live' })).toEqual(
      [],
    );
  });

  it('parses a scalar requirement as well as a set', () => {
    const spec = TaskSpecSchema.parse({
      ...minimalSpec,
      requires: { model: 'live', memory: 'live' },
    });
    expect(spec.requires).toEqual({ model: 'live', memory: 'live' });
  });

  it('rejects an axis value that is not a member of its union', () => {
    // The failure this prevents: a typo read as "no requirement", and the task
    // silently running on the axis it said it could not use.
    expect(() =>
      TaskSpecSchema.parse({ ...minimalSpec, requires: { model: 'cassette' } }),
    ).toThrow();
    expect(() =>
      TaskSpecSchema.parse({ ...minimalSpec, requires: { memory: ['live', 'partial'] } }),
    ).toThrow();
  });

  it('builds no grader for an assertion the task does not declare', () => {
    const task = taskFromSpec({
      id: 'minimal',
      description: 'only one assertion',
      retrievalPath: 'vector',
      input: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'hello' }],
      },
      expectedSeeds: { neo4j: [], relationships: [], pgvector: [] },
      expectedOutcome: 'success',
      assertions: { outcomeMustBe: 'success' },
    });

    expect(task.graders.map((g) => g.name)).toEqual(['outcome_must_be']);
  });

  it('refuses a dataset directory with no task files in it', () => {
    expect(() => loadSuite('empty', EVAL_DATASETS_DIR)).toThrow(/loaded no tasks/);
  });
});
