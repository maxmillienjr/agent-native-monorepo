import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineRegistry, ToolRegistryError } from './registry.js';
import type { ToolDefinition } from './types.js';

const description = 'Looks a thing up by its name. Changes nothing outside the run.';

const tool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition =>
  ({
    name: 'look-up',
    description,
    tier: 'read-only',
    input: z.object({ name: z.string().min(1) }).strict(),
    execute: async () => ({ found: true }),
    ...overrides,
  }) as ToolDefinition;

const problems = (tools: readonly ToolDefinition[]): readonly string[] => {
  try {
    defineRegistry(tools);
    return [];
  } catch (error) {
    if (error instanceof ToolRegistryError) return error.problems;
    throw error;
  }
};

describe('defineRegistry', () => {
  it('rejects two tools with one name, since a selection naming it would be ambiguous', () => {
    expect(problems([tool(), tool()])).toEqual(['"look-up" is registered twice']);
  });

  it('rejects a description under 40 characters, which leaves the model choosing from a name', () => {
    expect(problems([tool({ description: 'Looks things up.' })])).toEqual([
      '"look-up" has a description under 40 characters: say what it does, when to choose it, ' +
        'and what it changes',
    ]);
  });

  it('rejects a name the model would have to guess the spelling of', () => {
    expect(problems([tool({ name: 'Look Up' })])).toHaveLength(1);
  });

  it('repeats the tier rule at runtime, for a definition that arrived through a cast', () => {
    expect(problems([tool({ tier: 'compensable' })])).toEqual([
      '"look-up" is compensable and declares no compensate',
    ]);
    expect(
      problems([tool({ compensate: async () => {} } as unknown as Partial<ToolDefinition>)]),
    ).toEqual(['"look-up" is read-only and declares a compensate it would never run']);
  });

  it('names every problem at once', () => {
    expect(problems([tool({ name: 'x', description: 'short' })])).toHaveLength(2);
  });

  it('describes each tool with its tier and the JSON Schema of its input', () => {
    const registry = defineRegistry([tool()]);

    expect(registry.describe()).toEqual([
      {
        name: 'look-up',
        description,
        tier: 'read-only',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    ]);
    expect(registry.get('look-up')?.tier).toBe('read-only');
    expect(registry.get('missing')).toBeUndefined();
  });
});
