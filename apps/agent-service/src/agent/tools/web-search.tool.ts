import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * A stub. It returns an echo of its input and touches nothing, which is also
 * why nothing can inject through its output into the next selection: the
 * output is the model's own query.
 *
 * The output keeps the spelling it had before the registry, `Result for:`
 * and the JSON of the input, so a recorded `act.tool` decision still matches.
 */
export const webSearchTool = defineTool({
  name: 'web-search',
  description:
    'Searches the web for a query and returns result snippets. Use when the plan needs ' +
    'information that is not in the conversation or the retrieved context. Changes nothing.',
  tier: 'read-only',
  input: z.object({ query: z.string().min(1).max(500) }).strict(),
  execute: async (input) => ({ results: [`Result for: ${JSON.stringify(input)}`] }),
});
