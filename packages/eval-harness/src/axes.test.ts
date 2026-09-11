import { describe, it, expect } from 'vitest';
import {
  assertAxesSatisfy,
  AxisRequirementError,
  describeAxes,
  detectAxes,
  skippedTasks,
  unmetRequirements,
} from './axes.js';
import type { AxisRequirements, Grader, Task } from './types.js';

const grader = (name: string, requires?: Grader['requires']): Grader<never> => ({
  name,
  kind: 'code',
  ...(requires ? { requires } : {}),
  grade: async () => ({ value: 1, label: 'pass' }),
});

describe('detectAxes', () => {
  it('reads the stub model axis when no key is present', () => {
    expect(detectAxes({}).model).toBe('stub');
  });

  it('treats an empty key as absent', () => {
    // Turbo's strict env mode does not unset a variable it strips, it never
    // sets it; a shell that exports an empty one is the other half of the same
    // trap, and both must read as `stub` rather than `live`.
    expect(detectAxes({ GOOGLE_API_KEY: '' }).model).toBe('stub');
  });

  it('reads the live model axis when a key is present', () => {
    expect(detectAxes({ GOOGLE_API_KEY: 'k' }).model).toBe('live');
  });

  it('needs both stores before it calls the memory axis live', () => {
    expect(detectAxes({ DATABASE_URL: 'postgres://x' }).memory).toBe('unconfigured');
    expect(detectAxes({ NEO4J_URI: 'bolt://x' }).memory).toBe('unconfigured');
    expect(detectAxes({ DATABASE_URL: 'postgres://x', NEO4J_URI: 'bolt://x' }).memory).toBe('live');
  });

  it('describes both axes in one line', () => {
    expect(describeAxes({ model: 'live', memory: 'unconfigured' })).toBe(
      'model=live memory=unconfigured',
    );
  });
});

describe('unmetRequirements', () => {
  const stub = { model: 'stub', memory: 'unconfigured' } as const;
  const live = { model: 'live', memory: 'live' } as const;

  it('accepts a scalar on either axis, which is what every grader declares today', () => {
    expect(unmetRequirements({ model: 'live' }, live)).toEqual([]);
    expect(unmetRequirements({ memory: 'live' }, live)).toEqual([]);
    expect(unmetRequirements({ model: 'live' }, stub)).toEqual([
      'model axis is `stub`, needs `live`',
    ]);
    expect(unmetRequirements({ memory: 'live' }, stub)).toEqual([
      'memory axis is `unconfigured`, needs `live`',
    ]);
  });

  it('accepts a set on either axis, and tests membership rather than equality', () => {
    // The case the scalar form cannot express: a task that needs any axis able
    // to call a model is satisfied by `live` and by `replay`.
    expect(unmetRequirements({ model: ['live', 'replay'] }, live)).toEqual([]);
    expect(unmetRequirements({ model: ['live', 'replay'] }, { ...stub, model: 'replay' })).toEqual(
      [],
    );
    expect(unmetRequirements({ memory: ['live', 'unconfigured'] }, stub)).toEqual([]);
  });

  it('names the run’s axis and the whole acceptable set in one sentence', () => {
    expect(unmetRequirements({ model: ['live', 'replay'] }, stub)).toEqual([
      'model axis is `stub`, needs one of `live`, `replay`',
    ]);
  });

  it('reports both axes when both are unmet', () => {
    expect(unmetRequirements({ model: ['live'], memory: 'live' }, stub)).toHaveLength(2);
  });

  it('treats an axis with no requirement as satisfied', () => {
    expect(unmetRequirements({}, stub)).toEqual([]);
  });
});

describe('skippedTasks', () => {
  const stub = { model: 'stub', memory: 'live' } as const;

  const task = (id: string, requires?: AxisRequirements): Task<never> => ({
    id,
    description: id,
    input: {},
    seeds: { neo4j: [], relationships: [], pgvector: [] },
    graders: [],
    ...(requires ? { requires } : {}),
  });

  it('skips only the tasks whose requirements the run does not meet', () => {
    expect(
      skippedTasks(
        [task('memory-recall-001'), task('tool-use-001', { model: ['live', 'replay'] })],
        stub,
      ),
    ).toEqual([
      {
        taskId: 'tool-use-001',
        problems: ['model axis is `stub`, needs one of `live`, `replay`'],
      },
    ]);
  });

  it('skips nothing once the axis is one the task named', () => {
    expect(
      skippedTasks([task('tool-use-001', { model: ['live', 'replay'] })], {
        model: 'live',
        memory: 'live',
      }),
    ).toEqual([]);
  });

  it('does not throw, which is the whole difference from the grader check', () => {
    // A clone with no `.env` has to be able to run `yarn eval` and get a
    // smaller honest answer, not a refusal.
    expect(() => skippedTasks([task('t', { model: 'live' })], stub)).not.toThrow();
  });
});

describe('assertAxesSatisfy', () => {
  const live = { model: 'live', memory: 'live' } as const;
  const unconfigured = { model: 'stub', memory: 'unconfigured' } as const;

  it('passes a grader with no requirements on any axis', () => {
    expect(() => assertAxesSatisfy([grader('plain')], unconfigured)).not.toThrow();
  });

  it('refuses rather than grading the no-op writers', () => {
    expect(() =>
      assertAxesSatisfy([grader('episodic_row_written', { memory: 'live' })], unconfigured),
    ).toThrow(AxisRequirementError);
  });

  it('reports every unmet requirement, not the first', () => {
    try {
      assertAxesSatisfy(
        [
          grader('episodic_row_written', { memory: 'live' }),
          grader('answer_is_grounded', { model: 'live' }),
        ],
        unconfigured,
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AxisRequirementError);
      expect((error as AxisRequirementError).problems).toHaveLength(2);
      expect((error as AxisRequirementError).message).toContain('episodic_row_written');
      expect((error as AxisRequirementError).message).toContain('answer_is_grounded');
    }
  });

  it('reads a set on a grader the same way it reads one on a task', () => {
    expect(() =>
      assertAxesSatisfy([grader('replayable', { model: ['live', 'replay'] })], live),
    ).not.toThrow();
    expect(() =>
      assertAxesSatisfy([grader('replayable', { model: ['live', 'replay'] })], unconfigured),
    ).toThrow(AxisRequirementError);
  });

  it('lets everything through once both axes are live', () => {
    expect(() =>
      assertAxesSatisfy([grader('a', { memory: 'live' }), grader('b', { model: 'live' })], live),
    ).not.toThrow();
  });
});
