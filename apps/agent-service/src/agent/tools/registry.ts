import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { CaseBoard } from './case-board.js';
import { requestRecordsTool } from './request-records.tool.js';
import { REVERSIBILITY_TIERS, type ReversibilityTier, type ToolDefinition } from './types.js';
import { webSearchTool } from './web-search.tool.js';

const NAME = /^[a-z][a-z0-9-]{2,40}$/;
const MIN_DESCRIPTION = 40;

/**
 * What the model is told about one tool: everything but the function.
 *
 * The JSON Schema is generated from the tool's Zod input, so the schema the
 * model is asked to fill and the one `act` validates against cannot drift.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly tier: ReversibilityTier;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolRegistry {
  /** In registration order, which is the order the selection request lists them in. */
  readonly tools: readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  describe(): readonly ToolDescriptor[];
}

/** A registry that would put an ambiguous or undescribed tool in front of the model. */
export class ToolRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the tool registry is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'ToolRegistryError';
  }
}

/**
 * The one way a set of tools becomes something `act` can use.
 *
 * The type holds the tier rule; this holds the rest, and names every problem at
 * once. A duplicate name would make a selection ambiguous. A short description
 * leaves the model choosing from a name, which is the defect this registry
 * replaces. The tier and `compensate` checks repeat the type's for a definition
 * that arrives through a cast.
 */
export function defineRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (!NAME.test(tool.name)) {
      problems.push(`"${tool.name}" is not a tool name: it must match ${String(NAME)}`);
    }
    if (seen.has(tool.name)) problems.push(`"${tool.name}" is registered twice`);
    seen.add(tool.name);

    if (tool.description.trim().length < MIN_DESCRIPTION) {
      problems.push(
        `"${tool.name}" has a description under ${MIN_DESCRIPTION} characters: say what it does, ` +
          'when to choose it, and what it changes',
      );
    }
    if (!(REVERSIBILITY_TIERS as readonly string[]).includes(tool.tier)) {
      problems.push(`"${tool.name}" declares no reversibility tier`);
    }
    const compensate = (tool as { compensate?: unknown }).compensate;
    if (tool.tier === 'compensable' && typeof compensate !== 'function') {
      problems.push(`"${tool.name}" is compensable and declares no compensate`);
    }
    if (tool.tier !== 'compensable' && compensate !== undefined) {
      problems.push(`"${tool.name}" is ${tool.tier} and declares a compensate it would never run`);
    }
  }

  if (problems.length > 0) throw new ToolRegistryError(problems);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const descriptors: readonly ToolDescriptor[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    inputSchema: inputSchema(tool),
  }));

  return {
    tools: [...tools],
    get: (name) => byName.get(name),
    describe: () => descriptors,
  };
}

/**
 * The input's JSON Schema, without `$schema`.
 *
 * `toJsonSchema` is `@langchain/core`'s, a direct dependency already; it
 * vendors `zod-to-json-schema` for a Zod 3 schema, which is why that package is
 * not declared here. The draft URI it adds is a constant, and a constant in
 * every selection request is input tokens spent on nothing. A copy, because
 * the function caches its result by schema and hands every caller one object.
 */
function inputSchema(tool: ToolDefinition): Record<string, unknown> {
  const { $schema: _draft, ...schema } = toJsonSchema(tool.input) as Record<string, unknown>;
  return schema;
}

/**
 * The registry every dependency set builds from — live, stub, recording and
 * replay.
 *
 * One function because the `act.selectTool` request carries every tool's
 * description, tier and schema, so a replay built from any other list misses on
 * its first request hash. The board is an argument: the service passes the one
 * Nest provides, and replay passes one it never reaches, since both tool seams
 * are served from the cassette there.
 */
export function defaultRegistry(board: CaseBoard): ToolRegistry {
  return defineRegistry([webSearchTool, requestRecordsTool(board)]);
}
