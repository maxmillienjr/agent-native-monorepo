import { z } from 'zod';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { NO_USAGE } from '../agent/model/usage.js';
import { SyntheticCaseBoard } from '../agent/tools/case-board.js';
import { defaultRegistry, defineRegistry } from '../agent/tools/registry.js';
import { defineTool } from '../agent/tools/types.js';
import { RunsService } from './runs.service.js';

/**
 * Makes `service`'s model always select an irreversible fixture tool, and
 * returns a count of the fixture's executions.
 *
 * The fixture is registered beside the default tools through the model
 * decorator, so the memory half and the checkpointer stay the service's own:
 * the unit test passes a `MemorySaver`, the integration test uses the service
 * `MemoryModule` wires with its `PostgresSaver`. It is the only irreversible
 * tool in the repository, and no production registry holds it.
 */
export function selectIrreversibleFixture(service: RunsService): () => number {
  let executions = 0;
  const notify = defineTool({
    name: 'notify-member',
    description: 'Fixture: sends a letter to the member on a case. A sent letter cannot be unsent.',
    tier: 'irreversible',
    input: z.object({ caseId: z.string() }).strict(),
    execute: async () => {
      executions += 1;
      return { sent: true };
    },
  });

  service.setModelDecorator((live) => ({
    ...live,
    act: {
      registry: defineRegistry([...defaultRegistry(new SyntheticCaseBoard()).tools, notify]),
      selectTool: async () => ({
        selection: { toolName: 'notify-member', input: { caseId: 'PA-100001' } },
        tokenCounts: NO_USAGE,
      }),
    },
  }));
  return () => executions;
}

/** A service with stub memory and `checkpointer`, paused by the fixture. */
export function pausingService(checkpointer: BaseCheckpointSaver | null): {
  service: RunsService;
  executed: () => number;
} {
  const service = new RunsService(null, null, null, null, checkpointer);
  return { service, executed: selectIrreversibleFixture(service) };
}
