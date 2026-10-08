/**
 * Type tests for the tier rule, checked by `tsc --noEmit` (`yarn turbo
 * typecheck`) and never run by Vitest. Each `@ts-expect-error` fails with
 * TS2578 the day the line it guards starts compiling, so the rule holds only
 * while the type enforces it.
 */
import { z } from 'zod';
import { defineTool, type ToolDefinition } from './types.js';

const input = z.object({ caseId: z.string() }).strict();
const description = 'A fixture that exists to be refused by the type checker, never registered.';

// @ts-expect-error TS2322: a compensable tool must say how its effect is undone.
export const compensableWithoutUndo: ToolDefinition = {
  name: 'open-thing',
  description,
  tier: 'compensable',
  input,
  execute: async () => ({ id: 'x' }),
};

export const readOnlyWithUndo: ToolDefinition = {
  name: 'read-thing',
  description,
  tier: 'read-only',
  input,
  execute: async () => ({ id: 'x' }),
  // @ts-expect-error TS2353: a read-only tool has nothing to undo, so a compensate is a mistake.
  compensate: async () => {},
};

export const irreversibleWithUndo: ToolDefinition = {
  name: 'send-thing',
  description,
  tier: 'irreversible',
  input,
  execute: async () => ({ id: 'x' }),
  // @ts-expect-error TS2353: an irreversible call cannot be compensated; that is the tier.
  compensate: async () => {},
};

export const undeclaredTier: ToolDefinition = {
  name: 'vague-thing',
  description,
  // @ts-expect-error TS2322: there is no fourth tier.
  tier: 'reversible',
  input,
  execute: async () => ({ id: 'x' }),
};

// `defineTool` infers the output, so `compensate` reads it as declared.
export const typed = defineTool({
  name: 'open-thing',
  description,
  tier: 'compensable',
  input,
  execute: async (args) => ({ id: args.caseId }),
  compensate: async (_args, output) => {
    // @ts-expect-error TS2339: the output is `{ id }`, and nothing else.
    void output.requestId;
  },
});

// A bare string is not a tool input: the model is asked for named fields.
export const stringInput: ToolDefinition = {
  name: 'string-thing',
  description,
  tier: 'read-only',
  // @ts-expect-error TS2740: an input schema is an object.
  input: z.string(),
  execute: async () => null,
};
