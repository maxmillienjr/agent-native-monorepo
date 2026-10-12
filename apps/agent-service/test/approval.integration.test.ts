import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { AppModule } from '../src/app.module.js';
import { CHECKPOINTER } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';
import { selectIrreversibleFixture } from '../src/runs/pausing-fixture.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const skip = skipUnlessIntegrationEnv('approval.integration.test.ts', 'DATABASE_URL', 'NEO4J_URI');

/**
 * Model `stub`, memory `live`: the service `MemoryModule` wires, with the
 * `PostgresSaver` it builds, and an irreversible fixture the model always
 * selects. What a resume would read has to be in Postgres, not in a
 * `MemorySaver` that dies with the process.
 */
describe.skipIf(skip)('a run paused for approval, on the PostgresSaver', () => {
  let context: INestApplicationContext;
  const apiKey = process.env['GOOGLE_API_KEY'];

  beforeAll(async () => {
    delete process.env['GOOGLE_API_KEY'];
    context = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });
  });

  afterAll(async () => {
    await context?.close();
    if (apiKey !== undefined) process.env['GOOGLE_API_KEY'] = apiKey;
  });

  it('returns awaiting-approval, and the checkpoint under the runId holds the pending call', async () => {
    const service = context.get(RunsService);
    const executed = selectIrreversibleFixture(service);

    const response = await service.execute({
      body: {
        sessionId: '550e8400-e29b-41d4-a716-4466554400c0',
        messages: [{ role: 'user', content: 'Tell the member about the case.' }],
      },
      correlationId: 'integration-approval',
    });

    expect(response.outcome).toBe('awaiting-approval');
    expect(executed()).toBe(0);

    const saver = context.get<BaseCheckpointSaver>(CHECKPOINTER);
    expect(saver.constructor.name).toBe('PostgresSaver');
    const tuple = await saver.getTuple({ configurable: { thread_id: response.runId } });
    expect(tuple?.config.configurable?.['thread_id']).toBe(response.runId);
    expect(tuple?.checkpoint.channel_values['pendingApproval']).toMatchObject({
      toolName: 'notify-member',
      tier: 'irreversible',
      idempotencyKey: `${response.runId}:0`,
    });
  });
});
